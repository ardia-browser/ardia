import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { officialPlugins, type OfficialPlugin } from "../plugins/official";
import { currentPlugins } from "../plugins/store";

export const PRESELECTED_PLUGINS: readonly string[] = ["cli"];

export const offeredInOnboarding = (plugins: readonly OfficialPlugin[]) => plugins.filter((p) => p.state !== "unsupported");

export const pluginsStepHasSomething = (plugins: readonly OfficialPlugin[]) => plugins.some((p) => p.state === "available" || p.state === "installed");

export const pluginsCatalogueKnown = (supported: boolean = PLATFORM_FEATURES.plugins) => !supported || currentPlugins().scanned;

export const pluginsStepShown = () => !pluginsCatalogueKnown() || pluginsStepHasSomething(officialPlugins(currentPlugins()));
