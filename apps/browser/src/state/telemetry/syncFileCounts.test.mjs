import assert from "node:assert/strict";
import { test } from "node:test";

const { noteSyncOpenFailures, takeSyncFileCounts } = await import("./syncFileCounts.ts");
const { consentToken, setConsentPeriod } = await import("./consentPeriod.ts");

test("a host's open failures count only under the consent period their call began in, and reset once taken", () => {
  takeSyncFileCounts();
  assert.deepEqual(takeSyncFileCounts(), {}, "no host failures and no native counts send no fields");
  noteSyncOpenFailures(null, { authentication: 3 });
  setConsentPeriod(true, "sync-on");
  const started = consentToken();
  noteSyncOpenFailures(started, { format: 1, authentication: 2, too_large: 0, other: 1 });
  noteSyncOpenFailures(started, { too_large: 1, format: -4, other: 1.5 });
  setConsentPeriod(true, "sync-next");
  noteSyncOpenFailures(started, { authentication: 9 });
  setConsentPeriod(false, null);
  assert.deepEqual(takeSyncFileCounts(), {
    sync_open_failures_format: 1,
    sync_open_failures_authentication: 2,
    sync_open_failures_too_large: 1,
    sync_open_failures_other: 1,
  });
  assert.deepEqual(takeSyncFileCounts(), {});
});
