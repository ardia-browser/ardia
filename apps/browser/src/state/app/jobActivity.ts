export const JOB_ACTIVITIES = ["sync", "sessionSave", "memoryTrim", "omniboxSuggest", "liveFolders", "historyApply", "import"] as const;
export type JobActivity = (typeof JOB_ACTIVITIES)[number];

type Span = { activity: JobActivity; start: number; end: number | null };

const KEPT = 32;
const spans: Span[] = [];

export function beginActivity(activity: JobActivity, start = Date.now()): () => void {
  const span: Span = { activity, start, end: null };
  spans.push(span);
  if (spans.length > KEPT) spans.shift();
  return () => {
    if (span.end === null) span.end = Date.now();
  };
}

export function during<T>(activity: JobActivity, run: () => T): T {
  const end = beginActivity(activity);
  let result: T;
  try {
    result = run();
  } catch (error) {
    end();
    throw error;
  }
  if (result instanceof Promise) void result.then(end, end);
  else end();
  return result;
}

export function activityDuring(start: number, end: number, now = Date.now()): JobActivity | "none" {
  let best: JobActivity | "none" = "none";
  let bestOverlap = 0;
  for (const span of spans) {
    const overlap = Math.min(end, span.end ?? now) - Math.max(start, span.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = span.activity;
    }
  }
  return best;
}

export const forgetActivitiesForTests = () => void (spans.length = 0);
