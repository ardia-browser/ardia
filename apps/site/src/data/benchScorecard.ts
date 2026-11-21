import type { Bar, Bench, Figure, Group, Row } from "./bench";

export type Outcome = "win" | "loss" | "tie";

export type Callout = {
  figure: string | null;
  word: string | null;
  line: string;
  lost: boolean;
};

export type Cell = {
  name: string;
  isArdia: boolean;
  isBest: boolean;
  share: number;
  number: string | null;
  display: string;
  unit: string;
  spoken: string;
};

export type Line = {
  id: string;
  label: string;
  detail: string | null;
  outcome: Outcome;
  winner: string;
  callout: Callout;
  cells: Cell[];
};

export type TestGroup = {
  id: string;
  title: string;
  unit: string;
  isMulti: boolean;
  headline: Callout;
  lines: Line[];
};

export type Section = {
  id: string;
  title: string;
  tests: TestGroup[];
  lines: Line[];
};

export type Scorecard = {
  sections: Section[];
  total: number;
  roster: string[];
};

const TOPICS: { id: string; title: string; test: RegExp }[] = [
  { id: "launch", title: "Launch", test: /launch/ },
  { id: "sitting-still", title: "Sitting still", test: /memory|cpu|wake|power/ },
  { id: "tabs", title: "Tabs and windows", test: /tab|window|switch/ },
  { id: "engine", title: "Engine", test: /speedometer/ },
];

const TOPIC_ORDER = ["launch", "tabs", "sitting-still", "engine"];
const SITTING_ORDER: RegExp[] = [/memory/, /cpu/, /wake/, /power/];

const number = (v: number, decimals: number) =>
  v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
const decimalsFor = (v: number) => (Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 1 ? 1 : 2);
const figureText = (f: Figure) => `${number(f.value, f.decimals)}${f.suffix}`;
const glued = (unit: string) => unit === "%" || unit.startsWith("/");
const withUnit = (text: string, unit: string) => (glued(unit) ? `${text}${unit}` : `${text} ${unit}`);
const parenthetical = (text: string) => text.match(/^(.*?)\s*\((.+)\)\s*$/);
const valueOf = (bar: Bar) => bar.value.value;

function outcomeOf(row: Row): Outcome {
  const ardia = row.bars.find((b) => b.isArdia);
  if (!ardia?.isBest) return "loss";
  return row.bars.some((b) => !b.isArdia && b.isBest) ? "tie" : "win";
}

function winnerOf(row: Row, outcome: Outcome): string {
  if (outcome === "win") return row.bars.find((b) => b.isArdia)!.name;
  return row.bars.find((b) => !b.isArdia && b.isBest)!.name;
}

function calloutOf(row: Row): Callout {
  const { call } = row;
  return {
    figure: call.figure ? figureText(call.figure) : null,
    word: call.word ?? null,
    line: call.line,
    lost: call.lost,
  };
}

function shareOf(value: number, values: number[], lowerIsBetter: boolean): number {
  const max = Math.max(...values);
  if (lowerIsBetter) return max > 0 ? value / max : 0;
  const from = Math.max(0, Math.floor(Math.min(...values) - 1));
  return max > from ? (value - from) / (max - from) : 1;
}

function cellsOf(row: Row, roster: string[], decimals: number, omitUnit: boolean): Cell[] {
  const unit = row.bars[0].unit;
  const values = row.bars.map(valueOf);
  const lowerIsBetter = row.lowerIsBetter ?? true;
  return roster.map((name, i) => {
    const bar = row.bars.find((b) => b.name === name) ?? null;
    const text = bar ? number(bar.value.value, decimals) : null;
    const display = text ? (omitUnit ? text : withUnit(text, unit)) : "N/A";
    return {
      name,
      isArdia: bar?.isArdia ?? i === 0,
      isBest: bar?.isBest ?? false,
      share: bar ? shareOf(bar.value.value, values, lowerIsBetter) : 0,
      number: text,
      display,
      unit,
      spoken: text ? `${withUnit(text, unit)}${bar!.isBest ? ", best" : ""}` : "not measured",
    };
  });
}

function nameOf(row: Row): { label: string; detail: string | null } {
  const split = parenthetical(row.sub ?? row.label);
  return split ? { label: split[1], detail: split[2] } : { label: row.sub ?? row.label, detail: null };
}

function headlineOf(rows: Row[], lines: Line[]): Callout {
  if (lines.length === 1) return lines[0].callout;
  const pairs = rows.map((row, i) => ({ row, line: lines[i] }));
  const wins = pairs.filter((p) => p.line.outcome === "win");
  const pool = wins.length > 0 ? wins : pairs;
  const picked = pool.reduce((best, item) => (item.row.lead > best.row.lead ? item : best));
  const base = picked.line.callout;
  if (wins.length === 1) {
    return { ...base, line: `${base.line} at ${picked.line.label.toLowerCase()}` };
  }
  const hasIdle = /^idle\b/i.test(picked.line.label);
  const hasOther = pairs.some((p) => !/^idle\b/i.test(p.line.label));
  if (hasIdle && hasOther) {
    return { ...base, line: `${base.line} at idle` };
  }
  return base;
}

function testGroupOf(group: Group, roster: string[]): TestGroup {
  const isMulti = group.rows.length > 1;
  const values = group.rows.flatMap((r) => r.bars.map(valueOf));
  const decimals = decimalsFor(Math.min(...values));
  const lines: Line[] = group.rows.map((row) => {
    const outcome = outcomeOf(row);
    return {
      id: row.id,
      ...nameOf(row),
      outcome,
      winner: winnerOf(row, outcome),
      callout: calloutOf(row),
      cells: cellsOf(row, roster, decimals, isMulti),
    };
  });
  return {
    id: group.id,
    title: group.label,
    unit: group.rows[0].bars[0].unit,
    isMulti,
    headline: headlineOf(group.rows, lines),
    lines,
  };
}

function topicOf(group: Group): { id: string; title: string } {
  const key = `${group.id} ${group.label} ${group.rows[0].id} ${group.rows[0].label}`.toLowerCase();
  const topic = TOPICS.find((t) => t.test.test(key));
  if (topic) return topic;
  if (group.rows.length > 1) return TOPICS[1];
  return { id: group.id, title: group.label };
}

const topicRank = (id: string) => {
  const at = TOPIC_ORDER.indexOf(id);
  return at === -1 ? TOPIC_ORDER.length - 0.5 : at;
};

const sittingRank = (id: string) => {
  const at = SITTING_ORDER.findIndex((test) => test.test(id));
  return at === -1 ? SITTING_ORDER.length : at;
};

export function scorecardOf(bench: Bench): Scorecard {
  const rows = bench.groups.flatMap((g) => g.rows);
  const ardiaName = rows[0].bars.find((b) => b.isArdia)!.name;
  const roster = [ardiaName, ...bench.rivals];
  const topics = new Map<string, { title: string; tests: TestGroup[] }>();
  for (const group of bench.groups) {
    const topic = topicOf(group);
    const entry = topics.get(topic.id) ?? { title: topic.title, tests: [] };
    entry.tests.push(testGroupOf(group, roster));
    topics.set(topic.id, entry);
  }
  const sections: Section[] = [...topics]
    .map(([id, entry]) => {
      const tests = id === "sitting-still" ? [...entry.tests].sort((a, b) => sittingRank(a.id) - sittingRank(b.id)) : entry.tests;
      return {
        id,
        title: entry.title,
        tests,
        lines: tests.flatMap((t) => t.lines),
      };
    })
    .sort((a, b) => topicRank(a.id) - topicRank(b.id));
  return { sections, total: rows.length, roster };
}
