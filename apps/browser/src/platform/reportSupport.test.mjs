import assert from "node:assert/strict";
import { test } from "node:test";

let uploadReply = null;
globalThis.acTestNativeModules = {
  ...globalThis.acTestNativeModules,
  ArdiaReport: { upload: async () => uploadReply },
};

const mac = await import("./reportSupport.ts");
const { sendsReportFiles, recordsReports, setReportPlatform, uploadFile } = await import("./report.ts");

test("a platform without a native report uploader or recorder sends reports without files", () => {
  assert.deepEqual(mac.REPORT_SUPPORT, { recording: true, files: true });
  assert.equal(sendsReportFiles(), true);
  assert.equal(recordsReports(), true);
  setReportPlatform({ recording: false });
  assert.equal(sendsReportFiles(), true);
  setReportPlatform({ recording: false, files: false });
  assert.equal(sendsReportFiles(), false);
  setReportPlatform(mac.REPORT_SUPPORT);
});

test("an uploader that answers nothing reads as a failed upload, not a crash", async () => {
  uploadReply = null;
  assert.deepEqual(await uploadFile("a", "https://x/y", "PUT", {}, "/p"), { status: 0, body: "", error: "no uploader" });
  uploadReply = { status: 413, body: "{}", error: null };
  assert.deepEqual(await uploadFile("a", "https://x/y", "PUT", {}, "/p"), { status: 413, body: "{}", error: null });
  uploadReply = { status: 0, body: "", error: "The network connection was lost." };
  assert.equal((await uploadFile("a", "https://x/y", "PUT", {}, "/p")).error, "The network connection was lost.");
});
