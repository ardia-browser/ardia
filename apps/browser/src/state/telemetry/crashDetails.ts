const EXCEPTION_CODES = /^0x([0-9a-f]{1,16})(?:, 0x([0-9a-f]{1,16})(?:, 0x[0-9a-f]{1,16}){0,2})?$/;
const MAX_CODE = 0xffffffff;
const NULL_PAGE_END = 0x100000n;

const INDICATORS: Record<string, string> = {
  "Trace/BPT trap": "trace_trap",
  "Segmentation fault": "segmentation_fault",
  "Bus error": "bus_error",
  "Abort trap": "abort_trap",
  "Illegal instruction": "illegal_instruction",
  "Killed": "killed",
  "Terminated": "terminated",
  "Floating point exception": "floating_point",
  "Invalid Page": "invalid_page",
};

const THREADS: [RegExp, string][] = [
  [/^Cr(?:Browser|Renderer|Gpu|Utility)Main$/, "chrome_main"],
  [/^ThreadPool(?:Foreground|Background|SingleThread)/, "thread_pool"],
  [/^ThreadPoolServiceThread$/, "thread_pool"],
  [/^Chrome_(?:Child)?IOThread$/, "io"],
  [/^(?:Compositor|VizCompositorThread|CompositorTileWorker\w*)$/, "compositor"],
  [/^(?:DedicatedWorker|ServiceWorker|SharedWorker) thread$/, "web_worker"],
  [/^(?:Media|AudioOutputDevice|AudioThread|media::\w+)$/, "media"],
  [/^com\.facebook\.react\.JavaScript$/, "react_js"],
  [/^com\.facebook\.react\.\w+$/, "react_other"],
  [/^com\.apple\.NSEventThread$/, "appkit_events"],
  [/^com\.apple\./, "apple_other"],
];

type NativeCrashDetails = {
  exceptionType?: string;
  terminationIndicator?: string;
  terminationCode?: number;
  exceptionCodes?: string;
  crashedThread?: string;
  crashedQueue?: string;
};

const smallCode = (value: number | undefined) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_CODE ? value : null;

function indicatorKind(indicator: string | undefined) {
  if (typeof indicator !== "string" || !indicator) return null;
  const shown = indicator.replace(/:\s*\d+$/, "");
  return Object.hasOwn(INDICATORS, shown) ? INDICATORS[shown] : "other";
}

function threadKind(name: string | undefined) {
  if (typeof name !== "string" || !name) return null;
  return THREADS.find(([pattern]) => pattern.test(name))?.[1] ?? "other";
}

function queueKind(queue: string | undefined) {
  if (typeof queue !== "string" || !queue) return null;
  return queue === "com.apple.main-thread" ? "main" : "other";
}

function exceptionCodes(type: string | undefined, codes: string | undefined) {
  const parsed = typeof codes === "string" ? EXCEPTION_CODES.exec(codes.toLowerCase()) : null;
  if (!parsed) return { code: null, nearNull: null };
  const code = smallCode(Number.parseInt(parsed[1] ?? "", 16));
  const nearNull = type === "EXC_BAD_ACCESS" && parsed[2] !== undefined ? BigInt(`0x${parsed[2]}`) < NULL_PAGE_END : null;
  return { code, nearNull };
}

export function nativeCrashDetails(report: NativeCrashDetails) {
  const { code, nearNull } = exceptionCodes(report.exceptionType, report.exceptionCodes);
  return {
    crash_termination_indicator: indicatorKind(report.terminationIndicator),
    crash_termination_code: smallCode(report.terminationCode),
    crash_exception_code: code,
    crash_fault_near_null: nearNull,
    crash_thread: threadKind(report.crashedThread),
    crash_queue: queueKind(report.crashedQueue),
  };
}
