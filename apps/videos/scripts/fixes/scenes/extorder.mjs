import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const root = join(process.env.FIXES_SCRATCH ?? join(process.env.HOME, "ardia-scratch/video-fixes"), "ext-order");
const EXTENSIONS = [
  { key: "amber", name: "Amber Notes", rgb: [245, 170, 30] },
  { key: "blue", name: "Blue Notes", rgb: [52, 120, 246] },
  { key: "green", name: "Green Notes", rgb: [46, 170, 90] },
  { key: "red", name: "Red Notes", rgb: [230, 60, 60] },
];

function roundedSquare(size, [r, g, b]) {
  const radius = size * 0.24;
  const inside = (x, y) => {
    const dx = Math.max(radius - x, 0, x - (size - 1 - radius));
    const dy = Math.max(radius - y, 0, y - (size - 1 - radius));
    return dx * dx + dy * dy <= radius * radius;
  };
  const rows = [];
  for (let y = 0; y < size; y++) {
    rows.push(0);
    for (let x = 0; x < size; x++) rows.push(...(inside(x, y) ? [r, g, b, 255] : [0, 0, 0, 0]));
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from(rows))), chunk("IEND", Buffer.alloc(0))]);
}

const paths = EXTENSIONS.map(({ key, name, rgb }) => {
  const dir = join(root, key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    manifest_version: 3,
    name,
    version: "1.0",
    action: { default_icon: "icon.png", default_title: name, default_popup: "popup.html" },
    icons: { 128: "icon.png" },
  }));
  writeFileSync(join(dir, "popup.html"), `<!doctype html><meta charset="utf-8"><body style="margin:0;width:180px;padding:14px 18px;background:rgb(${rgb});color:#fff;font:600 14px -apple-system">${name}</body>`);
  writeFileSync(join(dir, "icon.png"), roundedSquare(128, rgb));
  return dir;
});

const SLOT = { x: 1390, y: 30, pitch: 30 };

export default {
  session: "session-extension-order.json",
  setup: `const profile = ac.extensions.extensionProfile(st(), W);
const paths = ${JSON.stringify(paths)};
return paths.reduce((p, path) => p.then((ids) => ac.engine.call("extensions.install", { profile, path }).then((r) => ac.extensions.setPinned(profile, r.id, true).then(() => sleep(600)).then(() => ids.concat([r.id])))), Promise.resolve([]))
  .then((ids) => ac.extensions.refreshExtensions(profile).then(() => sleep(2500)).then(() => done({ profile, ids })));`,
  act: `const SLOT = ${JSON.stringify(SLOT)};
const slot = (i) => [SLOT.x + i * SLOT.pitch, SLOT.y];
const profile = ac.extensions.extensionProfile(st(), W);
const nameOf = (id) => ((ac.extensions.useExtensions.getState().lists[profile] || []).find((x) => x.id === id) || {}).name || id;
const order = () => (ac.extensions.useExtensions.getState().lists[profile] || []).filter((x) => x.pinned)
  .map((x, i) => ({ name: x.name, at: x.pinnedIndex === undefined ? i : x.pinnedIndex }))
  .sort((a, b) => a.at - b.at).map((x) => x.name.split(" ")[0]);
const watched = { popup: null, order: order().join(",") };
events.push({ t: Date.now(), order: watched.order });
const stop = ac.extensions.useExtensions.subscribe((s) => {
  const popup = s.popup ? nameOf(s.popup.extensionId) : null;
  if (popup !== watched.popup) {
    watched.popup = popup;
    events.push({ t: Date.now(), popup });
  }
  const now = order().join(",");
  if (now !== watched.order) {
    watched.order = now;
    events.push({ t: Date.now(), order: now });
  }
});
const drag = (from, to, ms) => {
  const [x0, y0] = slot(from);
  const [x1, y1] = slot(to);
  const steps = Math.max(1, Math.round(ms / 16));
  const step = (i) => {
    if (i > steps) return Promise.resolve();
    const k = ease(i / steps);
    px = Math.round((x0 + (x1 - x0) * k) * 10) / 10;
    py = y0;
    events.push({ t: Date.now(), x: px, y: py });
    return dw("mouse:dragged:" + px + "," + py).then(() => sleep(16)).then(() => step(i + 1));
  };
  events.push({ t: Date.now(), down: 1 });
  return dw("mouse:down:" + x0 + "," + y0).then(() => sleep(260)).then(() => step(1)).then(() => sleep(320)).then(() => {
    events.push({ t: Date.now(), up: 1 });
    return dw("mouse:up:" + x1 + "," + y1);
  });
};
return at(slot(1)[0] - 60, 170).then(() => sleep(500))
  .then(() => move(...slot(0), 750)).then(() => sleep(350))
  .then(() => { mark("go"); return drag(0, 2, 1100); }).then(() => sleep(1300))
  .then(() => move(...slot(3), 650)).then(() => sleep(350))
  .then(() => { mark("front"); return drag(3, 0, 1400); }).then(() => sleep(1300))
  .then(() => move(slot(1)[0] - 60, 170, 700)).then(() => sleep(1000))
  .then(() => { stop(); return done({ order: order(), popup: watched.popup }); });`,
  tail: 700,
};
