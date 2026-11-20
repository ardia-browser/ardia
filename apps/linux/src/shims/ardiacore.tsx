import { provideNativeModuleProvider } from "./expo-modules-core";
import { ardiaHost, hostModuleMethod, reportHostError } from "../host";

export * from "@ardia-real/ardiacore";
export { devPagerState, leadPager, pagerState, selectPager, stepPager, SwipeArea, switchPager } from "./web/Pager";
export const nativeMorph = false;
export const morphPager = (_key: string, _config: unknown): Promise<boolean> => Promise.resolve(false);
export const takeMorphCounts = () => ({ frames: 0, late: 0 });
export const devMorph = (_key: string, _clear?: boolean, _hoverPasses?: number): Promise<unknown> => Promise.resolve(null);
export { HostWebView as WebView } from "./web/HostWebView";

provideNativeModuleProvider((module, method) => module === "ArdiaTabs" && method === "claimLaunchTab" && ardiaHost
  ? (...args: unknown[]) => { void hostModuleMethod(module, method)(...args).catch(reportHostError); }
  : undefined);
