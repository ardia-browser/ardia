export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre = ""] = v.split(/-(.*)/s, 2);
    return { parts: core!.split(".").map(Number), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.parts[i] !== y.parts[i]) return (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  const [p, q] = [x.pre.split("."), y.pre.split(".")];
  for (let i = 0; i < Math.min(p.length, q.length); i++) {
    if (p[i] === q[i]) continue;
    const [m, n] = [/^\d+$/.test(p[i]!), /^\d+$/.test(q[i]!)];
    if (m && n) return Number(p[i]) - Number(q[i]);
    if (m !== n) return m ? -1 : 1;
    return p[i]! < q[i]! ? -1 : 1;
  }
  return p.length - q.length;
}
