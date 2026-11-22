import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bench, Group, Row } from "./bench.ts";
import { scorecardOf } from "./benchScorecard.ts";

const NAMES = ["Ardia", "Dia", "Helium"];

function row(
  id: string,
  label: string,
  unit: string,
  medians: (number | null)[],
  options: { sub?: string | null; lowerIsBetter?: boolean; figure?: { value: number; decimals: number; suffix: string } | null; line?: string; word?: string; lead?: number } = {},
): Row {
  const lowerIsBetter = options.lowerIsBetter ?? true;
  const measured = medians.flatMap((m, i) => (m === null ? [] : [{ name: NAMES[i], median: m }]));
  const best = (lowerIsBetter ? Math.min : Math.max)(...measured.map((b) => b.median));
  const top = Math.max(...measured.map((b) => b.median));
  const figure = options.figure === undefined ? { value: 2, decimals: 0, from: 1, suffix: "×" } : options.figure ? { ...options.figure, from: 0 } : null;
  return {
    id,
    label,
    sub: options.sub ?? null,
    caption: label,
    meta: "Median of 5 runs. Lower is better",
    lowerIsBetter,
    call: {
      lost: false,
      kicker: label,
      figure,
      word: options.word,
      line: options.line ?? "faster than Dia",
      second: null,
    },
    bars: measured
      .sort((a, b) => (lowerIsBetter ? a.median - b.median : b.median - a.median))
      .map((b) => ({
        name: b.name,
        isArdia: b.name === "Ardia",
        isBest: b.median === best,
        share: b.median / top,
        value: { value: b.median, decimals: 0, from: 0, suffix: "" },
        unit,
        range: null,
        n: 5,
      })),
    lead: options.lead ?? 1,
  };
}

const single = (r: Row): Group => ({ id: r.id, label: r.label, rows: [r] });

const bench: Bench = {
  sample: true,
  date: "Nov 13, 2026",
  measured: "2026-11-13",
  dated: null,
  span: "2026-11-13",
  machine: "Mac mini",
  versions: "Ardia, Dia, Helium",
  elsewhere: null,
  rivals: ["Dia", "Helium"],
  groups: [
    single(row("speedometer", "Speedometer 3", "points", [59.1, 58.2, 58.55], { lowerIsBetter: false, figure: { value: 1, decimals: 0, suffix: "%" }, line: "faster than Dia" })),
    single(row("newtab", "New tab → first paint", "ms", [63, 89.7, 69.5])),
    {
      id: "power-with-11-tabs-open",
      label: "Power with 11 tabs open",
      rows: [
        row("power-idle-visible", "Idle, window in view", "mW", [3.5, 848, 4], { sub: "Idle, window in view", figure: { value: 242, decimals: 0, suffix: "×" }, line: "less power than Dia", lead: 5.49 }),
        row("power-idle-hidden", "Idle, window hidden", "mW", [3.9, 1223, 3.1], { sub: "Idle, window hidden", figure: { value: 313, decimals: 0, suffix: "×" }, line: "less power than Dia", lead: 5.75 }),
        row("power-scroll", "Scrolling", "mW", [28.2, 626, 51.9], { sub: "Scrolling", figure: { value: 22, decimals: 0, suffix: "×" }, line: "less power than Dia", lead: 3.1 }),
      ],
    },
    {
      id: "idle-cpu",
      label: "Idle CPU",
      rows: [
        row("idle-cpu-1", "Idle CPU, 1 tab", "%", [0.25, 0.9, 0.2], { sub: "1 tab", figure: { value: 3.6, decimals: 1, suffix: "×" }, line: "less CPU than Dia", lead: 1.28 }),
        row("idle-cpu-20", "Idle CPU, 20 tabs", "%", [0.77, 1.14, 1.33], { sub: "20 tabs", figure: { value: 32, decimals: 0, suffix: "%" }, line: "less CPU than Dia", lead: 0.39 }),
      ],
    },
    {
      id: "memory",
      label: "Memory",
      rows: [
        row("memory-1", "Memory, 1 tab", "MB", [240, 361, 331], { sub: "1 tab", figure: { value: 1.5, decimals: 1, suffix: "×" }, line: "less memory than Dia", lead: 0.41 }),
        row("memory-20", "Memory, 20 tabs", "MB", [734, 1002, 787], { sub: "20 tabs", figure: { value: 26, decimals: 0, suffix: "%" }, line: "less memory than Dia", lead: 0.31 }),
      ],
    },
    single(row("launch-restore", "Cold launch → restored tab painted", "ms", [351, null, 460], { figure: null, word: "N/A", line: "Dia opens to its start screen" })),
    single(row("launch-link", "Cold launch → page painted (link opened from another app)", "ms", [515, 2603, 527])),
    single(row("switch", "Tab switch → shown", "ms", [13, 27.5, 15])),
  ],
};

const card = scorecardOf(bench);

test("tests gather into the four topic sections in order", () => {
  assert.deepEqual(
    card.sections.map((s) => s.title),
    ["Launch", "Tabs and windows", "Sitting still", "Engine"],
  );
  const sitting = card.sections.find((s) => s.id === "sitting-still")!;
  assert.deepEqual(
    sitting.tests.map((t) => t.title),
    ["Memory", "Idle CPU", "Power with 11 tabs open"],
  );
});

test("every measurement shows up exactly once", () => {
  const shown = card.sections.flatMap((s) => s.lines.map((l) => l.id)).sort();
  const measured = bench.groups.flatMap((g) => g.rows.map((r) => r.id)).sort();
  assert.deepEqual(shown, measured);
  assert.equal(card.total, measured.length);
});

test("the browsers sit in the same columns on every line, Ardia first", () => {
  for (const line of card.sections.flatMap((s) => s.lines)) {
    assert.deepEqual(line.cells.map((c) => c.name), NAMES);
    assert.equal(line.cells[0].isArdia, true);
  }
});

test("numbers in each test or multi-row group share their decimals", () => {
  for (const t of card.sections.flatMap((s) => s.tests)) {
    const decimals = new Set(
      t.lines.flatMap((l) => l.cells.flatMap((c) => (c.number ? [c.number.split(".")[1]?.length ?? 0] : []))),
    );
    assert.equal(decimals.size, 1, `${t.title} mixes decimals`);
  }
  const sitting = card.sections.find((s) => s.id === "sitting-still")!;
  const power = sitting.tests.find((t) => t.id === "power-with-11-tabs-open")!;
  assert.equal(power.lines[0].cells[1].display, "848.0");
  assert.equal(power.lines[1].cells[1].display, "1,223.0");
  const cpu = sitting.tests.find((t) => t.id === "idle-cpu")!;
  assert.equal(cpu.lines[0].cells[1].display, "0.90");
});

test("single-row tests include inline units and multi-row sub-rows omit them", () => {
  const launch = card.sections.find((s) => s.id === "launch")!;
  const link = launch.lines.find((l) => l.id === "launch-link")!;
  assert.equal(link.cells[0].display, "515 ms");
  const engine = card.sections.find((s) => s.id === "engine")!;
  assert.equal(engine.lines[0].cells[0].display, "59.1 points");
  const sitting = card.sections.find((s) => s.id === "sitting-still")!;
  const memory = sitting.tests.find((t) => t.id === "memory")!;
  assert.equal(memory.unit, "MB");
  assert.equal(memory.lines[0].cells[0].display, "240");
});

test("higher-is-better tests start their bar scale at floor(min - 1)", () => {
  const engine = card.sections.find((s) => s.id === "engine")!;
  const speed = engine.lines[0];
  assert.equal(speed.cells[0].share, 1);
  assert.ok(Math.abs(speed.cells[1].share - (58.2 - 57) / (59.1 - 57)) < 1e-9);
  assert.ok(Math.abs(speed.cells[2].share - (58.55 - 57) / (59.1 - 57)) < 1e-9);
});

test("power bars stay strictly linear", () => {
  const sitting = card.sections.find((s) => s.id === "sitting-still")!;
  const power = sitting.tests.find((t) => t.id === "power-with-11-tabs-open")!;
  const hidden = power.lines.find((l) => l.id === "power-idle-hidden")!;
  assert.ok(Math.abs(hidden.cells[0].share - 3.9 / 1223) < 1e-9);
  assert.equal(hidden.cells[1].share, 1);
});

test("multi-row headlines pick the strongest Ardia win with context", () => {
  const sitting = card.sections.find((s) => s.id === "sitting-still")!;
  const memory = sitting.tests.find((t) => t.id === "memory")!;
  assert.equal(memory.headline.figure, "1.5×");
  assert.equal(memory.headline.line, "less memory than Dia");
  const cpu = sitting.tests.find((t) => t.id === "idle-cpu")!;
  assert.equal(cpu.headline.figure, "32%");
  assert.equal(cpu.headline.line, "less CPU than Dia at 20 tabs");
  const power = sitting.tests.find((t) => t.id === "power-with-11-tabs-open")!;
  assert.equal(power.headline.figure, "242×");
  assert.equal(power.headline.line, "less power than Dia at idle");
});

test("a browser that wasn't measured renders N/A and speaks not measured", () => {
  const restore = card.sections[0].lines.find((l) => l.id === "launch-restore")!;
  assert.equal(restore.cells[1].number, null);
  assert.equal(restore.cells[1].display, "N/A");
  assert.equal(restore.cells[1].spoken, "not measured");
});

test("a parenthetical becomes the line's detail", () => {
  const link = card.sections[0].lines.find((l) => l.id === "launch-link")!;
  assert.equal(link.label, "Cold launch → page painted");
  assert.equal(link.detail, "link opened from another app");
});
