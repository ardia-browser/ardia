import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { officialPlugins, PRESELECTED_PLUGINS, type OfficialPlugin } from "../plugins/official";
import { currentPlugins } from "../plugins/store";

export { PRESELECTED_PLUGINS };

export const offeredInOnboarding = (plugins: readonly OfficialPlugin[]) => plugins.filter((p) => p.state !== "unsupported");

export const pluginsStepHasSomething = (plugins: readonly OfficialPlugin[]) => plugins.some((p) => p.state === "available" || p.state === "installed");

export const pluginsCatalogueKnown = (supported: boolean = PLATFORM_FEATURES.plugins) => !supported || currentPlugins().scanned;

export const pluginsStepShown = () => !pluginsCatalogueKnown() || pluginsStepHasSomething(officialPlugins(currentPlugins()));
