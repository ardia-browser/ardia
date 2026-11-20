import raw from "./computerUse.json";

type RawCell = (typeof raw.cells)[number];
type RawContender = (typeof raw.contenders)[number];
type Side = "ardia" | "aside" | "opencode";

export type Bar = { task: string; value: number; text: string; passes: number; runs: number; partial: boolean };
export type Series = { side: Side; name: string; sum: number; share: number; total: string; isBest: boolean; bars: (Bar | null)[] };
export type TaskCell = {
  side: Side;
  name: string;
  value: number | null;
  text: string;
  share: number;
  passes: number;
  runs: number;
  partial: boolean;
  isBest: boolean;
};
export type RowCallout = { figure: string; line: string; loss: boolean };
export type TaskRow = {
  task: string;
  title: string;
  cells: TaskCell[];
  ardiaText: string;
  ardiaBest: boolean;
  partialNote: string | null;
  callout: RowCallout | null;
};
export type ChartHeadline = { figure: string; line: string; secondary: string | null };
export type Chart = {
  id: string;
  title: string;
  agent: string;
  agentName: string;
  model: string;
  headline: ChartHeadline;
  ticks: { value: number; text: string; at: number }[];
  max: number;
  series: Series[];
  rows: TaskRow[];
};

const SHORT: Record<string, string> = {
  calendar: "Calendar",
  expenses: "Expenses",
  research: "Research",
  booking: "Booking",
  shop: "Shop",
  grid: "Grid",
  kanban: "Kanban",
  multitab: "Multi-tab",
};
const SIDES: { side: Side; name: string }[] = [
  { side: "ardia", name: "Ardia" },
  { side: "aside", name: "Aside" },
  { side: "opencode", name: "OpenCode" },
];
const MODELS = ["GPT-6.1 Sol", "Opus 5.5"];

const contenders = raw.contenders as RawContender[];
const cells = raw.cells as RawCell[];
const cellOf = (task: string, contender: string) => cells.find((c) => c.task === task && c.contender === contender && c.runs > 0);
const contenderOf = (side: Side, model: string) => contenders.find((c) => c.side === side && c.model === model);
const agentOf = (model: string) => contenders.find((c) => c.side === "ardia" && c.model === model)?.agent ?? "";

const millions = (t: number) => `${(t / 1e6).toFixed(2)}M`;
const tokenTick = (t: number) => (t === 0 ? "0" : t >= 1e6 ? `${+(t / 1e6).toFixed(1)}M` : `${Math.round(t / 1000)}K`);

function niceStep(rough: number) {
  const power = 10 ** Math.floor(Math.log10(rough));
  return [1, 2, 5, 10].map((f) => f * power).find((s) => s >= rough) ?? 10 * power;
}

function chartOf(model: string): Chart {
  const rawSeries = SIDES.flatMap(({ side, name }) => {
    const contender = contenderOf(side, model);
    if (!contender) return [];
    const bars = raw.tasks.map((t) => {
      const cell = cellOf(t.id, contender.id);
      const value = cell?.tokens ?? null;
      if (!cell || value == null) return null;
      return {
        task: SHORT[t.id] ?? t.title,
        value,
        text: millions(value),
        passes: cell.passes,
        runs: cell.runs,
        partial: cell.passes < cell.runs,
      };
    });
    const sum = bars.reduce((n, b) => n + (b?.value ?? 0), 0);
    return [{ side, name, sum, total: millions(sum), bars }];
  });
  const maxSum = Math.max(...rawSeries.map((s) => s.sum), 1);
  const minSum = Math.min(...rawSeries.map((s) => s.sum));
  const series: Series[] = rawSeries.map((s) => ({
    ...s,
    share: s.sum / maxSum,
    isBest: s.sum === minSum,
  }));
  const top = Math.max(...series.flatMap((s) => s.bars.map((b) => b?.value ?? 0)), 1);
  const step = niceStep(top / 4);
  const max = step * Math.ceil(top / step);
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => {
    const value = step * i;
    return { value, text: tokenTick(value), at: (value / max) * 100 };
  });
  const rows: TaskRow[] = raw.tasks.map((t, ti) => {
    const task = SHORT[t.id] ?? t.title;
    const vals = series.map((s) => s.bars[ti]?.value ?? null).filter((v): v is number => v !== null);
    const minVal = vals.length ? Math.min(...vals) : -1;
    const cells: TaskCell[] = series.map((s) => {
      const b = s.bars[ti];
      return {
        side: s.side,
        name: s.name,
        value: b?.value ?? null,
        text: b?.text ?? "N/A",
        share: b ? b.value / top : 0,
        passes: b?.passes ?? 0,
        runs: b?.runs ?? 0,
        partial: b?.partial ?? false,
        isBest: b != null && b.value === minVal,
      };
    });
    const ardiaCell = cells.find((c) => c.side === "ardia");
    const opencodeCell = cells.find((c) => c.side === "opencode");
    const partialCell = cells.find((c) => c.partial);
    const callout: RowCallout | null = (() => {
      if (!ardiaCell?.value || !opencodeCell?.value) return null;
      if (ardiaCell.value <= opencodeCell.value) {
        const r = opencodeCell.value / ardiaCell.value;
        if (r >= 1.5) return { figure: `${r.toFixed(1)}×`, line: "fewer than OpenCode", loss: false };
        const pct = Math.round(((opencodeCell.value - ardiaCell.value) / opencodeCell.value) * 100);
        return { figure: `${pct}%`, line: "fewer than OpenCode", loss: false };
      }
      const pct = Math.round(((ardiaCell.value - opencodeCell.value) / opencodeCell.value) * 100);
      return { figure: `${pct}%`, line: "more than OpenCode", loss: true };
    })();
    return {
      task,
      title: t.title,
      cells,
      ardiaText: ardiaCell?.text ?? "N/A",
      ardiaBest: ardiaCell?.isBest ?? false,
      partialNote: partialCell ? `${partialCell.name} ${partialCell.passes}/${partialCell.runs}` : null,
      callout,
    };
  });
  const ardia = series.find((s) => s.side === "ardia");
  const aside = series.find((s) => s.side === "aside");
  const opencode = series.find((s) => s.side === "opencode");
  const ratio = ardia && opencode && ardia.sum > 0 ? opencode.sum / ardia.sum : 1;
  const pctVsAside = ardia && aside && aside.sum > 0 ? Math.round(((aside.sum - ardia.sum) / aside.sum) * 100) : 0;
  const agentName = agentOf(model);
  return {
    id: `${model.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-tokens`,
    title: "Tokens",
    agent: `${agentName}, ${model}`,
    agentName,
    model,
    headline: {
      figure: `${ratio.toFixed(1)}×`,
      line: "fewer tokens than OpenCode",
      secondary: pctVsAside > 0 ? `${pctVsAside}% fewer than Aside` : null,
    },
    ticks,
    max,
    series,
    rows,
  };
}

function formatDay(date: string | null) {
  return date
    ? new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    : "";
}

const partialCells = cells.filter((c) => c.passes < c.runs);

export const computerUse = {
  dates: raw.from === raw.to ? formatDay(raw.from) : `${formatDay(raw.from)} to ${formatDay(raw.to)}`,
  asideVersion: raw.asideVersion,
  opencodeVersion: raw.opencodeVersion,
  repeats: raw.repeats,
  planned: raw.planned,
  runs: raw.runs,
  passes: cells.reduce((n, c) => n + c.passes, 0),
  complete: raw.runs >= raw.planned,
  taskCount: raw.tasks.length,
  tasks: raw.tasks.map((t) => SHORT[t.id] ?? t.title),
  sides: SIDES,
  partial: partialCells.map((c) => {
    const k = contenders.find((x) => x.id === c.contender);
    const side = SIDES.find((s) => s.side === k?.side)?.name ?? "";
    return `${side} + ${k?.model} on ${(SHORT[c.task] ?? c.task).toLowerCase()} passed ${c.passes} of ${c.runs}`;
  }),
  charts: MODELS.map(chartOf),
  source: "https://github.com/ardia-browser/plugins/tree/main/plugins/cli/bench",
};
