/**
 * 区切り文字つきテキストの読み取り。
 *
 * 国税庁の全件データは 1 ファイルで数百万行あるため、全体をメモリに載せず
 * 流し読みする。引用符の中に改行が入る場合 (所在地欄で起こりうる) にも対応する。
 */

/** 1 レコード分の文字列を項目に分解する。RFC 4180 の引用規則に従う。 */
export function splitRecord(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/** 引用符が閉じているか。奇数個なら次の行に続いている。 */
function hasUnbalancedQuotes(s: string): boolean {
  let count = 0;
  let idx = s.indexOf('"');
  while (idx !== -1) {
    count++;
    idx = s.indexOf('"', idx + 1);
  }
  return count % 2 === 1;
}

/**
 * 文字列の断片の流れを、レコード (項目の配列) の流れに変換する。
 *
 * @param chunks 復号済みの文字列断片。Readable を setEncoding('utf8') したもの等
 */
export async function* readRecords(
  chunks: AsyncIterable<string>,
): AsyncGenerator<string[], void, void> {
  let buffer = '';
  let pending = ''; // 引用符が閉じていない途中のレコード
  let first = true;

  for await (const chunk of chunks) {
    buffer += chunk;
    if (first) {
      if (buffer.charCodeAt(0) === 0xfeff) buffer = buffer.slice(1); // BOM
      first = false;
    }

    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);

      const candidate = pending === '' ? line : pending + '\n' + line;
      if (hasUnbalancedQuotes(candidate)) {
        pending = candidate; // 引用符の中の改行。次の行と繋ぐ
        continue;
      }
      pending = '';
      if (candidate.length > 0) yield splitRecord(candidate);
    }
  }

  const tail = pending === '' ? buffer : pending + '\n' + buffer;
  if (tail.trim().length > 0) yield splitRecord(tail);
}
