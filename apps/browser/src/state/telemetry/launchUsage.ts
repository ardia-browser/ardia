import type { SystemInfo } from "../../platform/app";

const usageCount = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null);

export function launchUsageFields(usage: SystemInfo["launchUsage"]) {
  const at = (mark: "main" | "engineStarted") => usage?.[mark];
  return {
    main_page_ins: usageCount(at("main")?.pageIns),
    main_block_reads: usageCount(at("main")?.blockReads),
    main_cpu_ms: usageCount(at("main")?.cpuMs),
    engine_page_ins: usageCount(at("engineStarted")?.pageIns),
    engine_block_reads: usageCount(at("engineStarted")?.blockReads),
    engine_cpu_ms: usageCount(at("engineStarted")?.cpuMs),
  };
}

const LAUNCH_SOURCES = new Set<string>(["login_item", "documents", "user"]);

type LaunchContext = Pick<SystemInfo, "launchUsage" | "launchedHidden" | "launchSource" | "loadAverage1m">;

export const launchContextFields = ({ launchUsage, launchedHidden, launchSource, loadAverage1m }: LaunchContext) => ({
  load_1m: typeof loadAverage1m === "number" && Number.isFinite(loadAverage1m) && loadAverage1m >= 0 ? Math.round(loadAverage1m * 100) / 100 : null,
  ...launchUsageFields(launchUsage),
  launched_hidden: typeof launchedHidden === "boolean" ? launchedHidden : null,
  launch_source: typeof launchSource === "string" && LAUNCH_SOURCES.has(launchSource) ? launchSource : null,
});
