import assert from "node:assert/strict";
import { test } from "node:test";
import { noteCaptureCancelled, noteCaptureCopied, noteCaptureFailed, noteCaptureStarted, takeCaptureCounts } from "./captureCounts.ts";

test("captures are counted by how they ended, and taking them starts over", () => {
  noteCaptureStarted();
  noteCaptureStarted();
  noteCaptureStarted();
  noteCaptureCopied(false);
  noteCaptureCopied(true);
  noteCaptureCancelled();
  noteCaptureFailed();
  assert.deepEqual(takeCaptureCounts(), { capture_starts: 3, capture_copies: 2, capture_copies_in_split: 1, capture_cancels: 1, capture_failures: 1 });
  assert.deepEqual(takeCaptureCounts(), { capture_starts: 0, capture_copies: 0, capture_copies_in_split: 0, capture_cancels: 0, capture_failures: 0 });
});
