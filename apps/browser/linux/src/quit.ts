import { app } from "electron";
import { emit } from "./bridge";
import { note } from "./log";

const QUIT_ANSWER_WAIT_MS = 3000;

let quitting = false;
let generation = 0;
let finished = false;
const beforeFinish: (() => void)[] = [];

export const isQuitting = (): boolean => quitting;

export function onFinishQuit(run: () => void): void {
  beforeFinish.push(run);
}

function finish(): void {
  if (finished) return;
  finished = true;
  for (const run of beforeFinish) {
    try {
      run();
    } catch (error) {
      note("quit", `a quit step failed: ${String(error)}`);
    }
  }
  note("quit", "quitting");
  app.exit(0);
}

type QuitGuard = () => Promise<boolean>;
let quitGuard: QuitGuard | null = null;
let guarding = false;

export function guardQuitWith(guard: QuitGuard): void {
  quitGuard = guard;
}

export function requestQuit(): void {
  if (quitting || guarding) return;
  if (!quitGuard) return beginQuit();
  guarding = true;
  void quitGuard()
    .catch(() => true)
    .then((proceed) => {
      guarding = false;
      if (proceed) beginQuit();
    });
}

function beginQuit(): void {
  if (quitting) return;
  quitting = true;
  const mine = ++generation;
  emit("ArdiaShell", "onAppEvent", { type: "willQuit" });
  setTimeout(() => {
    if (quitting && mine === generation) {
      note("quit", "the UI didn't answer willQuit in time; quitting anyway");
      finish();
    }
  }, QUIT_ANSWER_WAIT_MS);
}

export function replyToTerminate(ok: boolean): void {
  if (!quitting) return;
  if (ok) return finish();
  quitting = false;
  generation++;
  emit("ArdiaShell", "onAppEvent", { type: "quitCancelled" });
}

export function installQuitLifecycle(): void {
  app.on("before-quit", (event) => {
    if (finished) return;
    event.preventDefault();
    requestQuit();
  });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
    process.on(signal, () => {
      if (!quitting) return beginQuit();
      note("quit", `${signal} again while quitting; quitting now`);
      finish();
    });
}
