import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const model = await import("../browser/model.ts");
const { usePages } = await import("../tabs/pageState.ts");
const { startPermissionPrompts, answerPermission } = await import("./permissions.ts");
const { takeNotificationRequestCounts } = await import("../telemetry/notificationRequestCounts.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const shown = (tabId) => usePages.getState().pages[tabId]?.permission?.id ?? null;

test("Block requests to send notifications turns a notifications-only request down without asking, and remembers the block", async () => {
  startPermissionPrompts();
  const w = S().createWindow({ url: "https://news.example/" });
  const t = model.activeTabId(S(), w);
  stub.resolvedPermissions.length = 0;
  takeNotificationRequestCounts();

  stub.emitPermission({ id: "n1", tabId: t, origin: "https://news.example", permissions: ["notifications"] });
  await tick();
  assert.equal(shown(t), "n1");
  assert.deepEqual(stub.resolvedPermissions, []);
  answerPermission(t, "n1", "dismiss");

  S().updateSettings({ blockNotificationRequests: true });
  stub.emitPermission({ id: "n2", tabId: t, origin: "https://news.example", permissions: ["notifications"] });
  await tick();
  assert.equal(shown(t), null);
  assert.deepEqual(stub.resolvedPermissions.at(-1), { id: "n2", result: "deny", remember: true });
  assert.deepEqual(takeNotificationRequestCounts(), { notification_requests_auto_denied: 1 });

  stub.emitPermission({ id: "c1", tabId: t, origin: "https://news.example", permissions: ["notifications", "camera"] });
  await tick();
  assert.equal(shown(t), "c1");
  answerPermission(t, "c1", "dismiss");
  stub.emitPermission({ id: "c2", tabId: t, origin: "https://news.example", permissions: ["camera"] });
  await tick();
  assert.equal(shown(t), "c2");
  answerPermission(t, "c2", "dismiss");
  assert.deepEqual(takeNotificationRequestCounts(), { notification_requests_auto_denied: 0 });

  S().updateSettings({ blockNotificationRequests: false });
  stub.emitPermission({ id: "n3", tabId: t, origin: "https://news.example", permissions: ["notifications"] });
  await tick();
  assert.equal(shown(t), "n3");
});
