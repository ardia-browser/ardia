import { measure } from "./_47n7.mjs";

const SEED = `const L = ac.live.store;
const profileId = st().windows[W].profileId;
if (L.setAccount) L.setAccount("github", { login: "ava", name: null, avatar: null, connectedAt: Date.now() });
const folder = L.createFolder(profileId, "pullRequests");
const pr = (n, repo, title) => ({ id: "gh:" + repo + "#" + n, source: "github", url: "http://docpad.example/pr/" + n, title, subtitle: repo + " #" + n, icon: null, updatedAt: Date.now() - n * 60000, section: "authored",
  pr: { number: n, repo, author: "ava", authorAvatar: null, draft: false, headRef: "x", baseRef: "main", review: null, mergeable: "mergeable", checks: [{ name: "ci", state: "success", url: null }], comments: 0, unresolvedThreads: 0, additions: 12, deletions: 3, changedFiles: 2 } });
L.applyFetch(folder, [pr(412, "acme/web", "Checkout: one-tap Apple Pay"), pr(407, "acme/api", "Rate limits per API key")], {});
L.updateFolder(folder, { collapsed: true });`;

export default {
  session: "session-0247n7-press.json",
  env: { FIXES_SELFREC_CROP: "0,100,262,380" },
  minWidth: 250,
  setup: `${SEED}
return sleep(2500).then(() => done({ folder }));`,
  prepare: (instance) => measure(instance, ["gtrip", "gfood"]),
  act: `return at(640, 520).then(() => sleep(400)).then(() => { mark("go"); return sleep(4200); })
  .then(() => done());`,
  tail: 500,
};
