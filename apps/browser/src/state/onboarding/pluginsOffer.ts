import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { featuredPlugins, PRESELECTED_PLUGINS, type FeaturedPlugin } from "../plugins/featured";
import { useCatalog } from "../plugins/marketplace";
import { currentPlugins } from "../plugins/store";

export { PRESELECTED_PLUGINS };

export const offeredInOnboarding = (plugins: readonly FeaturedPlugin[]) => plugins.filter((p) => p.state !== "unsupported");

export const pluginsStepHasSomething = (plugins: readonly FeaturedPlugin[]) => plugins.some((p) => p.state !== "unsupported");

export const pluginsCatalogueKnown = (supported: boolean = PLATFORM_FEATURES.plugins) => !supported || currentPlugins().scanned;

export const pluginsStepShown = () => !pluginsCatalogueKnown() || pluginsStepHasSomething(featuredPlugins(currentPlugins(), useCatalog.getState()));
