const WAIT_ONLY = Symbol("waitOnly");
const MISSED_IDLE = Symbol("missedIdle");

type SyncNow = (stillWanted: () => void) => Promise<boolean>;

export async function syncIdle(syncNow: SyncNow): Promise<void> {
  try {
    await syncNow(() => {
      throw WAIT_ONLY;
    });
  } catch (error) {
    if (error !== WAIT_ONLY) throw error;
  }
}

export async function syncNowIfIdle(syncNow: SyncNow): Promise<boolean | "busy"> {
  let waited = false;
  const started = syncNow(() => {
    if (waited) throw MISSED_IDLE;
  });
  waited = true;
  try {
    return await started;
  } catch (error) {
    if (error === MISSED_IDLE) return "busy";
    throw error;
  }
}

export async function syncNowThrough(waitIdle: () => Promise<unknown>, startIfIdle: () => Promise<unknown>, stillWanted: () => void): Promise<boolean> {
  for (;;) {
    stillWanted();
    await waitIdle();
    stillWanted();
    const result = await startIfIdle();
    if (result !== "busy") return result !== false;
  }
}
