#!/usr/bin/env python3
"""CC AGI Installer local HTTP server.

Serves the installer GUI and executes the create-project pipeline
in the project working directory. Post-bootstrap chain (guaranteed order):
  1. scripts/ccagi-bootstrap.sh
  2. info-public-guard/install.sh           (external-disclosure ban rule)
  3. ccagi-protocol-gate/gate_install.sh    (STEP 1-5 protocol gate)
Output is written to per-run log files so the browser can poll them without
holding a long-running HTTP connection.
"""

from __future__ import annotations

import http.server
import json
import os
import re
import shlex
import shutil
import socket
import socketserver
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

PROJECT_NAME_RE = re.compile(r'^[A-Za-z0-9_-]+$')

VERSION = "20260712"

BASE_DIR = Path(__file__).resolve().parent            # <project>/install_packages/installer
INSTALL_PACKAGES_DIR = BASE_DIR.parent                # <project>/install_packages
PROJECT_ROOT = INSTALL_PACKAGES_DIR.parent            # <project>  (workspace root — _rename_project_root の対象)
STATIC_DIR = BASE_DIR / "static"
LOG_DIR = BASE_DIR / "runs"
LOG_DIR.mkdir(parents=True, exist_ok=True)

INSTALL_SCRIPT = INSTALL_PACKAGES_DIR / "install.sh"
BOOTSTRAP_SCRIPT = INSTALL_PACKAGES_DIR / "scripts" / "ccagi-bootstrap.sh"
# _rename_project_root で workspace root を変える際、install_packages/ 配下も追随させるための basename
INSTALL_PACKAGES_BASENAME = INSTALL_PACKAGES_DIR.name

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".js":   "application/javascript; charset=utf-8",
    ".svg":  "image/svg+xml",
    ".png":  "image/png",
    ".ico":  "image/x-icon",
    ".json": "application/json; charset=utf-8",
}


class RunRegistry:
    """Tracks running/finished subprocesses by run_id."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._runs: dict[str, dict] = {}

    def create(self, kind: str, cmd: list[str]) -> dict:
        run_id = uuid.uuid4().hex[:12]
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        run_dir = LOG_DIR / f"{ts}_{kind}_{run_id}"
        run_dir.mkdir(parents=True, exist_ok=True)
        log_path = run_dir / "output.log"
        meta = {
            "run_id": run_id,
            "kind": kind,
            "cmd": cmd,
            "started_at": ts,
            "log_path": str(log_path),
            "status": "starting",
            "exit_code": None,
            "process": None,
        }
        with self._lock:
            self._runs[run_id] = meta
        return meta

    def get(self, run_id: str) -> dict | None:
        with self._lock:
            return self._runs.get(run_id)

    def set_status(self, run_id: str, status: str, exit_code: int | None = None) -> None:
        with self._lock:
            run = self._runs.get(run_id)
            if run is None:
                return
            run["status"] = status
            if exit_code is not None:
                run["exit_code"] = exit_code


REGISTRY = RunRegistry()

# _rename_project_root() は複数の POST が並列に飛んだ場合の競合を防ぐ必要が
# ある (ThreadingMixIn による並列 handler)。同時 rename が走ると片方が
# 存在しないパスに対して os.rename を呼び、OSError で 500 応答→ browser 上は
# 「Failed to fetch」相当の混乱を招くため、単一の Lock で直列化する。
_RENAME_LOCK = threading.Lock()


def _rename_project_root(project_name: str) -> tuple[bool, dict | None]:
    """Rename PROJECT_ROOT to <parent>/project_name.

    Returns (renamed, error_dict). error_dict is None on success (including
    the no-op case where the current directory name already matches).
    """
    global PROJECT_ROOT, INSTALL_PACKAGES_DIR, BASE_DIR, STATIC_DIR, LOG_DIR, INSTALL_SCRIPT, BOOTSTRAP_SCRIPT
    if not PROJECT_NAME_RE.match(project_name):
        return False, {"error": "プロジェクト名は半角英数字・ハイフン(-)・アンダースコア(_)のみで入力してください"}
    with _RENAME_LOCK:
        parent = PROJECT_ROOT.parent
        new_root = parent / project_name
        # PROJECT_ROOT がすでに指定名なら no-op 扱いで続行 (renamed=False, err=None)
        try:
            same = new_root.resolve() == PROJECT_ROOT.resolve()
        except OSError:
            same = str(new_root) == str(PROJECT_ROOT)
        if same:
            return False, None
        if new_root.exists():
            return False, {"error": f"同名ディレクトリが既に存在します: {new_root}"}
        try:
            os.rename(str(PROJECT_ROOT), str(new_root))
        except OSError as exc:
            return False, {"error": f"ディレクトリ名変更に失敗: {exc}"}
        PROJECT_ROOT = new_root
        INSTALL_PACKAGES_DIR = new_root / INSTALL_PACKAGES_BASENAME
        BASE_DIR = INSTALL_PACKAGES_DIR / "installer"
        STATIC_DIR = BASE_DIR / "static"
        LOG_DIR = BASE_DIR / "runs"
        try:
            LOG_DIR.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            # rename 直後に LOG_DIR が作れない場合はもう戻せないので警告のみ
            sys.stderr.write(f"[warn] LOG_DIR mkdir failed after rename: {exc}\n")
        INSTALL_SCRIPT = INSTALL_PACKAGES_DIR / "install.sh"
        BOOTSTRAP_SCRIPT = INSTALL_PACKAGES_DIR / "scripts" / "ccagi-bootstrap.sh"
        return True, None


VSCODE_APP = Path("/Applications/Visual Studio Code.app")
VSCODE_CODE_BIN = VSCODE_APP / "Contents/Resources/app/bin/code"

CLAUDE_ARGS = "--dangerously-skip-permissions --model='claude-opus-4-7[1m]'"


def _resolve_claude_cmd() -> str:
    """VS Code タスクに書き込む claude 起動コマンド文字列を生成する。

    背景: `/bin/zsh -l -c 'claude ...'` を VS Code integrated terminal から起動すると、
    Terminal.app 経由の login shell と PATH 継承が異なり `command not found: claude` で
    rc=127 になる事象が発生 (2026-07-15 実測)。server.py は Terminal.app 経由の
    CC_AGI_Installer.command から spawn されているため PATH に claude が入っており、
    ここで shutil.which による絶対パス解決が可能。それを tasks.json に書き込むことで
    VS Code 側 shell の PATH に依存せず確実に起動できる。
    """
    resolved = shutil.which("claude")
    if resolved:
        return f"{shlex.quote(resolved)} {CLAUDE_ARGS}"
    # フォールバック: which に失敗した場合は zshrc を明示 source してから実行
    # (claude が別の場所にインストールされて PATH が zshrc 経由でしか追加されないケース)
    return (
        "[ -f ~/.zprofile ] && source ~/.zprofile 2>/dev/null; "
        "[ -f ~/.zshrc ] && source ~/.zshrc 2>/dev/null; "
        f"exec claude {CLAUDE_ARGS}"
    )


CLAUDE_CMD = _resolve_claude_cmd()

VSCODE_TASKS_JSON = {
    "version": "2.0.0",
    "tasks": [
        {
            "label": "CC AGI: launch claude",
            "type": "shell",
            "command": CLAUDE_CMD,
            "options": {
                "shell": {
                    "executable": "/bin/zsh",
                    # -l: login shell (PATH に claude を含む init を読む)
                    # -c: 次の文字列を script file ではなくコマンドとして実行
                    #     (欠落すると zsh が command 文字列を file と誤認し rc=127 で失敗)
                    "args": ["-l", "-c"],
                }
            },
            "presentation": {
                "reveal": "always",
                "panel": "new",
                "focus": True,
                "clear": True,
            },
            "runOptions": {"runOn": "folderOpen"},
            "problemMatcher": [],
        }
    ],
}


def _write_vscode_task(project_root: Path, log_fh) -> None:
    vscode_dir = project_root / ".vscode"
    vscode_dir.mkdir(parents=True, exist_ok=True)
    tasks_file = vscode_dir / "tasks.json"
    payload = json.dumps(VSCODE_TASKS_JSON, ensure_ascii=False, indent=2) + "\n"
    if tasks_file.is_file() and tasks_file.read_text(encoding="utf-8") == payload:
        log_fh.write(f"[vscode] tasks.json is up-to-date: {tasks_file}\n")
        return
    tasks_file.write_text(payload, encoding="utf-8")
    log_fh.write(f"[vscode] wrote {tasks_file}\n")


def _launch_vscode(project_root: Path, log_fh) -> None:
    if not VSCODE_APP.is_dir():
        log_fh.write(
            f"[vscode] Visual Studio Code.app が見つかりません: {VSCODE_APP}\n"
            "         VS Code をインストール後、次のコマンドで手動起動してください:\n"
            f"         open -a \"Visual Studio Code\" \"{project_root}\"\n"
        )
        return
    try:
        subprocess.run(
            ["open", "-a", "Visual Studio Code", str(project_root)],
            check=True,
            timeout=30,
        )
        log_fh.write(f"[vscode] VS Code を起動しました: {project_root}\n")
        log_fh.write("[vscode] 統合ターミナルで自動タスクを実行します。\n")
        log_fh.write(
            "[vscode] 初回のみワークスペース信頼 (Trust) と\n"
            "         「Manage Automatic Tasks in Folder」→ Allow の許可が必要です。\n"
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        log_fh.write(f"[vscode] 起動に失敗: {exc}\n")


def _verify_name_consistency(project_root: Path, project_name: str, log_fh) -> bool:
    """プロジェクト名 = ローカルディレクトリ名 = GitHub リポジトリ名 の 3 者一致を検証。

    Returns True if consistent (or GitHub 側チェックがスキップされた場合の弱一致)。
    False は「明確な不一致」(ローカル vs 入力、または GitHub 上に同名だが別リポジトリ)。
    非致命: ログに WARN/ERROR を書くだけで例外は投げない (VS Code 起動は継続)。
    """
    local_name = project_root.name
    log_fh.write("[verify] 名前整合性チェック\n")
    log_fh.write(f"[verify]   入力 project_name  = {project_name!r}\n")
    log_fh.write(f"[verify]   ローカル dir 名     = {local_name!r}\n")

    if local_name != project_name:
        log_fh.write("[verify] ✗ 入力名とローカルディレクトリ名が一致しません\n")
        return False
    log_fh.write("[verify] ✓ 入力名 = ローカルディレクトリ名\n")

    if not shutil.which("gh"):
        log_fh.write("[verify] ⚠ gh コマンド未検出 → GitHub 側チェックをスキップ\n")
        return True

    try:
        r_user = subprocess.run(
            ["gh", "api", "user", "--jq", ".login"],
            capture_output=True, text=True, timeout=15,
        )
        if r_user.returncode != 0 or not r_user.stdout.strip():
            log_fh.write("[verify] ⚠ gh 認証未完了 → GitHub 側チェックをスキップ (gh auth login 推奨)\n")
            return True
        owner = r_user.stdout.strip()
        log_fh.write(f"[verify]   GitHub owner       = {owner!r}\n")

        r_repo = subprocess.run(
            ["gh", "repo", "view", f"{owner}/{project_name}", "--json", "name", "--jq", ".name"],
            capture_output=True, text=True, timeout=15,
        )
        if r_repo.returncode == 0:
            repo_name = r_repo.stdout.strip()
            if repo_name == project_name:
                log_fh.write(f"[verify] ✓ GitHub リポジトリ名も一致: {owner}/{repo_name}\n")
                return True
            log_fh.write(f"[verify] ✗ GitHub リポジトリ名が不一致: 期待={project_name!r} 実際={repo_name!r}\n")
            return False
        # 存在しない (404) 想定: 作成推奨だが致命ではない
        log_fh.write(
            f"[verify] ⚠ GitHub 上に {owner}/{project_name} が未作成\n"
            f"[verify]    次回作業時に `gh repo create {owner}/{project_name} --private --source=.` を推奨\n"
        )
        return True
    except subprocess.TimeoutExpired:
        log_fh.write("[verify] ⚠ gh 応答タイムアウト → チェックをスキップ\n")
        return True


def _install_info_public_guard(install_packages_dir: Path, project_root: Path, log_fh) -> bool:
    """install_packages/info-public-guard/install.sh を target=project_root で実行。

    「ユーザー明示許可なしに情報を外部公開・共有することは絶対禁止」ルールを
    CLAUDE.md に @import として組み込む。gate_install より必ず前に走らせ、
    STEP 5 検証時点で当該ルールが CLAUDE.md に含まれている状態を保証する。
    Returns True if rc==0, False otherwise. 非致命: ログのみで例外は投げない。
    """
    ipg_script = install_packages_dir / "info-public-guard" / "install.sh"
    if not ipg_script.is_file():
        log_fh.write(f"[ipg] ⚠ install.sh が見つかりません: {ipg_script}\n")
        log_fh.write("[ipg]    (配布 zip に info-public-guard/ が含まれていない可能性)\n")
        return False
    log_fh.write("[ipg] info-public-guard インストール開始\n")
    log_fh.write(f"[ipg]   script = {ipg_script}\n")
    log_fh.write(f"[ipg]   target = {project_root}\n")
    try:
        r = subprocess.run(
            ["/bin/bash", str(ipg_script), str(project_root)],
            capture_output=True, text=True, timeout=60,
        )
        for line in r.stdout.splitlines():
            log_fh.write(f"[ipg]   {line}\n")
        for line in r.stderr.splitlines():
            log_fh.write(f"[ipg]   (stderr) {line}\n")
        if r.returncode == 0:
            log_fh.write("[ipg] ✓ info-public-guard インストール完了\n")
            return True
        log_fh.write(f"[ipg] ✗ インストール失敗 (rc={r.returncode})\n")
        return False
    except subprocess.TimeoutExpired:
        log_fh.write("[ipg] ✗ タイムアウト (60s)\n")
        return False


def _install_protocol_gate(install_packages_dir: Path, project_root: Path, log_fh) -> bool:
    """install_packages/ccagi-protocol-gate/gate_install.sh を target=project_root で実行。

    ルールゲート (STEP 1-5 未完了時に tool 使用を BLOCK する構造) を新プロジェクトに適用する。
    必ず _install_info_public_guard の後に呼ぶこと (STEP 5 = CLAUDE.md 検証のため、
    info-public-guard @import が組み込まれた最終状態の CLAUDE.md を対象にする)。
    Returns True if rc==0, False otherwise. 非致命: ログのみで例外は投げない。
    """
    gate_script = install_packages_dir / "ccagi-protocol-gate" / "gate_install.sh"
    if not gate_script.is_file():
        log_fh.write(f"[gate] ⚠ gate_install.sh が見つかりません: {gate_script}\n")
        log_fh.write("[gate]    (配布 zip に ccagi-protocol-gate/ が含まれていない可能性)\n")
        return False
    log_fh.write("[gate] protocol-gate インストール開始\n")
    log_fh.write(f"[gate]   script = {gate_script}\n")
    log_fh.write(f"[gate]   target = {project_root}\n")
    try:
        r = subprocess.run(
            ["/bin/bash", str(gate_script), str(project_root)],
            capture_output=True, text=True, timeout=60,
        )
        for line in r.stdout.splitlines():
            log_fh.write(f"[gate]   {line}\n")
        for line in r.stderr.splitlines():
            log_fh.write(f"[gate]   (stderr) {line}\n")
        if r.returncode == 0:
            log_fh.write("[gate] ✓ protocol-gate インストール完了\n")
            return True
        log_fh.write(f"[gate] ✗ インストール失敗 (rc={r.returncode})\n")
        return False
    except subprocess.TimeoutExpired:
        log_fh.write("[gate] ✗ タイムアウト (60s)\n")
        return False


def _spawn(run: dict, on_success=None) -> None:
    """Run subprocess in background thread, appending output to log file.

    If on_success is given and rc==0, it is invoked with the log file handle
    still open so its messages are appended to the run log.
    """
    log_path = Path(run["log_path"])
    cmd = run["cmd"]
    run_id = run["run_id"]

    def _run() -> None:
        rule = "=" * 72
        header = (
            f"$ {' '.join(shlex.quote(c) for c in cmd)}\n"
            f"[cwd] {PROJECT_ROOT}\n"
            f"[started] {datetime.now().isoformat()}\n"
            f"{rule}\n"
        )
        with log_path.open("w", encoding="utf-8", buffering=1) as fh:
            fh.write(header)
            fh.flush()
            REGISTRY.set_status(run_id, "running")
            try:
                proc = subprocess.Popen(
                    cmd,
                    cwd=str(PROJECT_ROOT),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                    env={**os.environ, "PYTHONUNBUFFERED": "1"},
                )
            except Exception as exc:  # pragma: no cover - user-facing error path
                fh.write(f"[spawn error] {exc}\n")
                REGISTRY.set_status(run_id, "failed", exit_code=-1)
                return

            assert proc.stdout is not None
            for line in proc.stdout:
                fh.write(line)
            proc.wait()
            fh.write(f"\n{rule}\n[exit] {proc.returncode}\n")
            if proc.returncode == 0 and on_success is not None:
                fh.write(f"{rule}\n[post-hook] start\n")
                try:
                    on_success(fh)
                except Exception as exc:  # pragma: no cover - visible in log
                    fh.write(f"[post-hook error] {exc}\n")
                fh.write("[post-hook] end\n")
            REGISTRY.set_status(
                run_id,
                "finished" if proc.returncode == 0 else "failed",
                exit_code=proc.returncode,
            )

    t = threading.Thread(target=_run, daemon=True)
    t.start()


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = f"CCAGIInstaller/{VERSION}"

    # ---------- helpers ----------

    def _send_json(self, status: int, body: dict) -> None:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _send_file(self, path: Path) -> None:
        if not path.is_file():
            self._send_json(404, {"error": "not found", "path": str(path)})
            return
        ctype = CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream")
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    def log_message(self, format: str, *args) -> None:  # quieter logs
        sys.stderr.write("[server] " + (format % args) + "\n")

    # ---------- routing ----------

    def do_GET(self) -> None:  # noqa: N802
        try:
            self._route_get()
        except Exception as exc:  # never let handler drop the TCP connection
            sys.stderr.write(f"[server] unhandled GET error: {exc}\n")
            try:
                self._send_json(500, {"error": f"サーバ内部エラー: {exc}"})
            except Exception:
                pass

    def do_POST(self) -> None:  # noqa: N802
        try:
            self._route_post()
        except Exception as exc:
            sys.stderr.write(f"[server] unhandled POST error: {exc}\n")
            try:
                self._send_json(500, {"error": f"サーバ内部エラー: {exc}"})
            except Exception:
                pass

    def _route_get(self) -> None:
        parsed = urlparse(self.path)
        route = parsed.path

        if route in ("/", "/index.html"):
            self._send_file(STATIC_DIR / "index.html")
            return

        if route in ("/api/health", "/api/ping"):
            # 軽量ヘルスチェック。フロントの keepalive polling が使う。
            self._send_json(200, {"ok": True, "version": VERSION})
            return

        if route == "/api/version":
            self._send_json(200, {
                "version": VERSION,
                "cwd": str(PROJECT_ROOT),
                "install_script": str(INSTALL_SCRIPT),
                "install_script_exists": INSTALL_SCRIPT.is_file(),
                "bootstrap_script": str(BOOTSTRAP_SCRIPT),
                "bootstrap_script_exists": BOOTSTRAP_SCRIPT.is_file(),
            })
            return

        if route.startswith("/api/status/"):
            run_id = route.rsplit("/", 1)[-1]
            run = REGISTRY.get(run_id)
            if run is None:
                self._send_json(404, {"error": "unknown run_id"})
                return
            self._send_json(200, {
                "run_id": run_id,
                "kind": run["kind"],
                "status": run["status"],
                "exit_code": run["exit_code"],
                "started_at": run["started_at"],
            })
            return

        if route.startswith("/api/log/"):
            run_id = route.rsplit("/", 1)[-1]
            run = REGISTRY.get(run_id)
            if run is None:
                self._send_json(404, {"error": "unknown run_id"})
                return
            log_path = Path(run["log_path"])
            content = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
            self._send_json(200, {
                "run_id": run_id,
                "status": run["status"],
                "exit_code": run["exit_code"],
                "content": content,
            })
            return

        if route.startswith("/static/"):
            rel = route[len("/static/"):]
            self._send_file(STATIC_DIR / rel)
            return

        self._send_json(404, {"error": "not found", "route": route})

    def _route_post(self) -> None:
        parsed = urlparse(self.path)
        route = parsed.path
        body = self._read_json()

        if route == "/api/install":
            license_key = str(body.get("license_key", "")).strip()
            email = str(body.get("email", "")).strip()
            if not license_key or not email:
                self._send_json(400, {"error": "license_key と email は必須です"})
                return
            if not INSTALL_SCRIPT.is_file():
                self._send_json(500, {"error": f"install.sh が見つかりません: {INSTALL_SCRIPT}"})
                return
            cmd = ["/bin/bash", str(INSTALL_SCRIPT), license_key, email]
            run = REGISTRY.create("install", cmd)
            _spawn(run)
            self._send_json(200, {"run_id": run["run_id"], "kind": "install"})
            return

        if route == "/api/create-project":
            project_name = str(body.get("project_name", "")).strip()
            if not project_name:
                self._send_json(400, {"error": "プロジェクト名を入力してください"})
                return
            renamed, err = _rename_project_root(project_name)
            if err is not None:
                status = 400 if err["error"].startswith("プロジェクト名") \
                            or err["error"].startswith("同名") else 500
                self._send_json(status, err)
                return
            if not BOOTSTRAP_SCRIPT.is_file():
                self._send_json(500, {"error": f"scripts/ccagi-bootstrap.sh が見つかりません: {BOOTSTRAP_SCRIPT}"})
                return
            # cwd は PROJECT_ROOT (workspace root)。install_packages/ 配下の bootstrap を明示指定。
            cmd = ["/bin/bash", f"./{INSTALL_PACKAGES_BASENAME}/scripts/ccagi-bootstrap.sh", "--no-exec"]
            run = REGISTRY.create("create-project", cmd)

            # default arg で現在値を capture (post-hook 実行時は _rename_project_root
            # 後のグローバル状態を参照するため。project_name は closure 変数を直接使う)
            def _post_bootstrap(log_fh,
                                project_root=PROJECT_ROOT,
                                install_packages_dir=INSTALL_PACKAGES_DIR,
                                pname=project_name) -> None:
                # 1. プロジェクト名 = ローカルディレクトリ名 = GitHub リポジトリ名 の 3 者一致
                _verify_name_consistency(project_root, pname, log_fh)
                # 2. info-public-guard (外部公開絶対禁止ルール) 適用
                #    protocol-gate より必ず前に実行する。gate_install が有効化する STEP 5
                #    (CLAUDE.md 検証) の時点で info-public-guard @import が組込済である状態を
                #    保証するため、この順序は変更してはならない。
                _install_info_public_guard(install_packages_dir, project_root, log_fh)
                # 3. protocol-gate (STEP 1-5 ルールゲート) 適用 — 必ず #2 の後
                _install_protocol_gate(install_packages_dir, project_root, log_fh)
                # 4. VS Code タスク書出
                _write_vscode_task(project_root, log_fh)
                # 5. VS Code 起動 (Claude Code は folderOpen タスクで自動起動)
                _launch_vscode(project_root, log_fh)

            _spawn(run, on_success=_post_bootstrap)
            self._send_json(200, {
                "run_id": run["run_id"],
                "kind": "create-project",
                "project_root": str(PROJECT_ROOT),
                "renamed": renamed,
            })
            return

        self._send_json(404, {"error": "not found", "route": route})


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def _pick_port(preferred: int) -> int:
    """Try preferred port then scan a small range."""
    for port in [preferred] + list(range(preferred + 1, preferred + 20)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError("使用可能なポートが見つかりません")


def main() -> int:
    preferred = int(os.environ.get("CCAGI_INSTALLER_PORT", "17071"))
    port = _pick_port(preferred)
    server = ThreadingServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{port}/"
    sys.stderr.write("=" * 72 + "\n")
    sys.stderr.write(f"CC AGI インストーラー v{VERSION}\n")
    sys.stderr.write(f"URL:  {url}\n")
    sys.stderr.write(f"CWD:  {PROJECT_ROOT}\n")
    sys.stderr.write(f"Ctrl-C で終了します。\n")
    sys.stderr.write("=" * 72 + "\n")
    sys.stderr.flush()

    if os.environ.get("CCAGI_INSTALLER_NO_BROWSER") != "1":
        # Delay the browser open slightly so the server socket is ready.
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("\nCC AGI インストーラーを終了します。\n")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
