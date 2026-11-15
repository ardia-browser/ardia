const NONE = { starts: 0, copies: 0, copiesInSplit: 0, cancels: 0, failures: 0 };
let counts = { ...NONE };

export const noteCaptureStarted = () => void counts.starts++;
export const noteCaptureCancelled = () => void counts.cancels++;
export const noteCaptureFailed = () => void counts.failures++;

export function noteCaptureCopied(inSplit: boolean) {
  counts.copies++;
  if (inSplit) counts.copiesInSplit++;
}

export function takeCaptureCounts() {
  const taken = {
    capture_starts: counts.starts,
    capture_copies: counts.copies,
    capture_copies_in_split: counts.copiesInSplit,
    capture_cancels: counts.cancels,
    capture_failures: counts.failures,
  };
  counts = { ...NONE };
  return taken;
}
