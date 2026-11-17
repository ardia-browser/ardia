import assert from "node:assert/strict";
import { test } from "node:test";
import { permissionSummary, sortedPermissions } from "./sitePermissionNames.ts";

test("a site's allowed permissions read in main's order and as an English list, as main's grant summary does", () => {
  assert.equal(permissionSummary(["location"]), "Location");
  assert.equal(permissionSummary(["microphone", "camera"]), "Camera and Microphone");
  assert.equal(permissionSummary(["location", "camera", "microphone"]), "Camera, Microphone, and Location");
  assert.deepEqual(sortedPermissions(["location", "camera"]), ["camera", "location"]);
  assert.equal(permissionSummary([]), "");
});
