import { pickerCall } from "../../browser/src/state/site/elementPicker";

type PickerOp = "start" | "cancel" | "apply" | "unhide";

type PickerCallSplit = { prefix: string; json: string; suffix: string };

const KEY = 'window[Symbol.for("ardia.elementPicker")]';

export const PICKER_START_SUFFIX = `])).then((v) => { ${KEY}.linuxPick = { value: v === undefined ? null : v }; }, () => { ${KEY}.linuxPick = { value: null }; });`;

export const PICKER_TAKE = `const picker = ${KEY};
if (picker && picker.session) post("result", JSON.stringify({ pending: true }));
else if (picker && picker.linuxPick) {
  const pick = picker.linuxPick;
  picker.linuxPick = null;
  post("result", JSON.stringify({ pick: pick.value }));
} else post("result", "null");`;

const PICKER_POLL_MS = 120;

export function splitPickerCall(op: PickerOp, value: unknown): PickerCallSplit {
  const code = pickerCall(op, value);
  const json = JSON.stringify(value);
  const marker = `.${op}(...[`;
  const at = code.indexOf(marker);
  const start = at + marker.length;
  if (at < 0 || code.slice(start, start + json.length) !== json) throw new Error(`picker ${op} does not carry its argument once`);
  return { prefix: code.slice(0, start), json, suffix: code.slice(start + json.length) };
}

export function pickerStartPoint(script: unknown): { point: unknown } | null {
  if (typeof script !== "string") return null;
  const { prefix, suffix } = splitPickerCall("start", null);
  if (!script.startsWith(prefix) || !script.endsWith(suffix) || script.length <= prefix.length + suffix.length) return null;
  try {
    const point = JSON.parse(script.slice(prefix.length, script.length - suffix.length));
    if (point === null) return { point };
    if (Array.isArray(point) && point.length === 2 && point.every((n) => typeof n === "number" && Number.isFinite(n))) return { point };
  } catch {
    return null;
  }
  return null;
}

export function linuxPickerStart(point: unknown): string {
  const { prefix } = splitPickerCall("start", null);
  return prefix + JSON.stringify(point) + PICKER_START_SUFFIX;
}

type Evaluate = (script: string) => Promise<unknown>;

export async function pickOnLinuxPage(evaluate: Evaluate, point: unknown, sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<unknown> {
  await evaluate(linuxPickerStart(point));
  for (;;) {
    await sleep(PICKER_POLL_MS);
    const answer = await evaluate(PICKER_TAKE).catch(() => null);
    if (!answer || typeof answer !== "object") return null;
    if ((answer as { pending?: unknown }).pending === true) continue;
    return "pick" in answer ? (answer as { pick: unknown }).pick : null;
  }
}
