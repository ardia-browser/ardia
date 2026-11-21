import { fileURLToPath } from "node:url";
import { seededRandom } from "./rng.mjs";
import { createWorld, installClock, installTimerLedger, loadModules } from "./world.mjs";

export const DEFAULT_SRC = fileURLToPath(new URL("../../src/", import.meta.url));

export async function boot({ src = DEFAULT_SRC, seed = 1 } = {}) {
  Math.random = seededRandom(seed ^ 0x5eed);
  const clock = installClock();
  const timers = installTimerLedger();
  const quiet = { warn: console.warn, error: console.error, info: console.info, log: console.log };
  const muted = [];
  console.warn = (...a) => muted.push(["warn", a]);
  console.error = (...a) => muted.push(["error", a]);
  console.info = () => {};
  const modules = await loadModules(src);
  modules.persist.startPersistence();
  const world = createWorld(modules, { clock, timers });
  world.console = quiet;
  world.muted = muted;
  world.takeErrors = () => muted.splice(0).filter(([level]) => level === "error").map(([, a]) => a.map((x) => String(x?.stack ?? x?.message ?? x).split("\n")[0]).join(" ").slice(0, 200));
  return world;
}
