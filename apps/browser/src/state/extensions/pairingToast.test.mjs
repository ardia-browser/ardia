import assert from "node:assert/strict";
import { test } from "node:test";

const { pairingToastActions } = await import("./pairingToast.ts");
const { useToasts, showToast, hideToast } = await import("../app/toasts.ts");

const shownAndDismissed = (appPath, opened) => {
  showToast("w", "Connect to the 1Password app", "steps", { sticky: true, key: "passwordAppPairing", ...pairingToastActions(appPath, (path) => opened.push(path)) });
  const toast = useToasts.getState().toasts.w;
  const dismiss = [toast.action, toast.secondary].find((x) => x?.title === "Dismiss");
  assert.ok(dismiss, "a sticky pairing note always has a Dismiss button");
  dismiss.run();
  hideToast("w", toast.id);
  return { toast, left: useToasts.getState().toasts.w };
};

test("on a Mac the note offers Open 1Password and Dismiss, and Dismiss closes it without opening the app", () => {
  const opened = [];
  const { toast, left } = shownAndDismissed("/Applications/1Password.app", opened);
  assert.equal(toast.action.title, "Open 1Password");
  assert.equal(toast.secondary.title, "Dismiss");
  assert.deepEqual(opened, []);
  assert.equal(left, null);
  pairingToastActions("/Applications/1Password.app", (path) => opened.push(path)).action.run();
  assert.deepEqual(opened, ["/Applications/1Password.app"]);
});

test("on Linux, with no app to open, the note's only button is Dismiss and it closes the note", () => {
  const opened = [];
  const { toast, left } = shownAndDismissed(null, opened);
  assert.equal(toast.action.title, "Dismiss");
  assert.equal(toast.secondary, undefined);
  assert.deepEqual(opened, []);
  assert.equal(left, null);
});
