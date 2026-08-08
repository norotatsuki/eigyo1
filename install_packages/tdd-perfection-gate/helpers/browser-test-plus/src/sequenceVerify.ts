// sequenceVerify — UC md mermaid arrow ↔ test assertion 1:1 mapping helper
// bash script (ccagi-verify-uc-coverage.sh) と同等の内容を TypeScript で提供。

import { readFile } from 'node:fs/promises';

export type SequenceCoverage = {
  ucName: string;
  arrows: number;
  assertions: number;
  ratio: number;              // 0.0-1.0+
  verdict: 'FULL-COVERAGE' | 'PARTIAL-COVERAGE' | 'NO-MERMAID';
  suspiciousSymbols: string[];
};

export async function sequenceVerify(opts: {
  ucMdPath: string;
  testFilePaths: string[];
}): Promise<SequenceCoverage> {
  const ucContent = await readFile(opts.ucMdPath, 'utf8');
  const arrows = countMermaidArrows(ucContent);
  const suspicious = detectSuspiciousSymbols(ucContent);

  let assertions = 0;
  for (const testFile of opts.testFilePaths) {
    const content = await readFile(testFile, 'utf8');
    assertions += countAssertions(content);
  }

  const ucName = opts.ucMdPath.split('/').pop()?.replace(/\.md$/, '') ?? opts.ucMdPath;
  let ratio: number;
  let verdict: SequenceCoverage['verdict'];
  if (arrows === 0) {
    ratio = 0;
    verdict = 'NO-MERMAID';
  } else {
    ratio = assertions / arrows;
    verdict = ratio >= 1.0 ? 'FULL-COVERAGE' : 'PARTIAL-COVERAGE';
  }

  return {
    ucName,
    arrows,
    assertions,
    ratio,
    verdict,
    suspiciousSymbols: suspicious,
  };
}

function countMermaidArrows(content: string): number {
  const blocks = content.match(/```mermaid\n[\s\S]*?\n```/g) ?? [];
  let total = 0;
  for (const block of blocks) {
    if (!block.includes('sequenceDiagram')) continue;
    const lines = block.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('%%')) continue;
      if (/-{1,2}[>x]{1,2}/.test(trimmed)) total++;
    }
  }
  return total;
}

function countAssertions(content: string): number {
  const patterns = [
    /\bexpect\b/g,
    /\bassert(Equal|True|False|Match|Contain)?\b/g,
    /\btoBe[A-Z]\w*/g,
    /\btoHave[A-Z]\w*/g,
    /\btoEqual\b/g,
    /\btoMatch\b/g,
    /\btoContain\b/g,
    /\bshould\./g,
  ];
  let count = 0;
  for (const p of patterns) {
    const matches = content.match(p);
    if (matches) count += matches.length;
  }
  return count;
}

function detectSuspiciousSymbols(content: string): string[] {
  const patterns = [
    /\bF[0-9]{1,2}\b/g,      // F1-F99: Claude 発明の可能性 (no-invented-symbols.md)
    /\bS[0-9]{2}-[A-Z]\b/g,  // S07-C 等: SoT 由来か Claude 発明かを要確認
  ];
  const found = new Set<string>();
  for (const p of patterns) {
    const matches = content.match(p);
    if (matches) matches.forEach((m) => found.add(m));
  }
  return Array.from(found).sort();
}
