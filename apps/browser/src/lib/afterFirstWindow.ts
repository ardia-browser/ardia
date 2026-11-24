const FALLBACK_MS = 5000;

let waiting: (() => void)[] | null = [];
let rootWaiting: (() => void)[] | null = [];
let fallback: ReturnType<typeof setTimeout> | undefined;

function run(tasks: (() => void)[]) {
  for (const task of tasks) {
    try {
      task();
    } catch (error) {
      console.warn("[launch] deferred work failed", error);
    }
  }
}

function later(task: () => void) {
  setTimeout(() => run([task]), 0);
}

function releaseWaiting() {
  if (!waiting) return;
  const tasks = waiting;
  waiting = null;
  clearTimeout(fallback);
  if (tasks.length) setTimeout(() => run(tasks), 0);
}

export function afterFirstWindow(task: () => void) {
  if (!waiting) return later(task);
  waiting.push(task);
  fallback ??= setTimeout(releaseWaiting, FALLBACK_MS);
}

export function afterFirstRoot(task: () => void) {
  if (!rootWaiting) return later(task);
  rootWaiting.push(task);
}

export function firstWindowCommitted() {
  if (rootWaiting) {
    const tasks = rootWaiting;
    rootWaiting = null;
    if (tasks.length) setTimeout(() => run(tasks), 0);
  }
  releaseWaiting();
}
