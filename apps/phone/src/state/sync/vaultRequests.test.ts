import assert from "node:assert/strict";
import { test } from "node:test";
import { askedBy, nextVaultRequest, sheetLatencyMs, siteName, timeLeft, type VaultRequest } from "./vaultRequests.ts";

const request = (id: string, expiresAt: number, fromDevice: string | null = "MacBook Pro"): VaultRequest => ({ id, program: "node, unsigned", sites: ["https://github.com"], why: "", profileName: "Personal", alwaysOffered: false, askedAt: 1_000, expiresAt, fromDeviceId: "mac", fromDevice });

test("the sheet shows the oldest request that hasn't expired or been set aside", () => {
  const requests = [request("a", 500), request("b", 5_000), request("c", 9_000)];
  assert.equal(nextVaultRequest(requests, new Set(), 1_000)?.id, "b");
  assert.equal(nextVaultRequest(requests, new Set(["b"]), 1_000)?.id, "c");
  assert.equal(nextVaultRequest(requests, new Set(), 9_000), null);
  assert.equal(nextVaultRequest(undefined, new Set(), 0), null);
});

test("sites, time left and who asked read plainly", () => {
  assert.equal(siteName("https://accounts.example:8443"), "accounts.example:8443");
  assert.equal(timeLeft(59_001), "1:00");
  assert.equal(timeLeft(58_001), "59 s");
  assert.equal(timeLeft(125_000), "2:05");
  assert.equal(timeLeft(-5), "0 s");
  assert.equal(askedBy(request("a", 1)), "MacBook Pro · Personal");
  assert.equal(askedBy({ ...request("a", 1, null), profileName: "" }), "your Mac");
  assert.equal(sheetLatencyMs(request("a", 1), 4_250), 3_250);
  assert.equal(sheetLatencyMs(request("a", 1), 0), 0);
});
