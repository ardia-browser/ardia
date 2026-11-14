const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const decodeHtml = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });

export const piecesHtml = (pieces: string[]) => pieces.map((piece, i) => `<span data-p="${i}">${escapeHtml(piece)}</span>`).join("");

type Run = { piece: number | null; text: string };

const TAG = /<span data-p="(\d+)">|<\/span>|<[^>]*>/g;

export function taggedRuns(html: string): Run[] {
  const runs: Run[] = [];
  const open: (number | null)[] = [];
  let last = 0;
  const push = (end: number) => {
    if (end > last) runs.push({ piece: open.length ? (open[open.length - 1] ?? null) : null, text: decodeHtml(html.slice(last, end)) });
  };
  for (const match of html.matchAll(TAG)) {
    push(match.index);
    last = match.index + match[0].length;
    if (match[1] !== undefined) open.push(Number(match[1]));
    else if (match[0] === "</span>") open.pop();
  }
  push(html.length);
  return runs;
}

function wordRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  let lead = "";
  for (const run of runs) {
    if (!run.text.trim()) {
      if (out.length) out[out.length - 1]!.text += run.text;
      else lead += run.text;
      continue;
    }
    out.push({ piece: run.piece, text: lead + run.text });
    lead = "";
  }
  if (lead && out.length) out[out.length - 1]!.text += lead;
  return out;
}

const LEADING = /^\s*/;
const TRAILING = /\s*$/;

function placeSpaces(parts: string[], originals: string[]): string[] {
  const out = [...parts];
  for (let j = 0; j + 1 < out.length; j++) {
    const trail = TRAILING.exec(out[j]!)![0];
    const lead = LEADING.exec(out[j + 1]!)![0];
    if (!trail && !lead) continue;
    const space = trail + lead;
    out[j] = out[j]!.slice(0, out[j]!.length - trail.length);
    out[j + 1] = out[j + 1]!.slice(lead.length);
    if (!/\s$/.test(originals[j]!) && /^\s/.test(originals[j + 1]!)) out[j + 1] = space + out[j + 1];
    else out[j] += space;
  }
  return out;
}

export function alignedParts(html: string, originals: string[]): string[] | null {
  const count = originals.length;
  const runs = wordRuns(taggedRuns(html));
  const m = runs.length;
  if (count <= 0 || m < count) return null;
  const weight = runs.map((run) => run.text.replace(/\s/g, "").length);
  const score = (k: number, j: number) => (runs[k]!.piece === j ? weight[k]! : 0);
  const best: number[][] = Array.from({ length: m }, () => new Array<number>(count).fill(-Infinity));
  const stepped: boolean[][] = Array.from({ length: m }, () => new Array<boolean>(count).fill(false));
  best[0]![0] = score(0, 0);
  for (let k = 1; k < m; k++) {
    for (let j = 0; j < count && j <= k; j++) {
      const stay = best[k - 1]![j]!;
      const step = j > 0 ? best[k - 1]![j - 1]! : -Infinity;
      if (stay === -Infinity && step === -Infinity) continue;
      stepped[k]![j] = step > stay;
      best[k]![j] = Math.max(stay, step) + score(k, j);
    }
  }
  if (best[m - 1]![count - 1] === -Infinity) return null;
  const parts = new Array<string>(count).fill("");
  for (let k = m - 1, j = count - 1; k >= 0; k--) {
    parts[j] = runs[k]!.text + parts[j];
    if (stepped[k]![j]) j--;
  }
  return parts.some((part) => !part.trim()) ? null : placeSpaces(parts, originals);
}
