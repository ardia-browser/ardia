import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RATE = Number(process.env.SCROLLPERF_RATE ?? 120);
const KIND = process.env.SCROLLPERF_KIND ?? "trackpad";
const DRIVER = process.env.SCROLLPERF_DRIVER ?? "inproc";
const ACPERF = process.env.SCROLLPERF_ACPERF ?? "/tmp/ardia-perf/acperf";

function postedGesture(instance, cmd) {
  const listed = spawnSync(ACPERF, ["windows", String(instance.pid)], { encoding: "utf8", timeout: 10000 });
  const win = JSON.parse(listed.stdout.trim().split("\n")[0] || "[]").sort((a, b) => b.w * b.h - a.w * a.h)[0];
  if (!win) throw new Error(`acperf windows: no window for pid ${instance.pid}`);
  const at = [Math.round(win.x + cmd.x), Math.round(win.y + cmd.y)];
  const startMs = Date.now();
  const posted = spawnSync(ACPERF, ["postscroll", String(instance.pid), String(win.id), String(at[0]), String(at[1]), String(win.x), String(win.y), cmd.gesture, String(cmd.rate), ...(cmd.reverse ? ["reverse"] : [])], { encoding: "utf8", timeout: 20000 });
  if (posted.status !== 0) throw new Error(`acperf postscroll: ${posted.stderr}`);
  return { startMs, endMs: Date.now(), events: Number(/(\d+)/.exec(posted.stdout)?.[1] ?? 0) };
}

async function gesture(instance, cmd) {
  const inbox = join(instance.data, "film-scroll.json");
  const outbox = join(instance.data, "film-scroll-done.json");
  rmSync(outbox, { force: true });
  writeFileSync(inbox, JSON.stringify(cmd));
  for (const end = Date.now() + 15000; Date.now() < end; await sleep(30)) {
    if (!existsSync(outbox)) continue;
    const done = JSON.parse(readFileSync(outbox, "utf8"));
    if (done.error) throw new Error(`scroll.dylib: ${done.error}`);
    return done;
  }
  throw new Error("scroll.dylib never reported the gesture");
}

export function scrollScene({ session, point, region, gestures, lead = 900, gap = 450, setup, boot = 8000 }) {
  return {
    session,
    minWidth: 1000,
    boot,
    settle: 3000,
    dylibs: ["scroll"],
    setup: setup ?? `return sleep(2500).then(() => done({ layout: st().settings.tabLayout, tabs: st().windows[W].tabIds.length }));`,
    async external(instance) {
      const events = [];
      await sleep(400 + lead);
      const plan = process.env.SCROLLPERF_GESTURES ? process.env.SCROLLPERF_GESTURES.split(",") : gestures.map((g) => g.replace("flick", KIND));
      for (const [i, g] of plan.entries()) {
        const [name, reverse] = g.split(" ");
        const done = await (DRIVER === "acperf" ? postedGesture : gesture)(instance, { id: i + 1, gesture: name, x: point[0], y: point[1], rate: RATE, reverse: !!reverse });
        events.push({ t: done.startMs, mark: `g${i + 1}`, gesture: g, start: true });
        events.push({ t: done.endMs, mark: `g${i + 1}-end`, gesture: g, end: true, posted: done.events });
        await sleep(gap);
      }
      events.push({ t: Date.now(), mark: "done", point, region, kind: KIND });
      return events;
    },
    act: `return done();`,
    tail: 600,
  };
}
