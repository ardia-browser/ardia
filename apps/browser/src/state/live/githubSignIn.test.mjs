import assert from "node:assert/strict";
import { test } from "node:test";

const { live } = await import("./store.ts");
const { createFolder, removeFolder, setStatus } = await import("./store.ts");
const { openGithubSignIn } = await import("./engine.ts");
const { useBrowser } = await import("../browser/store.ts");
const { takeLiveGithubSessionCounts } = await import("../telemetry/liveGithubSession.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "github-sign-in-test");

const S = () => useBrowser.getState();

test("the signed-out action opens github.com's sign-in page in a window of the folder's profile", () => {
  S().hydrate({});
  const work = S().createProfile({ name: "Work" });
  const w = S().createWindow({ profileId: work, url: "https://example.test/" });
  const folderId = createFolder(work, "pullRequests", ["github"]);
  setStatus(folderId, { state: "error", error: { kind: "signedOut", message: "Sign in to github.com in this profile", source: "github" } });
  takeLiveGithubSessionCounts();
  assert.equal(openGithubSignIn(work), true);
  const tab = S().tabs[S().windows[w].activeTabIds[work]];
  assert.equal(tab.url, "https://github.com/login");
  assert.equal(tab.profileId, work);
  assert.equal(takeLiveGithubSessionCounts().live_github_sign_in_opens, 1);
  removeFolder(folderId);
  S().deleteProfile(work);
  assert.equal(live().folders[folderId], undefined);
});

test("with no window showing the profile, the action does nothing", () => {
  S().hydrate({});
  const other = S().createProfile({ name: "Other" });
  S().createWindow({ url: "https://example.test/" });
  assert.equal(openGithubSignIn(other), false);
  S().deleteProfile(other);
});
