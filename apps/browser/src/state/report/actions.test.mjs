import assert from "node:assert/strict";
import { test } from "node:test";

const LOCAL = "/tmp/report-test/export/local-events.jsonl.gz";
const sizes = new Map();
const puts = [];
let refusePut = () => false;
let onPut = () => {};
let noUploader = false;
globalThis.acTestNativeModules = {
  ...globalThis.acTestNativeModules,
  ArdiaReport: {
    fileSize: (path) => sizes.get(path) ?? -1,
    removeFile: () => {},
    cancelUploads: () => {},
    addListener: () => ({ remove() {} }),
    upload: async (id, url, method, headers, path) => {
      const declared = declaredSizes.get(url.split("/files/")[0].split("/").pop())?.[id];
      puts.push({ id, url, declared, bytes: sizes.get(path) });
      onPut();
      if (noUploader) return null;
      if (refusePut() || declared !== sizes.get(path)) return { status: 413, body: JSON.stringify({ error: "size_mismatch" }), error: null };
      return { status: 200, body: "{}", error: null };
    },
  },
};

const declaredSizes = new Map();
let nextId = 0;
const { setReportPlatform } = await import("../../platform/report.ts");
setReportPlatform({
  post: async (url, body) => {
    if (url.endsWith("/complete")) {
      const id = url.split("/").at(-2);
      return { status: 200, text: JSON.stringify({ id, name: "Brave Otter", issue_url: null }) };
    }
    const id = `FB-T${++nextId}`;
    const payload = JSON.parse(body);
    declaredSizes.set(id, Object.fromEntries(payload.attachments.map((a) => [a.name, a.bytes])));
    const upload_urls = Object.fromEntries(payload.attachments.map((a) => [a.name, `https://ardia.dev/api/feedback/${id}/files/${a.name}`]));
    return { status: 201, text: JSON.stringify({ id, name: "Brave Otter", upload_token: "tok", upload_urls }) };
  },
});
const { sendCurrentReport } = await import("./actions.ts");
const { currentReport, patchReport, patchDraft, initialReportState } = await import("./store.ts");

test("a restart after a refused resume declares the local events as they are on disk now, not as they were when Send was pressed", async () => {
  sizes.set(LOCAL, 100);
  patchDraft({ title: "Tabs vanish", description: "After a restart" });
  patchReport({ windowId: "w1", local: { path: LOCAL, bytes: 100, lines: 5 } });
  const created = { id: "FB-OLD", name: "Brave Otter", token: "tok", uploadUrls: { "local-events.jsonl.gz": "https://ardia.dev/api/feedback/FB-OLD/files/local-events.jsonl.gz" }, uploaded: [], declared: { "local-events.jsonl.gz": 100 } };
  declaredSizes.set("FB-OLD", { "local-events.jsonl.gz": 100 });
  patchReport({ upload: { phase: "failed", stage: "upload", message: "x", created, errorClass: "server", status: 502, attempts: 3 } });
  refusePut = () => puts.length === 1;
  onPut = () => {
    if (puts.length === 1) {
      sizes.set(LOCAL, 140);
      patchReport({ local: { path: LOCAL, bytes: 140, lines: 7 } });
    }
  };
  await sendCurrentReport();
  assert.equal(puts[0].url.includes("FB-OLD"), true);
  assert.equal(puts.length, 2);
  assert.deepEqual({ declared: puts[1].declared, bytes: puts[1].bytes }, { declared: 140, bytes: 140 });
  assert.equal(currentReport().sent?.id, "FB-T1");
});

test("a missing native uploader fails the upload as unsupported at once, never as offline after three tries", async () => {
  const { useReportSheet } = await import("./store.ts");
  useReportSheet.setState(initialReportState());
  sizes.set(LOCAL, 100);
  refusePut = () => false;
  onPut = () => {};
  noUploader = true;
  const before = puts.length;
  try {
    patchDraft({ title: "Can't send", description: "Report a Problem says offline" });
    patchReport({ windowId: "w1", local: { path: LOCAL, bytes: 100, lines: 5 } });
    await sendCurrentReport();
  } finally {
    noUploader = false;
  }
  const upload = currentReport().upload;
  assert.equal(upload.phase, "failed");
  assert.equal(upload.stage, "upload");
  assert.equal(upload.errorClass, "unsupported");
  assert.equal(upload.attempts, 1);
  assert.equal(puts.length - before, 1);
  assert.doesNotMatch(upload.message, /connection/);
});
