/* CC AGI Installer — client-side controller */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const screens = {
    menu:    $("screen-menu"),
    install: $("screen-install"),
    project: $("screen-project"),
    run:     $("screen-run"),
  };

  const el = {
    versionBadge: $("version-badge"),
    cwdNote:      $("cwd-note"),
    footerCwd:    $("footer-cwd"),
    installForm:  $("install-form"),
    licenseKey:   $("license-key"),
    email:        $("email"),
    projectForm:  $("project-form"),
    projectName:  $("project-name"),
    projectCwd:   $("project-cwd"),
    runKind:      $("run-kind"),
    runStatus:    $("run-status"),
    runId:        $("run-id"),
    runLog:       $("run-log"),
  };

  const PROJECT_NAME_RE = /^[A-Za-z0-9_-]+$/;
  let currentCwd = "";

  let currentRunId = null;
  let pollTimer = null;

  const KIND_LABELS = {
    "install":        "CC AGI インストール",
    "create-project": "CC AGI プロジェクト作成",
  };

  function showScreen(name) {
    for (const [key, node] of Object.entries(screens)) {
      if (key === name) node.removeAttribute("hidden");
      else node.setAttribute("hidden", "");
    }
  }

  function setStatus(status) {
    el.runStatus.textContent = status;
    el.runStatus.dataset.status = status;
  }

  async function fetchVersion() {
    try {
      const r = await fetch("/api/version");
      if (!r.ok) return;
      const data = await r.json();
      el.versionBadge.textContent = "v" + data.version;
      el.cwdNote.textContent = data.cwd;
      el.footerCwd.textContent = data.cwd;
      el.projectCwd.textContent = data.cwd;
      currentCwd = data.cwd;
      if (!data.install_script_exists) {
        el.cwdNote.textContent += "  (install.sh が見つかりません)";
      }
    } catch (err) {
      console.warn("version fetch failed", err);
    }
  }

  async function postJSON(url, body) {
    let r;
    try {
      r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });
    } catch (netErr) {
      // fetch そのものが失敗 = サーバ到達不能 (プロセス終了 / Terminal 閉鎖 / 再起動中)
      // ブラウザの生の "Failed to fetch" を人間可読な復旧手順に置換する。
      throw new Error(
        "サーバに接続できません。「CC AGI インストーラー」と表示されている " +
        "Terminal ウインドウが閉じていないか確認してください。閉じてしまった場合は " +
        "CC_AGI_Installer.command を再度ダブルクリックして起動し直してください。"
      );
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = data.error || `HTTP ${r.status}`;
      throw new Error(msg);
    }
    return data;
  }

  // 軽量ヘルスチェック: サーバの生死を判定 (10 秒間隔)。
  // サーバが死んでいると分かった時点で UI にバナーを出し、ユーザに次の行動を伝える。
  async function healthCheck() {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      return r.ok;
    } catch (_e) {
      return false;
    }
  }

  function showServerDownBanner() {
    if (document.getElementById("server-down-banner")) return;
    const banner = document.createElement("div");
    banner.id = "server-down-banner";
    banner.setAttribute("role", "alert");
    banner.textContent =
      "⚠️ サーバとの接続が切れました。CC_AGI_Installer.command のTerminalが" +
      "閉じていないか確認してください。閉じていた場合は再度ダブルクリックして起動し直してください。";
    Object.assign(banner.style, {
      position: "fixed",
      top: "0",
      left: "0",
      right: "0",
      padding: "12px 16px",
      background: "#b91c1c",
      color: "#fff",
      fontWeight: "600",
      textAlign: "center",
      zIndex: "9999",
      boxShadow: "0 2px 6px rgba(0,0,0,0.2)",
    });
    document.body.appendChild(banner);
  }

  function hideServerDownBanner() {
    const el = document.getElementById("server-down-banner");
    if (el) el.remove();
  }

  async function tickHealth() {
    const alive = await healthCheck();
    if (alive) hideServerDownBanner();
    else showServerDownBanner();
  }
  setInterval(tickHealth, 10000);

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startPolling(runId) {
    stopPolling();
    currentRunId = runId;

    let lastLen = 0;
    async function tick() {
      try {
        const r = await fetch(`/api/log/${runId}`);
        if (!r.ok) return;
        const data = await r.json();
        setStatus(data.status);
        if (typeof data.content === "string") {
          if (data.content.length !== lastLen) {
            el.runLog.textContent = data.content;
            lastLen = data.content.length;
            el.runLog.scrollTop = el.runLog.scrollHeight;
          }
        }
        if (data.status === "finished" || data.status === "failed") {
          stopPolling();
        }
      } catch (err) {
        console.warn("poll failed", err);
      }
    }
    tick();
    pollTimer = setInterval(tick, 700);
  }

  async function launchInstall(licenseKey, email) {
    const data = await postJSON("/api/install", {
      license_key: licenseKey,
      email: email,
    });
    el.runKind.textContent = KIND_LABELS.install;
    el.runId.textContent = data.run_id;
    el.runLog.textContent = "起動しました…";
    setStatus("starting");
    showScreen("run");
    startPolling(data.run_id);
  }

  async function launchCreateProject(projectName) {
    const data = await postJSON("/api/create-project", { project_name: projectName });
    el.runKind.textContent = KIND_LABELS["create-project"];
    el.runId.textContent = data.run_id;
    el.runLog.textContent = "起動しました…";
    setStatus("starting");
    showScreen("run");
    if (data.project_root) {
      currentCwd = data.project_root;
      el.footerCwd.textContent = data.project_root;
      el.cwdNote.textContent = data.project_root;
      el.projectCwd.textContent = data.project_root;
    }
    startPolling(data.run_id);
  }

  // --- Event wiring ---

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;

    if (action === "open-install") {
      showScreen("install");
      el.licenseKey.focus();
      return;
    }
    if (action === "open-project") {
      showScreen("project");
      el.projectCwd.textContent = currentCwd;
      el.projectName.focus();
      return;
    }
    if (action === "back") {
      stopPolling();
      showScreen("menu");
      return;
    }
  });

  el.projectForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const projectName = el.projectName.value.trim();
    if (!projectName) return;
    if (!PROJECT_NAME_RE.test(projectName)) {
      alert("プロジェクト名は半角英数字・ハイフン(-)・アンダースコア(_)のみで入力してください");
      return;
    }
    launchCreateProject(projectName)
      .catch((err) => alert("起動に失敗しました: " + err.message));
  });

  el.installForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const licenseKey = el.licenseKey.value.trim();
    const email = el.email.value.trim();
    if (!licenseKey || !email) return;
    launchInstall(licenseKey, email)
      .catch((err) => alert("起動に失敗しました: " + err.message));
  });

  fetchVersion();
  showScreen("menu");
})();
