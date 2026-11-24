import assert from "node:assert/strict";
import { test } from "node:test";
const { motionStep, pageCover, restStep, tallPage } = await import("./toolbarMotion.ts");

test("hiding: the layout jumps to the strip at once and the page, bar and controls glide up together", () => {
  assert.deepEqual(motionStep("shown", "collapsed", false), { set: { laid: 1 }, glide: { page: 1, bar: 1, fade: 1 }, show: false, fit: null });
});

test("showing mirrors hiding and fits the page under the bar once the glide ends", () => {
  assert.deepEqual(motionStep("collapsed", "shown", false), { set: { laid: 0 }, glide: { page: 0, bar: 0, fade: 0 }, show: true, fit: "afterGlide" });
  assert.deepEqual(motionStep("peek", "shown", false), { set: { laid: 0 }, glide: { page: 0, bar: 0, fade: 0 }, show: true, fit: "afterGlide" });
});

test("a peek from the shown bar keeps the page's room and shows the controls", () => {
  assert.deepEqual(motionStep("shown", "peek", false), { set: { laid: 1 }, glide: { page: 1, bar: 0, fade: 0 }, show: false, fit: null });
});

test("peeking from the strip shows the bar over the page in one frame, and leaving the peek glides it away", () => {
  assert.deepEqual(motionStep("collapsed", "peek", false), { set: { bar: 0, fade: 0 }, glide: {}, show: false, fit: null });
  assert.deepEqual(motionStep("peek", "collapsed", false), { set: {}, glide: { bar: 1, fade: 1 }, show: false, fit: null });
});

test("Reduce Motion: the page and band move at once and only the controls fade", () => {
  assert.deepEqual(motionStep("shown", "collapsed", true), { set: { laid: 1, page: 1, bar: 1 }, glide: { fade: 1 }, show: false, fit: null });
  assert.deepEqual(motionStep("collapsed", "shown", true), { set: { laid: 0, page: 0, bar: 0 }, glide: { fade: 0 }, show: true, fit: "now" });
  assert.deepEqual(motionStep("peek", "collapsed", true), { set: { bar: 1 }, glide: { fade: 1 }, show: false, fit: null });
  assert.deepEqual(motionStep("collapsed", "peek", true), { set: { bar: 0, fade: 0 }, glide: {}, show: false, fit: null });
});

test("no change of mode moves nothing", () => {
  for (const mode of ["shown", "peek", "collapsed"]) assert.equal(motionStep(mode, mode, false), null);
});

test("the page grows to the strip's size in the render that first collapses the bar", () => {
  const was = { on: false, doc: "a" };
  assert.deepEqual(tallPage(was, { enabled: true, collapsed: true, doc: "a" }), { on: true, doc: "a" });
  assert.equal(tallPage(was, { enabled: true, collapsed: false, doc: "a" }), was);
  assert.equal(tallPage(was, { enabled: false, collapsed: true, doc: "a" }), was);
});

test("the page stays tall while the bar shows again, until the show is done", () => {
  const tall = { on: true, doc: "a" };
  assert.equal(tallPage(tall, { enabled: true, collapsed: false, doc: "a" }), tall);
  assert.equal(tallPage(tall, { enabled: true, collapsed: true, doc: "a" }), tall);
});

test("a new document or turning hiding off fits the page at once", () => {
  const tall = { on: true, doc: "a" };
  assert.deepEqual(tallPage(tall, { enabled: true, collapsed: false, doc: "b" }), { on: false, doc: "b" });
  assert.deepEqual(tallPage(tall, { enabled: false, collapsed: false, doc: "a" }), { on: false, doc: "a" });
  assert.deepEqual(tallPage(tall, { enabled: true, collapsed: true, doc: "b" }), { on: true, doc: "b" });
});

const STRIP = 20;
const MODES = ["shown", "peek", "collapsed"];

function paneAt({ row, extra }, mode, values) {
  const room = row + extra - STRIP;
  const layoutTop = (mode === "shown" ? row + extra : STRIP) - extra;
  const pageTop = layoutTop + (values.laid - values.page) * room;
  const barBottom = row - values.bar * (row - STRIP);
  const line = pageCover({ row, extra, strip: STRIP });
  const cover = Math.min(line.room, Math.max(0, line.perPage * values.page + line.perBar * values.bar));
  return { pageTop, barBottom, coverBottom: pageTop + cover, cover };
}

function stepThrough(values, step, progress) {
  const next = { ...values, ...step.set };
  for (const [name, to] of Object.entries(step.glide)) next[name] = next[name] + (to - next[name]) * progress;
  return next;
}

const SIZES = [
  { row: 41, extra: 0 },
  { row: 28, extra: 0 },
  { row: 41, extra: 30 },
];

test("the card over the page ends where the bar ends, through every glide and every reversal mid-glide", () => {
  for (const size of SIZES)
    for (const reduce of [false, true])
      for (const from of MODES)
        for (const to of MODES)
          for (const back of MODES) {
            const first = motionStep(from, to, reduce);
            if (!first) continue;
            const rest = restStep(from).set;
            for (const cut of [0.25, 0.5, 0.75, 1]) {
              const midway = stepThrough(rest, first, cut);
              const second = motionStep(to, back, reduce);
              for (const progress of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
                const [mode, values] = second ? [back, stepThrough(midway, second, progress)] : [to, stepThrough(rest, first, progress)];
                const at = paneAt(size, mode, values);
                const where = `${JSON.stringify(size)} ${from}->${to}${second ? `->${back}` : ""} cut ${cut} at ${progress}${reduce ? " reduced" : ""}`;
                if (at.barBottom > at.pageTop) assert.ok(Math.abs(at.coverBottom - at.barBottom) < 1e-9, `${where}: card ends at ${at.coverBottom}, bar at ${at.barBottom}`);
                else assert.equal(at.cover, 0, `${where}: card over a page the bar doesn't reach`);
              }
            }
          }
});

test("at rest the card covers the whole bar while peeking, the bookmarks bar under the strip, and nothing under a shown bar", () => {
  for (const size of SIZES) {
    const cover = (mode) => paneAt(size, mode, restStep(mode).set).cover;
    assert.equal(cover("peek"), size.row + size.extra - STRIP);
    assert.equal(cover("collapsed"), size.extra);
    assert.equal(cover("shown"), 0);
  }
});

test("turning hiding on or off puts every value at rest for the mode at once, so nothing is left mid-glide", () => {
  assert.deepEqual(restStep("shown"), { set: { laid: 0, page: 0, bar: 0, fade: 0 }, glide: {}, show: true, fit: "now" });
  assert.deepEqual(restStep("peek"), { set: { laid: 1, page: 1, bar: 0, fade: 0 }, glide: {}, show: false, fit: null });
  assert.deepEqual(restStep("collapsed"), { set: { laid: 1, page: 1, bar: 1, fade: 1 }, glide: {}, show: false, fit: null });
});
