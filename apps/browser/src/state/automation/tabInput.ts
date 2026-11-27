import type { TabInputAction, TabInputArgs, TabInputModifier } from "../../platform/control";
import { INPUT_ACTIONS } from "./tabInputActions";
import { OpError } from "./workspaceTargets";

export { INPUT_ACTIONS };

export const INPUT_BUTTONS = ["left", "middle"] as const;
export const INPUT_MODIFIERS = ["shift", "control", "alt", "meta"] as const satisfies readonly TabInputModifier[];

export const MAX_COORDINATE = 100_000;
export const MAX_WHEEL_DELTA = 10_000;
export const MAX_TEXT_LENGTH = 4096;
export const MAX_KEY_LENGTH = 32;

const CLICK = ["x", "y", "button", "modifiers"] as const;
const PRESS = ["x", "y", "button", "clickCount", "modifiers"] as const;
const FIELDS: Record<TabInputAction, readonly string[]> = {
  click: CLICK,
  dblclick: CLICK,
  down: PRESS,
  up: PRESS,
  move: ["x", "y", "modifiers"],
  wheel: ["x", "y", "deltaX", "deltaY", "modifiers"],
  key: ["key", "code", "modifiers"],
  text: ["text"],
};

const KEY_NAME = /^[A-Z][A-Za-z0-9]{1,31}$/;
const CODE_NAME = /^[A-Z][A-Za-z0-9]{1,31}$/;

const bad = (message: string) => new OpError("bad_request", message);

function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    }
  }
  return true;
}

function coordinate(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw bad(`${name} must be a finite number.`);
  if (value < 0 || value > MAX_COORDINATE) throw bad(`${name} must be between 0 and ${MAX_COORDINATE}.`);
  return value;
}

function delta(value: unknown, name: string): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) throw bad(`${name} must be a finite number.`);
  if (Math.abs(value) > MAX_WHEEL_DELTA) throw bad(`${name} must be within ±${MAX_WHEEL_DELTA}.`);
  return value;
}

function modifiersOf(value: unknown): TabInputModifier[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > INPUT_MODIFIERS.length) throw bad("modifiers takes at most shift, control, alt and meta.");
  const seen = new Set<TabInputModifier>();
  for (const item of value) {
    if (typeof item !== "string" || !(INPUT_MODIFIERS as readonly string[]).includes(item)) throw bad("modifiers takes only shift, control, alt and meta.");
    seen.add(item as TabInputModifier);
  }
  return INPUT_MODIFIERS.filter((m) => seen.has(m));
}

export function isKeyName(key: unknown): key is string {
  if (typeof key !== "string" || !key || key.length > MAX_KEY_LENGTH || !wellFormed(key)) return false;
  const points = [...key];
  if (points.length === 1) {
    const point = points[0]!.codePointAt(0)!;
    return point >= 0x20 && point !== 0x7f && !(point >= 0x80 && point <= 0x9f) && point !== 0x2028 && point !== 0x2029 && point !== 0xfeff;
  }
  return KEY_NAME.test(key);
}

export function checkedInput(params: Record<string, unknown>): Omit<TabInputArgs, "tabId"> {
  const action = params.action;
  if (typeof action !== "string" || !(INPUT_ACTIONS as readonly string[]).includes(action)) throw bad(`action must be one of: ${INPUT_ACTIONS.join(", ")}.`);
  const kind = action as TabInputAction;
  const takes = FIELDS[kind];
  const extra = Object.keys(params).filter((key) => key !== "tab" && key !== "action" && params[key] !== undefined && !takes.includes(key));
  if (extra.length) throw bad(`${kind} takes ${takes.join(", ")}, not ${extra.join(", ")}.`);
  const modifiers = modifiersOf(params.modifiers);
  const withModifiers = modifiers?.length ? { modifiers } : {};
  if (kind === "text") {
    const text = params.text;
    if (typeof text !== "string" || !text) throw bad("text needs at least one character.");
    if (text.length > MAX_TEXT_LENGTH) throw bad(`text takes at most ${MAX_TEXT_LENGTH} characters.`);
    if (!wellFormed(text) || text.includes("\0")) throw bad("text must be well-formed and hold no NUL.");
    return { action: kind, text };
  }
  if (kind === "key") {
    if (!isKeyName(params.key)) throw bad("key must be one character or a key name such as Enter, Tab, Backspace or ArrowLeft.");
    if (params.key === "ContextMenu" || params.code === "ContextMenu" || (params.key === "F10" && modifiers?.includes("shift"))) throw bad("The context menu key opens Ardia's own menu, so tabs.input doesn't send it.");
    const code = params.code;
    if (code !== undefined && (typeof code !== "string" || !CODE_NAME.test(code))) throw bad("code must be a key code such as KeyA, Digit1 or Enter.");
    return { action: kind, key: params.key, ...(code === undefined ? {} : { code: code as string }), ...withModifiers };
  }
  const x = coordinate(params.x, "x");
  const y = coordinate(params.y, "y");
  if (kind === "wheel") {
    if (modifiers?.some((m) => m === "control" || m === "meta")) throw bad("A wheel with control or meta zooms the page, so tabs.input doesn't send one.");
    const deltaX = delta(params.deltaX, "deltaX");
    const deltaY = delta(params.deltaY, "deltaY");
    if (deltaX === 0 && deltaY === 0) throw bad("wheel needs a deltaX or deltaY.");
    return { action: kind, x, y, deltaX, deltaY, ...withModifiers };
  }
  if (kind === "move") return { action: kind, x, y, ...withModifiers };
  if (modifiers?.includes("control")) throw bad("A control-click opens Ardia's own menu, so tabs.input doesn't send one.");
  const button = params.button;
  if (button === "right") throw bad("A right click opens Ardia's own menu, so tabs.input doesn't send one.");
  if (button !== undefined && (typeof button !== "string" || !(INPUT_BUTTONS as readonly string[]).includes(button))) throw bad("button must be left or middle.");
  const clickCount = params.clickCount;
  if (clickCount !== undefined && (typeof clickCount !== "number" || !Number.isInteger(clickCount) || clickCount < 1 || clickCount > 3)) throw bad("clickCount must be 1, 2 or 3.");
  return {
    action: kind,
    x,
    y,
    ...(button === undefined ? {} : { button: button as TabInputArgs["button"] }),
    ...(clickCount === undefined ? {} : { clickCount: clickCount as number }),
    ...withModifiers,
  };
}
