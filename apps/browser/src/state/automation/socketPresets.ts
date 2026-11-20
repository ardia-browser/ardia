import { applySetupCode } from "../presets/actions";
import { decodeSetupCode, describeSetupChoices } from "../presets/setupCode";
import { eligibleKind } from "./automationWindows";
import type { MethodSpec } from "./socketCatalog";
import { obj, WINDOW } from "./socketSchema";
import { now, windowOf } from "./socketTargets";
import { OpError } from "./workspaceTargets";

const CODE = { type: "string", description: "A setup code like ardia1-…, from the demo on ardia.dev" } as const;

function windowFor(params: Record<string, unknown>): string | null {
  if (params.window !== undefined) return windowOf(params.window, ["normal"]).id;
  const s = now();
  const main = s.ui.focusOrder.find((w) => eligibleKind(s, w) === "normal") ?? s.windowOrder.find((w) => eligibleKind(s, w) === "normal");
  if (main) return main;
  if (s.windowOrder.length) throw new OpError("no_window", "No window the ardia command can use is open.");
  return null;
}

function decoded(code: unknown) {
  const result = decodeSetupCode(code as string);
  if (!result.ok) throw new OpError("bad_request", result.error);
  return result.choices;
}

function describe(params: Record<string, unknown>) {
  const choices = decoded(params.code);
  return { preset: choices.preset ?? null, settings: choices.settings, color: choices.color ?? null, pins: choices.pins ?? [], lines: describeSetupChoices(choices) };
}

function apply(params: Record<string, unknown>) {
  decoded(params.code);
  const windowId = windowFor(params);
  const applied = applySetupCode(params.code as string, windowId);
  if (!applied.ok) throw new OpError("bad_request", applied.error);
  return { ok: true, window: windowId, lines: applied.lines };
}

export const PRESET_METHODS: MethodSpec[] = [
  { name: "presets.describe", mutates: false, description: "What a setup code would change, without changing anything", params: obj({ code: CODE }, ["code"]), result: "{preset, settings, color, pins, lines}", run: describe },
  {
    name: "presets.apply",
    mutates: true,
    description: "Apply a setup code as Settings › Apply a setup code does: layout and look settings, the window's profile colour and its pinned apps",
    params: obj({ code: CODE, window: { ...WINDOW, description: "The window whose profile takes the colour and pinned apps; the focused one when left out" } }, ["code"]),
    result: "{ok, window, lines}",
    run: apply,
  },
];
