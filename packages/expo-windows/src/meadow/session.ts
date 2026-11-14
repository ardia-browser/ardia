import type { MeadowIntro, MeadowIntroEvent, MeadowPageReport, MeadowPageState, MeadowTone } from "@ardia/shaders";
import { MEADOW_PAGE_API, MEADOW_PAGE_CONFIG_ID } from "../../../shaders/src/meadowPage/config";
import { meadowScriptsCode, withoutFragment } from "./pageUrl";

export const MEADOW_READY_LIMIT_MS = 2500;
export const MEADOW_POLL_MS = 100;
export const MEADOW_LAST_READ_MS = 200;

type Cancel = () => void;

export type MeadowSessionDeps = {
  now(): number;
  later(ms: number, run: () => void): Cancel;
  every(ms: number, run: () => void): Cancel;
  evaluate(code: string): Promise<unknown>;
  run(code: string): void;
  show(): void;
  close(): Promise<void>;
  tell(event: MeadowIntroEvent): void;
  tone(tone: MeadowTone): void;
  log(line: string): void;
};

export type MeadowPhase = "booting" | "opening" | "live" | "closing" | "closed" | "fallen";

export type MeadowSession = {
  phase(): MeadowPhase;
  pageEvent(name: string, data: unknown): void;
  setNight(night: boolean): void;
  setMuted(muted: boolean): void;
  end(): void;
};

const TAKE = `post("result", JSON.stringify(window.${MEADOW_PAGE_API} ? window.${MEADOW_PAGE_API}.take() : { booted: !!document.getElementById("${MEADOW_PAGE_CONFIG_ID}") }));`;
const AWAY_EVENTS = new Set(["loadError", "crashed"]);

type Polled = { report: MeadowPageReport } | { booted: boolean } | null;

function readPoll(raw: unknown): Polled {
  if (typeof raw !== "string") return null;
  try {
    const read = JSON.parse(raw) as Partial<MeadowPageReport> & { booted?: unknown };
    if (read && Array.isArray(read.states)) return { report: read as MeadowPageReport };
    return read && typeof read.booted === "boolean" ? { booted: read.booted } : null;
  } catch {
    return null;
  }
}

const reportOf = (polled: Polled) => (polled && "report" in polled ? polled.report : null);

const isTone = (tone: unknown): tone is MeadowTone["tone"] => tone === "light" || tone === "dark";

export function startMeadowSession(intro: MeadowIntro, night: boolean, url: string, deps: MeadowSessionDeps): MeadowSession {
  const createdAt = deps.now();
  const document = withoutFragment(url);
  let phase: MeadowPhase = "booting";
  let injecting = false;
  let pageNight = night;
  let wantedNight = night;
  let reading = false;
  let frames = 0;
  let framesMs = 0;
  let closeTimer: Cancel = () => {};

  const stopPoll = deps.every(MEADOW_POLL_MS, () => void poll());
  const stopDeadline = deps.later(MEADOW_READY_LIMIT_MS, () => fallBack("no first frame"));
  deps.log("[ardia windows] meadow page created");

  const finished = () => phase === "closing" || phase === "closed" || phase === "fallen";

  function stopTimers() {
    stopPoll();
    stopDeadline();
    closeTimer();
  }

  function logClosed(reason: string) {
    deps.log(`[ardia windows] meadow page closed after ${Math.round(deps.now() - createdAt)} ms (${reason})`);
  }

  function fallBack(reason: string) {
    if (finished()) return;
    phase = "fallen";
    stopTimers();
    deps.log(`[ardia windows] meadow fell back: ${reason}`);
    deps.tell({ kind: "fallback", reason });
    void deps.close().then(() => logClosed(reason));
  }

  function closeAt(at: number, reason: string) {
    closeTimer();
    closeTimer = deps.later(Math.max(0, at - deps.now()), () => void closeNow(reason));
  }

  async function closeNow(reason: string) {
    if (finished()) return;
    phase = "closing";
    stopTimers();
    const last = await Promise.race([deps.evaluate(TAKE).then((raw) => reportOf(readPoll(raw)), () => null), new Promise<null>((done) => deps.later(MEADOW_LAST_READ_MS, () => done(null)))]);
    if (last) noteFrames(last);
    deps.log(`[ardia windows] meadow ${frames} frames in ${framesMs} ms`);
    await deps.close();
    phase = "closed";
    logClosed(reason);
  }

  function noteFrames(report: MeadowPageReport) {
    if (typeof report.frames === "number") frames = report.frames;
    if (typeof report.ms === "number") framesMs = report.ms;
  }

  function sendNight() {
    if (phase !== "live" || pageNight === wantedNight) return;
    pageNight = wantedNight;
    deps.run(`meadowNight(${wantedNight})`);
  }

  function said(state: MeadowPageState) {
    if (state.state === "ready" && (phase === "opening" || phase === "booting")) {
      phase = "live";
      stopDeadline();
      deps.tell({ kind: "live", firstFrameMs: Math.round(deps.now() - createdAt) });
      sendNight();
      closeAt(intro.startedAt + intro.motion.exit.delay + intro.motion.holds.exit, "finished");
    } else if (state.state === "tone" && isTone(state.tone)) deps.tone({ tone: state.tone, halo: typeof state.halo === "number" ? state.halo : 0 });
    else if (state.state === "failed") fallBack("the scene failed");
    else if (state.state === "skip" && phase === "live") {
      deps.tell({ kind: "skip" });
      closeAt(deps.now() + intro.motion.holds.skip, "skipped");
    } else if (state.state === "mute" && typeof state.muted === "boolean") deps.tell({ kind: "mute", muted: state.muted });
  }

  function inject() {
    if (injecting) return;
    injecting = true;
    void deps.evaluate(meadowScriptsCode()).then(
      (ran) => {
        if (ran !== "true" && !finished()) fallBack("the scene's scripts did not run");
      },
      () => fallBack("the scene's scripts did not run"),
    );
  }

  async function poll() {
    if (reading || finished()) return;
    reading = true;
    const polled = await deps.evaluate(TAKE).then(readPoll, () => null);
    reading = false;
    if (!polled || finished()) return;
    if ("booted" in polled) {
      if (polled.booted) inject();
      return;
    }
    const report = polled.report;
    if (phase === "booting") {
      phase = "opening";
      deps.show();
    }
    noteFrames(report);
    for (const state of report.states) {
      if (finished()) return;
      said(state);
    }
  }

  return {
    phase: () => phase,
    pageEvent(name, data) {
      if (finished()) return;
      if (AWAY_EVENTS.has(name)) return fallBack(name === "crashed" ? "the page crashed" : "the page did not load");
      if (name !== "navigation") return;
      const at = (data as { url?: unknown } | null)?.url;
      if (typeof at !== "string" || at === "" || at === "about:blank" || withoutFragment(at) === document) return;
      fallBack("the page navigated away");
    },
    setNight(next) {
      wantedNight = next;
      sendNight();
    },
    setMuted(muted) {
      if (!finished()) deps.run(`window.${MEADOW_PAGE_API} && window.${MEADOW_PAGE_API}.muted(${muted === true})`);
    },
    end() {
      if (phase === "closed" || phase === "fallen") return;
      const was = phase;
      phase = "closed";
      stopTimers();
      if (was !== "closing") logClosed("the intro ended");
    },
  };
}
