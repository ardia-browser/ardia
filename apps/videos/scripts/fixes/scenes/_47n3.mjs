import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const spec = join(dirname(fileURLToPath(import.meta.url)), "..", "fixes-0247n3.json");

export function afterSettings(scene, side) {
  if (side !== "after") return {};
  const segment = JSON.parse(readFileSync(spec, "utf8")).segments.find((s) => s.scene === scene);
  return segment?.afterSettings ?? {};
}

export async function applySettings(instance, scene, side) {
  const patch = afterSettings(scene, side);
  if (!Object.keys(patch).length) return { applied: null };
  const result = await instance.eval(`ac.store.getState().updateSettings(${JSON.stringify(patch)}); return new Promise((r) => setTimeout(r, 1200)).then(() => JSON.stringify(Object.fromEntries(Object.keys(${JSON.stringify(patch)}).map((k) => [k, ac.store.getState().settings[k]]))));`);
  return { applied: JSON.parse(result) };
}

export const DRAG = `const dragTo = (x, y, ms = 600) => {
  const x0 = px, y0 = py, steps = Math.max(1, Math.round(ms / 16));
  const step = (i) => {
    if (i > steps) return Promise.resolve();
    const k = ease(i / steps), nx = Math.round((x0 + (x - x0) * k) * 10) / 10, ny = Math.round((y0 + (y - y0) * k) * 10) / 10;
    px = nx; py = ny; events.push({ t: Date.now(), x: nx, y: ny });
    return dw("mouse:dragged:" + nx + "," + ny).then(() => sleep(16)).then(() => step(i + 1));
  };
  return step(1);
};
const down = () => { events.push({ t: Date.now(), down: 1 }); return dw("mouse:down:" + px + "," + py); };
const up = () => { events.push({ t: Date.now(), up: 1 }); return dw("mouse:up:" + px + "," + py); };`;
