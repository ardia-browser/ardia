export function callNow(call: () => Promise<unknown>) {
  try {
    void call().catch(() => undefined);
  } catch {
    return;
  }
}
