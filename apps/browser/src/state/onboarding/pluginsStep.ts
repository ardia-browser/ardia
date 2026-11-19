import { create } from "zustand";
import { askConsentInOnboarding, confirmConsentAs, dismissConsentAs, ownsConsent, releaseOnboardingConsent } from "../plugins/consentSurface";
import { installOfficialPlugin, type OfficialPlugin } from "../plugins/official";
import { officialTitle, wasCancelled } from "../plugins/officialView";
import { currentPlugins } from "../plugins/store";
import { consentToken, type ConsentToken } from "../telemetry/consentPeriod";
import { noteOfficialPlugin } from "../telemetry/officialPluginCounts";
import { activeSteps, confirmAnswer, goToStep, skipStep, STEPS, useOnboarding } from "./onboarding";
import { PRESELECTED_PLUGINS, pluginsStepShown } from "./pluginsOffer";

export type PluginsStepPhase = "offer" | "working" | "installed" | "failed";

type PluginsStepState = {
  picks: Record<string, boolean>;
  phase: PluginsStepPhase;
  current: string | null;
  failures: Record<string, string>;
  installed: string[];
  shown: string[];
  run: number;
};

type InstallOutcome = Awaited<ReturnType<typeof installOfficialPlugin>>;

export const REFUSED_REASON = "Can't install it right now.";

const FRESH = { picks: {}, phase: "offer", current: null, failures: {}, installed: [], shown: [] } satisfies Omit<PluginsStepState, "run">;

const refusals = new Map<number, (outcome: InstallOutcome) => void>();

function installOrRefusal(name: string, run: number): Promise<InstallOutcome> {
  let refuse: (outcome: InstallOutcome) => void = () => {};
  const refused = new Promise<InstallOutcome>((resolve) => {
    refuse = resolve;
  });
  const { result: installed, id } = askConsentInOnboarding(name, useOnboarding.getState().windowId, () => inPluginsStep(run), () => installOfficialPlugin(name, { showSheet: false }));
  if (id === null) return installed;
  refusals.set(id, refuse);
  return Promise.race([installed, refused]).finally(() => refusals.delete(id));
}

export function confirmPluginConsent(id: number): boolean {
  if (!ownsConsent("onboarding", id)) return false;
  if (confirmConsentAs("onboarding", id)) return true;
  refusals.get(id)?.({ ok: false, reason: REFUSED_REASON });
  dismissConsentAs("onboarding", id);
  return false;
}

export const cancelPluginConsent = (id: number): boolean => dismissConsentAs("onboarding", id);

export function notePluginsShown(names: readonly string[]) {
  const fresh = names.filter((name) => !now().shown.includes(name));
  if (!fresh.length) return;
  usePluginsStep.setState((s) => ({ shown: [...s.shown, ...fresh] }));
  for (const name of fresh) noteOfficialPlugin("onboarding", "shown", name);
}

export const usePluginsStep = create<PluginsStepState>()(() => ({ ...FRESH, run: 0 }));

const now = () => usePluginsStep.getState();

export const isPicked = (plugin: OfficialPlugin, picks: Record<string, boolean>) => plugin.state === "available" && (picks[plugin.name] ?? PRESELECTED_PLUGINS.includes(plugin.name));

export const pickedPlugins = (plugins: readonly OfficialPlugin[], picks: Record<string, boolean>) => plugins.filter((p) => isPicked(p, picks));

export const installedLines = (plugins: readonly OfficialPlugin[], installed: readonly string[]) => plugins.filter((p) => installed.includes(p.name)).map((p) => `${officialTitle(p)} installed`);

export function primaryTitle(plugins: readonly OfficialPlugin[], state: Pick<PluginsStepState, "picks" | "phase">): string {
  if (state.phase === "working") return "Installing…";
  if (state.phase !== "offer") return "Continue";
  return pickedPlugins(plugins, state.picks).length ? "Install" : "Continue";
}

export function togglePluginPick(plugin: OfficialPlugin) {
  if (now().phase !== "offer" || plugin.state !== "available") return;
  usePluginsStep.setState((s) => ({ picks: { ...s.picks, [plugin.name]: !isPicked(plugin, s.picks) } }));
}

export function resetPluginsStep() {
  usePluginsStep.setState((s) => ({ ...FRESH, run: s.run + 1 }));
}

const inPluginsStep = (run: number) => now().run === run && useOnboarding.getState().step === "plugins" && !!useOnboarding.getState().windowId;

async function installEach(names: readonly string[], run: number, consent: ConsentToken | null): Promise<"done" | "cancelled" | "left"> {
  for (const name of names) {
    if (!inPluginsStep(run)) return "left";
    usePluginsStep.setState((s) => ({ phase: "working", current: name, failures: Object.fromEntries(Object.entries(s.failures).filter(([failed]) => failed !== name)) }));
    const result = await installOrRefusal(name, run);
    if (wasCancelled(result)) return inPluginsStep(run) ? "cancelled" : "left";
    noteOfficialPlugin("onboarding", result.ok ? "installed" : "failed", name, consent);
    if (!inPluginsStep(run)) continue;
    if (result.ok) usePluginsStep.setState((s) => ({ installed: [...s.installed, name] }));
    else usePluginsStep.setState((s) => ({ failures: { ...s.failures, [name]: result.reason } }));
  }
  return inPluginsStep(run) ? "done" : "left";
}

async function runInstall(names: readonly string[], consent: ConsentToken | null) {
  const run = now().run;
  const outcome = await installEach(names, run, consent);
  if (outcome === "left") return;
  const failed = Object.keys(now().failures).length > 0;
  usePluginsStep.setState({ current: null, phase: outcome === "cancelled" ? (failed ? "failed" : "offer") : failed ? "failed" : "installed" });
}

export function installPickedPlugins(plugins: readonly OfficialPlugin[]): Promise<void> {
  const state = now();
  if (state.phase !== "offer") return Promise.resolve();
  const names = pickedPlugins(plugins, state.picks).map((p) => p.name);
  if (!names.length) {
    finishPluginsStep(plugins);
    return Promise.resolve();
  }
  return runInstall(names, consentToken());
}

export function installPluginAgain(name: string): Promise<void> {
  if (now().phase !== "failed") return Promise.resolve();
  return runInstall([name], consentToken());
}

export function finishPluginsStep(plugins: readonly OfficialPlugin[]) {
  const state = now();
  if (state.phase === "working" || useOnboarding.getState().step !== "plugins") return;
  for (const plugin of plugins) if (plugin.state === "available" && !state.installed.includes(plugin.name) && !(plugin.name in state.failures)) noteOfficialPlugin("onboarding", "skipped", plugin.name);
  const lines = installedLines(plugins, state.installed);
  resetPluginsStep();
  confirmAnswer("plugins", {}, lines);
}

export function skipPluginsStep(plugins: readonly OfficialPlugin[]) {
  if (useOnboarding.getState().step !== "plugins") return;
  const state = now();
  if (state.phase !== "working") for (const plugin of plugins) if (plugin.state === "available" && !(plugin.name in state.failures)) noteOfficialPlugin("onboarding", "skipped", plugin.name);
  releaseOnboardingConsent();
  resetPluginsStep();
  skipStep();
}

export function leavePluginsStep() {
  releaseOnboardingConsent();
  resetPluginsStep();
}

export function passEmptyPluginsStep() {
  if (useOnboarding.getState().step !== "plugins" || pluginsStepShown()) return;
  releaseOnboardingConsent();
  resetPluginsStep();
  goToStep(activeSteps().find((step) => STEPS.indexOf(step) > STEPS.indexOf("plugins")) ?? "outro");
}
