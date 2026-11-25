import assert from "node:assert/strict";
import test from "node:test";
import { forgetWarmPictures, noteViewMoved, noteWarmDecoded, noteWarmPicture, useWarmRevision, warmDecoded, warmPicture } from "./warmPictures.ts";

const window = { width: 393, height: 873 };
const frame = { x: 0, y: 0, width: 393, height: 873 };
const tab = (id: string, url = "https://example.com/", snapshotFileName: string | null = `file:///${id}.jpg`) => ({ id, url, snapshotFileName });
const capture = (id: string, view = 4, viewId = 7) => ({ uri: `file:///${id}.jpg`, url: "https://example.com/", window, frame, settled: true, view, viewId });

test("a picture is warm at its captured geometry while its view hasn't moved since the capture", () => {
  noteWarmPicture("a", capture("a"));
  assert.deepEqual(warmPicture(tab("a"), window), { uri: "file:///a.jpg", frame });
  forgetWarmPictures(["a"]);
});

test("a move reported before the snapshot is published still rejects it", () => {
  noteViewMoved("b", 7, 5);
  noteWarmPicture("b", capture("b", 4));
  assert.equal(warmPicture(tab("b"), window), null);
  forgetWarmPictures(["b"]);
});

test("a late report of a move older than the capture doesn't invalidate it, and a newer one does", () => {
  noteWarmPicture("c", capture("c", 6));
  noteViewMoved("c", 7, 5);
  assert.notEqual(warmPicture(tab("c"), window), null);
  noteViewMoved("c", 7, 7);
  assert.equal(warmPicture(tab("c"), window), null);
  forgetWarmPictures(["c"]);
});

test("a replaced WebView makes every picture of the old one cold", () => {
  noteWarmPicture("d", capture("d", 4, 7));
  noteViewMoved("d", 8, 1);
  assert.equal(warmPicture(tab("d"), window), null);
  forgetWarmPictures(["d"]);
});

test("each change bumps the reactive revision so a mounted neighbour re-reads it", () => {
  const before = useWarmRevision.getState().revision;
  noteWarmPicture("e", capture("e"));
  noteViewMoved("e", 7, 9);
  assert.equal(useWarmRevision.getState().revision, before + 2);
  forgetWarmPictures(["e"]);
});

test("a capture that moved while taken, has no identity, or was taken mid-gesture is never warm", () => {
  noteWarmPicture("f", { ...capture("f"), settled: false });
  assert.equal(warmPicture(tab("f"), window), null);
  noteWarmPicture("f", { ...capture("f"), viewId: undefined });
  assert.equal(warmPicture(tab("f"), window), null);
  noteWarmPicture("f", { ...capture("f"), frame: { x: 75, y: 19, width: 393, height: 873 } });
  assert.equal(warmPicture(tab("f"), window), null);
  noteWarmPicture("f", { ...capture("f"), frame: { x: 0, y: 10, width: 340, height: 760 } });
  assert.equal(warmPicture(tab("f"), window), null);
});

test("a rotated window, another address, a different picture or a closed tab makes it cold", () => {
  noteWarmPicture("g", capture("g"));
  assert.equal(warmPicture(tab("g"), { width: window.height, height: window.width }), null);
  assert.equal(warmPicture(tab("g", "https://example.com/next"), window), null);
  assert.equal(warmPicture(tab("g", "https://example.com/", "file:///other.jpg"), window), null);
  forgetWarmPictures(["g"]);
  assert.equal(warmPicture(tab("g"), window), null);
});

test("a face remounted after its hand-over knows its warm picture was already decoded, only for that tab's latest picture, until the tab is forgotten", () => {
  assert.equal(warmDecoded("d", "file:///d.jpg"), false);
  noteWarmDecoded("d", "file:///d.jpg");
  assert.equal(warmDecoded("d", "file:///d.jpg"), true);
  assert.equal(warmDecoded("d", "file:///d2.jpg"), false);
  assert.equal(warmDecoded("e", "file:///d.jpg"), false);
  noteWarmDecoded("d", "file:///d2.jpg");
  assert.equal(warmDecoded("d", "file:///d.jpg"), false);
  forgetWarmPictures(["d"]);
  assert.equal(warmDecoded("d", "file:///d2.jpg"), false);
});
