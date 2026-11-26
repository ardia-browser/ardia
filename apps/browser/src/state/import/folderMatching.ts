export type FolderEdge = { source: number; candidate: number; shared: number };

const CARDINALITY_FIRST = 1_000_000;
const EXACT_WORK_LIMIT = 4_000_000;

function bestPairs(rows: number[], cols: number[], edges: FolderEdge[]): [number, number][] {
  const rowAt = new Map(rows.map((r, i) => [r, i + 1]));
  const colAt = new Map(cols.map((c, i) => [c, rows.length + i + 1]));
  const sink = rows.length + cols.length + 1;
  const head = new Array<number>(sink + 1).fill(-1);
  const to: number[] = [];
  const cap: number[] = [];
  const cost: number[] = [];
  const next: number[] = [];
  const link = (a: number, b: number, c: number) => {
    for (const [x, y, k, w] of [
      [a, b, 1, c],
      [b, a, 0, -c],
    ] as const) {
      to.push(y);
      cap.push(k);
      cost.push(w);
      next.push(head[x]!);
      head[x] = to.length - 1;
    }
  };
  for (const r of rows) link(0, rowAt.get(r)!, 0);
  for (const e of edges) link(rowAt.get(e.source)!, colAt.get(e.candidate)!, -(CARDINALITY_FIRST + e.shared));
  for (const c of cols) link(colAt.get(c)!, sink, 0);
  const distance = new Array<number>(sink + 1);
  const via = new Array<number>(sink + 1);
  const queued = new Array<boolean>(sink + 1);
  for (;;) {
    distance.fill(Infinity);
    via.fill(-1);
    queued.fill(false);
    distance[0] = 0;
    const queue = [0];
    queued[0] = true;
    for (let at = 0; at < queue.length; at++) {
      const x = queue[at]!;
      queued[x] = false;
      for (let e = head[x]!; e !== -1; e = next[e]!) {
        const y = to[e]!;
        if (!cap[e] || distance[x]! + cost[e]! >= distance[y]!) continue;
        distance[y] = distance[x]! + cost[e]!;
        via[y] = e;
        if (!queued[y]) {
          queued[y] = true;
          queue.push(y);
        }
      }
    }
    if (distance[sink] === Infinity || distance[sink]! >= 0) break;
    for (let y = sink; y !== 0; y = to[via[y]! ^ 1]!) {
      cap[via[y]!] = cap[via[y]!]! - 1;
      cap[via[y]! ^ 1] = cap[via[y]! ^ 1]! + 1;
    }
  }
  const out: [number, number][] = [];
  for (const r of rows)
    for (let e = head[rowAt.get(r)!]!; e !== -1; e = next[e]!) {
      const y = to[e]!;
      if (y > rows.length && y < sink && !cap[e] && e % 2 === 0) out.push([r, cols[y - rows.length - 1]!]);
    }
  return out;
}

function greedyPairs(edges: FolderEdge[]): [number, number][] {
  const sorted = [...edges].sort((a, z) => z.shared - a.shared || a.source - z.source || a.candidate - z.candidate);
  const sources = new Set<number>();
  const candidates = new Set<number>();
  const out: [number, number][] = [];
  for (const e of sorted) {
    if (sources.has(e.source) || candidates.has(e.candidate)) continue;
    sources.add(e.source);
    candidates.add(e.candidate);
    out.push([e.source, e.candidate]);
  }
  return out;
}

function mostPairs(rows: number[], cols: number[], edges: FolderEdge[]): [number, number][] {
  const rowAt = new Map(rows.map((r, i) => [r, i]));
  const colAt = new Map(cols.map((c, i) => [c, i]));
  const adjacent: number[][] = rows.map(() => []);
  for (const e of [...edges].sort((a, z) => z.shared - a.shared || a.candidate - z.candidate)) adjacent[rowAt.get(e.source)!]!.push(colAt.get(e.candidate)!);
  const rowPair = new Array<number>(rows.length).fill(-1);
  const colPair = new Array<number>(cols.length).fill(-1);
  for (const [source, candidate] of greedyPairs(edges)) {
    rowPair[rowAt.get(source)!] = colAt.get(candidate)!;
    colPair[colAt.get(candidate)!] = rowAt.get(source)!;
  }
  const depth = new Array<number>(rows.length);
  const cursor = new Array<number>(rows.length);
  const layer = () => {
    const queue: number[] = [];
    for (let r = 0; r < rows.length; r++) {
      depth[r] = rowPair[r] === -1 ? 0 : Infinity;
      if (rowPair[r] === -1) queue.push(r);
    }
    let open = false;
    for (let at = 0; at < queue.length; at++) {
      const r = queue[at]!;
      for (const c of adjacent[r]!) {
        const owner = colPair[c]!;
        if (owner === -1) open = true;
        else if (depth[owner] === Infinity) {
          depth[owner] = depth[r]! + 1;
          queue.push(owner);
        }
      }
    }
    return open;
  };
  const augment = (start: number) => {
    const stack = [start];
    while (stack.length) {
      const r = stack[stack.length - 1]!;
      const c = adjacent[r]![cursor[r]!];
      if (c === undefined) {
        depth[r] = Infinity;
        stack.pop();
        continue;
      }
      const owner = colPair[c]!;
      if (owner === -1) {
        for (const x of stack) {
          const y = adjacent[x]![cursor[x]!]!;
          rowPair[x] = y;
          colPair[y] = x;
        }
        return;
      }
      if (depth[owner] === depth[r]! + 1) stack.push(owner);
      else cursor[r] = cursor[r]! + 1;
    }
  };
  while (layer()) {
    cursor.fill(0);
    for (let r = 0; r < rows.length; r++) if (rowPair[r] === -1) augment(r);
  }
  return rowPair.flatMap((c, r) => (c === -1 ? [] : [[rows[r]!, cols[c]!] as [number, number]]));
}

export function pairFolders(sourceCount: number, candidateCount: number, edges: FolderEdge[], positional: readonly boolean[] = []): number[] {
  const parent = Array.from({ length: sourceCount + candidateCount }, (_, i) => i);
  const root = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]!]!;
    return x;
  };
  for (const e of edges) parent[root(e.source)] = root(sourceCount + e.candidate);
  const groups = new Map<number, FolderEdge[]>();
  for (const e of edges) {
    const key = root(e.source);
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }
  const paired = new Array<number>(sourceCount).fill(-1);
  for (const group of groups.values()) {
    const rows = [...new Set(group.map((e) => e.source))].sort((a, z) => a - z);
    const cols = [...new Set(group.map((e) => e.candidate))].sort((a, z) => a - z);
    const exact = Math.min(rows.length, cols.length) * (rows.length + cols.length + group.length) <= EXACT_WORK_LIMIT;
    for (const [source, candidate] of exact ? bestPairs(rows, cols, group) : mostPairs(rows, cols, group)) paired[source] = candidate;
  }
  const taken = new Set(paired.filter((c) => c >= 0));
  let next = 0;
  for (let s = 0; s < sourceCount; s++) {
    if (paired[s]! >= 0) continue;
    while (next < candidateCount && (taken.has(next) || positional[next] === false)) next++;
    if (next >= candidateCount) break;
    paired[s] = next;
    taken.add(next);
  }
  return paired;
}
