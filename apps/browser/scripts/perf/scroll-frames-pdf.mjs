import { spawnSync } from "node:child_process";
import { devtools, sleep } from "../../../../scripts/lib/instance.mjs";
import { DRAW, eventTimes, frameRates } from "./frame-rates.mjs";

const PDF_VIEWER = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/";
const TAIL_GAP_MS = 100;
const TAIL_MAX_MS = 1000;

function pageContent(index) {
  const hue = (index * 37) % 360;
  const shade = (offset, lightness) => {
    const c = (1 - Math.abs(2 * lightness - 1)) * 0.6;
    const h = ((hue + offset) % 360) / 60;
    const x = c * (1 - Math.abs((h % 2) - 1));
    const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h) % 6];
    const m = lightness - c / 2;
    return [r + m, g + m, b + m].map((v) => v.toFixed(3)).join(" ");
  };
  const bands = Array.from({ length: 24 }, (_, i) => `${shade(i * 6, 0.62)} rg 72 ${96 + i * 6} 468 6 re f`).join("\n");
  const text = Array.from({ length: 36 }, (_, i) =>
    `BT /F1 11 Tf 72 ${700 - i * 16} Td (Page ${index + 1} line ${i + 1}: Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.) Tj ET`).join("\n");
  return `${shade(0, 0.93)} rg 0 0 612 792 re f\n${bands}\n0 g\nBT /F1 28 Tf 72 740 Td (Page ${index + 1}) Tj ET\n${text}`;
}

export function pdfDocument(pageCount = 300) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pageCount} /Kids [${Array.from({ length: pageCount }, (_, i) => `${4 + 2 * i} 0 R`).join(" ")}] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let i = 0; i < pageCount; i++) {
    const content = pageContent(i);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

let document = null;
export function servePdf(res) {
  document ??= pdfDocument();
  res.writeHead(200, { "content-type": "application/pdf", "content-length": document.length, "cache-control": "no-store" });
  res.end(document);
}

export function frameOrigin(url) {
  if (!URL.canParse(url)) return "unparsable";
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

export function pdfFrameTargets(list, pageUrl) {
  const page = list.find((t) => t.type === "page" && t.url === pageUrl);
  const viewer = page && list.find((t) => t.type === "iframe" && t.parentId === page.id && t.url.startsWith(PDF_VIEWER));
  const content = viewer && list.find((t) => t.type === "iframe" && t.parentId === viewer.id);
  return { viewer, content, seen: list.map((t) => ({ type: t.type, origin: frameOrigin(t.url), hasParent: !!t.parentId })) };
}

export async function pdfRep({ inst, pageUrl, r, postscroll }) {
  let frames = pdfFrameTargets(await inst.targets(), pageUrl);
  for (const end = Date.now() + 15000; !(frames.viewer && frames.content) && Date.now() < end; await sleep(150)) frames = pdfFrameTargets(await inst.targets(), pageUrl);
  if (!frames.viewer) return { error: `no PDF viewer frame under the page among the targets: ${JSON.stringify(frames.seen)}` };
  const prefix = `scroll-frames-pdf-${r}`;
  const rep = { start: `${prefix}-start`, end: `${prefix}-end`, frames: [{ role: "viewer", mark: `${prefix}-start`, origin: frameOrigin(frames.viewer.url) }] };
  let viewer = null;
  let content = null;
  try {
    viewer = await devtools(frames.viewer);
    content = frames.content ? await devtools(frames.content) : null;
    const mark = (conn, name) => conn.eval(`(performance.mark(${JSON.stringify(name)}), performance.now())`);
    await sleep(2000);
    if (content) {
      await mark(content, `${prefix}-content`);
      rep.frames.push({ role: "content", mark: `${prefix}-content`, origin: frameOrigin(frames.content.url) });
    } else rep.frames.push({ role: "content", error: `the PDF viewer has no content frame of its own among the targets: ${JSON.stringify(frames.seen)}` });
    await mark(viewer, rep.start);
    const p = spawnSync(postscroll.acperf, postscroll.args, { encoding: "utf8", timeout: 20000 });
    if (p.status !== 0) throw new Error(`acperf postscroll: ${p.stderr}`);
    await mark(viewer, rep.end);
    await sleep(900);
    return rep;
  } catch (error) {
    return { error: `the PDF gesture failed: ${error?.message ?? error}` };
  } finally {
    viewer?.close();
    content?.close();
  }
}

export function scrollTailEnd(events, pids, endTs) {
  const draws = pids.flatMap((pid) => eventTimes(events, pid, DRAW, endTs, endTs + TAIL_MAX_MS * 1000)).sort((a, b) => a - b);
  let last = endTs / 1000;
  for (const at of draws) {
    if (at - last > TAIL_GAP_MS) break;
    last = at;
  }
  return last * 1000;
}

export function pdfRates(events, rep, refreshMs) {
  if (rep.error) return [{ error: rep.error }];
  const markOf = (name) => events.find((e) => e.name === name);
  const start = markOf(rep.start);
  const end = markOf(rep.end);
  if (!start || !end) return [{ role: "viewer", error: `the ${start ? "end" : "start"} mark is missing from the trace` }];
  const marked = rep.frames.map((f) => ({ ...f, pid: f.error ? undefined : markOf(f.mark)?.pid }));
  const t0 = start.ts;
  const tail = scrollTailEnd(events, marked.flatMap((f) => (f.pid === undefined ? [] : [f.pid])), end.ts);
  const t1 = tail + 30000;
  const ms = Math.round((end.ts - start.ts) / 1000);
  const tailMs = Math.round((tail - end.ts) / 1000);
  const rows = marked.map(({ role, origin, error, pid }) => {
    if (error) return { role, origin, error };
    if (pid === undefined) return { role, origin, error: `the ${role} mark is missing from the trace` };
    return { role, origin, pid, ms, tailMs, ...frameRates(events, pid, t0, t1, refreshMs) };
  });
  const named = new Set(rows.map((r) => r.pid));
  const drawing = events.filter((e) => e.ts >= t0 && e.ts <= t1 && e.name === DRAW && ["X", "B"].includes(e.ph)).map((e) => e.pid);
  const others = [...new Set(drawing)].filter((pid) => !named.has(pid)).sort((a, b) => a - b);
  return [...rows, ...others.map((pid) => ({ role: "other", pid, ms, tailMs, ...frameRates(events, pid, t0, t1, refreshMs) }))];
}
