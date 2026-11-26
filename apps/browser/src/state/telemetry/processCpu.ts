import type { EngineTask } from "../../platform/performance";

const percentOfCore = (percent: number) => Math.round(Math.min(percent, 10_000) * 10) / 10;

type Kind = "browser" | "gpu" | "renderer" | "helper";

const kindOf = (type: EngineTask["type"]): Kind => (type === "browser" || type === "gpu" || type === "renderer" ? type : "helper");

export function processCpuFields(tasks: readonly Pick<EngineTask, "type" | "cpu" | "pid" | "id">[]): Record<string, number> {
  const processes = new Map<string, { kind: Kind; cpu: number }>();
  for (const t of tasks) {
    const used = Number.isFinite(t.cpu) ? Math.max(0, t.cpu) : 0;
    const key = typeof t.pid === "number" && t.pid > 0 ? `pid:${t.pid}` : `task:${t.id}`;
    const seen = processes.get(key);
    if (!seen) processes.set(key, { kind: kindOf(t.type), cpu: used });
    else seen.cpu = Math.max(seen.cpu, used);
  }
  if (![...processes.values()].some(({ cpu }) => cpu > 0)) return {};
  const sum = { browser: 0, gpu: 0, renderer: 0, helper: 0 };
  let rendererMax = 0;
  for (const { kind, cpu } of processes.values()) {
    sum[kind] += cpu;
    if (kind === "renderer") rendererMax = Math.max(rendererMax, cpu);
  }
  return {
    browser_cpu_now_pct: percentOfCore(sum.browser),
    gpu_cpu_now_pct: percentOfCore(sum.gpu),
    renderer_cpu_now_pct: percentOfCore(sum.renderer),
    renderer_cpu_now_max_pct: percentOfCore(rendererMax),
    helper_cpu_now_pct: percentOfCore(sum.helper),
  };
}
