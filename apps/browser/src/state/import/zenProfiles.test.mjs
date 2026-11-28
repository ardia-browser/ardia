import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
globalThis.require = createRequire(import.meta.url);

const link = (url) => ({ type: "url", title: url.split("/").at(-1), url });
const folder = (title, urls) => ({ type: "folder", title, children: urls.map(link) });
const essential = (url, container) => ({ url, title: url, pinned: true, windowIndex: 0, active: false, ...(container ? { container } : {}) });
const space = (id, name, container, pinned) => ({ id, name, profileId: "", pinned, tabs: [], ...(container ? { container } : {}) });

const ZEN = {
  "Profiles/a.Personal": {
    separateEssentials: true,
    spaces: [
      space("work", "Work", 1, [link("https://work.example/pin")]),
      space("home", "Home", 0, [link("https://home.example/pin-1"), link("https://home.example/pin-2"), folder("Reading", ["https://home.example/read"])]),
      space("money", "Money", 2, [link("https://bank.example/pin")]),
      space("side", "Side", 0, [link("https://side.example/pin")]),
    ],
    favorites: [essential("https://mail.example/"), essential("https://chat.example/", 1), essential("https://bank.example/", 2), essential("https://gone.example/", 7)],
  },
  "Profiles/b.School": {
    spaces: [space("study", "Study", 0, [link("https://study.example/pin")]), space("lab", "Research", 1, [link("https://lab.example/pin")])],
    favorites: [essential("https://study.example/"), essential("https://lab.example/", 1)],
  },
};

let zen = ZEN;
const writtenCookies = [];
const discardedTokens = [];
const savedPasswords = [];
let onWriteCookie = null;
globalThis.acTestNativeModules = {
  ArdiaImport: {
    addListener: () => ({ remove() {} }),
    listBrowsers: async () => "[]",
    isBrowserUnlocked: () => true,
    forgetUnlockedKeys() {},
    cancelImport() {},
    listExtensions: async () => "[]",
    writeImported: async (token, profile, kinds) => {
      writtenCookies.push({ token, profile, kinds });
      const custom = onWriteCookie?.({ token, profile, kinds });
      return JSON.stringify(custom ?? { cookies: kinds.includes("cookies") ? 3 : 0, cookiesRejected: 0, cookiesExisting: 0, addresses: kinds.includes("autofill") ? 1 : 0, cards: 0 });
    },
    discardImported: (token) => {
      discardedTokens.push(token);
    },
    importData: async (_job, browserId, profileId, kinds, options) => {
      const p = zen[profileId];
      const includeSpaces = kinds.includes("spaces") || kinds.includes("tabs");
      const spaces = includeSpaces ? p.spaces.filter((s) => !options.spaceIds || options.spaceIds.includes(s.id)).map((s) => ({ ...s, profileId })) : [];
      return JSON.stringify({
        browserId, profileId, history: [], historyCount: 0, tabs: [], tabGroups: [],
        credentials: kinds.includes("passwords") ? (p.credentials ?? []) : [],
        cookieCount: kinds.includes("cookies") ? 9 : 0, addressCount: 0, cardCount: 0,
        ...((kinds.includes("cookies") || kinds.includes("autofill")) && p.vaultToken ? { vaultToken: p.vaultToken } : {}),
        ...(kinds.includes("cookies") && p.containerVaultTokens ? { containerVaultTokens: p.containerVaultTokens } : {}),
        ...(kinds.includes("cookies") && p.containerCookieCounts ? { containerCookieCounts: p.containerCookieCounts } : {}),
        spaces, favorites: kinds.includes("favorites") ? p.favorites : [], favicons: [], failed: [], warnings: [],
        ...(p.separateEssentials === undefined ? {} : { separateEssentials: p.separateEssentials }),
      });
    },
  },
};

const { ardiaCoreNativeModules } = await import("../../test-native/ardiacore.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");
ardiaCoreNativeModules.ArdiaPasswords.save = async (profile, origin, username) => {
  savedPasswords.push({ profile, origin, username });
  return true;
};

const { useBrowser } = await import("../browser/store.ts");
const { createProfile } = await import("../profiles/actions.ts");
const { cancelImport, startImport, useImportFlow } = await import("./flow.ts");
const { runImport } = await import("./runImport.ts");
const { dataIdOf } = await import("../profiles/profiles.ts");
const { engineProfile } = await import("../browser/model.ts");

const S = () => useBrowser.getState();
const source = (profiles) => ({
  id: "zen", name: "Zen", family: "firefox", sidebar: "zen", requiresExport: false, needsKeychain: false,
  profiles: profiles.map((id) => ({ id, name: id.split(".")[1], path: id, isDefault: id.startsWith("Profiles/a"), available: [], spaces: zen[id].spaces.map((s) => ({ ...s, pinnedCount: 1, tabCount: 0 })) })),
});

async function importZen(profiles, spaces, kinds = ["tabs", "favorites"]) {
  writtenCookies.length = 0;
  discardedTokens.length = 0;
  savedPasswords.length = 0;
  useBrowser.setState({ bookmarks: { nodes: {} } });
  S().hydrate({});
  S().createWindow({ url: "https://start.example/" });
  useImportFlow.setState({ source: source(profiles), sourceProfiles: profiles, spaces, target: "default", kinds: new Set(kinds), step: { name: "choose", error: null } });
  await runImport(new Set(kinds));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(useImportFlow.getState().step.name, "done");
}

const named = (name) => S().profileOrder.find((id) => S().profiles[id].name === name);
const pinsOf = (profileId, as) =>
  Object.values(S().tabs)
    .filter((t) => t.profileId === profileId && t.pin?.as === as)
    .map((t) => t.pinnedUrl)
    .sort();
const rowsOf = (name) => pinsOf(named(name) ?? "default", "row");
const tilesOf = (name) => pinsOf(named(name) ?? "default", "tile");
const groupLinks = (name) =>
  Object.values(S().groups)
    .filter((g) => g.pinned && g.profileId === (named(name) ?? "default"))
    .flatMap((g) => g.tabIds.map((id) => S().tabs[id].pinnedUrl ?? S().tabs[id].url));
const dataOf = (name) => dataIdOf(S().profiles[named(name) ?? "default"]);

const ALL = ["work", "home", "money", "side", "study", "lab"];

test("each Zen profile's spaces land in their own Ardia profiles, never all in the first one", async () => {
  await importZen(Object.keys(ZEN), ALL);
  assert.deepEqual(
    S().profileOrder.map((id) => S().profiles[id].name),
    [S().profiles.default.name, "Work", "Money", "Side", "Study", "Research"],
  );
  assert.deepEqual(rowsOf(S().profiles.default.name), ["https://home.example/pin-1", "https://home.example/pin-2"], "Home went into the target");
  assert.deepEqual(groupLinks(S().profiles.default.name), ["https://home.example/read"], "with its folder");
  assert.deepEqual(rowsOf("Work"), ["https://work.example/pin"]);
  assert.deepEqual(rowsOf("Money"), ["https://bank.example/pin"]);
  assert.deepEqual(rowsOf("Side"), ["https://side.example/pin"]);
  assert.deepEqual(rowsOf("Study"), ["https://study.example/pin"]);
  assert.deepEqual(rowsOf("Research"), ["https://lab.example/pin"]);
});

test("a space shares data with the spaces of its own Zen profile and container only", async () => {
  await importZen(Object.keys(ZEN), ALL);
  const home = dataIdOf(S().profiles.default);
  assert.equal(dataOf("Side"), home, "Side is in Home's container");
  for (const apart of ["Work", "Money", "Study", "Research"]) assert.notEqual(dataOf(apart), home, `${apart} keeps its own data`);
  assert.notEqual(dataOf("Study"), dataOf("Research"), "School's container space is apart from School's default one");
  assert.notEqual(dataOf("Work"), dataOf("Research"), "container 1 of one Zen profile is not container 1 of another");
});

test("Essentials follow their container, and every space of that container shows them", async () => {
  await importZen(Object.keys(ZEN), ALL);
  const home = S().profiles.default.name;
  assert.deepEqual(tilesOf(home), ["https://gone.example/", "https://mail.example/"], "a container with no space falls back to the default one");
  assert.deepEqual(tilesOf("Side"), ["https://gone.example/", "https://mail.example/"]);
  assert.deepEqual(tilesOf("Work"), ["https://chat.example/"]);
  assert.deepEqual(tilesOf("Money"), ["https://bank.example/"]);
  assert.deepEqual(tilesOf("Study"), ["https://study.example/"]);
  assert.deepEqual(tilesOf("Research"), ["https://lab.example/"]);
});

test("the later spaces of one container share its data and Top Apps", async () => {
  zen = { "Profiles/b.School": { spaces: [space("lab", "Research", 1, []), space("lab2", "Lab notes", 1, [])], favorites: [essential("https://lab.example/", 1)] } };
  await importZen(["Profiles/b.School"], ["lab", "lab2"]);
  zen = ZEN;
  assert.ok(S().profiles[named("Lab notes")].shareTopApps);
  assert.equal(dataOf("Lab notes"), dataIdOf(S().profiles.default));
});

test("with Essentials shared across containers in Zen, every container gets them", async () => {
  zen = { "Profiles/a.Personal": { ...ZEN["Profiles/a.Personal"], separateEssentials: false } };
  await importZen(["Profiles/a.Personal"], ["work", "home", "money", "side"]);
  zen = ZEN;
  const all = ["https://bank.example/", "https://chat.example/", "https://gone.example/", "https://mail.example/"];
  assert.deepEqual(tilesOf("Work"), all);
  assert.deepEqual(tilesOf("Money"), all);
  assert.deepEqual(tilesOf(S().profiles.default.name), all);
});

test("Essentials go to the chosen spaces of their container, and a container left out keeps its own", async () => {
  await importZen(["Profiles/a.Personal"], ["side"]);
  assert.deepEqual(rowsOf(S().profiles.default.name), ["https://side.example/pin"], "Side, Home's container mate, became the target");
  assert.deepEqual(tilesOf(S().profiles.default.name), ["https://gone.example/", "https://mail.example/"]);
  assert.equal(named("Work"), undefined);
  assert.ok(!Object.values(S().tabs).some((t) => t.pinnedUrl === "https://chat.example/"), "a container with no chosen space doesn't spill into another");
});

test("each Zen container space receives its own cookies and shared passwords, and unused tokens are discarded", async () => {
  zen = {
    "Profiles/a.Personal": {
      ...ZEN["Profiles/a.Personal"],
      vaultToken: "tok-0",
      containerVaultTokens: { "1": "tok-1", "2": "tok-2", "9": "tok-9" },
      containerCookieCounts: { "1": 3, "2": 3, "9": 4 },
      credentials: [{ url: "https://accounts.example.com", username: "user1", password: "pw1" }],
    },
  };
  await importZen(["Profiles/a.Personal"], ["home", "work", "money"], ["tabs", "cookies", "passwords"]);
  zen = ZEN;
  const eng = (name) => engineProfile(S(), named(name) ?? "default");
  assert.deepEqual(
    writtenCookies.map(({ token, profile }) => [token, profile]),
    [
      ["tok-0", eng(S().profiles.default.name)],
      ["tok-1", eng("Work")],
      ["tok-2", eng("Money")],
    ],
  );
  assert.deepEqual(discardedTokens, ["tok-9"]);
  assert.deepEqual(
    savedPasswords.map((p) => p.profile),
    [eng(S().profiles.default.name), eng("Work"), eng("Money")],
  );
  const done = useImportFlow.getState().step;
  assert.equal(done.counts.cookies, 9);
  assert.equal(done.counts.passwords, 1);
  assert.ok(done.notes.some((n) => n.includes("4 cookies from other Zen containers")), JSON.stringify(done.notes));
});

test("importing only a non-default Zen container writes that container's cookies and discards default container cookies", async () => {
  zen = {
    "Profiles/a.Personal": {
      ...ZEN["Profiles/a.Personal"],
      vaultToken: "tok-0",
      containerVaultTokens: { "1": "tok-1", "2": "tok-2" },
      credentials: [{ url: "https://accounts.example.com", username: "user1", password: "pw1" }],
    },
  };
  await importZen(["Profiles/a.Personal"], ["work"], ["tabs", "cookies", "passwords"]);
  zen = ZEN;
  assert.deepEqual(
    writtenCookies.map(({ token, profile }) => [token, profile]),
    [["tok-1", engineProfile(S(), "default")]],
  );
  assert.deepEqual(discardedTokens.sort(), ["tok-0", "tok-2"]);
  assert.deepEqual(savedPasswords.map((p) => p.profile), [engineProfile(S(), "default")]);

  zen = {
    "Profiles/a.Personal": {
      ...ZEN["Profiles/a.Personal"],
      vaultToken: "tok-0",
      containerVaultTokens: { "1": "tok-1", "2": "tok-2", "9": "tok-9" },
      containerCookieCounts: { "1": 3, "2": 3, "9": 1 },
    },
  };
  await importZen(["Profiles/a.Personal"], ["work", "money"], ["tabs", "cookies"]);
  zen = ZEN;
  assert.deepEqual(writtenCookies.map(({ token }) => token), ["tok-1", "tok-2"]);
  assert.deepEqual(discardedTokens.sort(), ["tok-0", "tok-9"]);
  assert.ok(useImportFlow.getState().step.notes.includes("1 cookie from other Zen containers wasn't imported."));
});

test("cookies and passwords without tabs keep existing profiles intact and route a single non-default container", async () => {
  zen = {
    "Profiles/a.Personal": {
      ...ZEN["Profiles/a.Personal"],
      vaultToken: "tok-0",
      containerVaultTokens: { "1": "tok-1", "2": "tok-2" },
      credentials: [{ url: "https://accounts.example.com", username: "user1", password: "pw1" }],
    },
  };
  await importZen(["Profiles/a.Personal"], ["work"], ["cookies", "passwords"]);
  assert.deepEqual(S().profileOrder, ["default"]);
  assert.equal(S().profiles.default.name, "Personal");
  assert.deepEqual(
    writtenCookies.map(({ token, profile }) => [token, profile]),
    [["tok-1", engineProfile(S(), "default")]],
  );
  assert.deepEqual(discardedTokens.sort(), ["tok-0", "tok-2"]);
  assert.deepEqual(savedPasswords.map((p) => p.profile), [engineProfile(S(), "default")]);

  await importZen(["Profiles/a.Personal"], ["home", "side"], ["cookies", "passwords"]);
  assert.deepEqual(S().profileOrder, ["default"]);
  assert.equal(S().profiles.default.name, "Personal");
  assert.deepEqual(writtenCookies.map(({ token }) => token), ["tok-0"]);
  assert.deepEqual(discardedTokens.sort(), ["tok-1", "tok-2"]);

  zen = {
    "Profiles/a.Personal": {
      ...ZEN["Profiles/a.Personal"],
      vaultToken: "tok-0",
      containerVaultTokens: { "1": "tok-1", "2": "tok-2" },
      containerCookieCounts: { "1": 3, "2": 5 },
    },
  };
  await importZen(["Profiles/a.Personal"], ["work", "money"], ["cookies"]);
  zen = ZEN;
  assert.deepEqual(writtenCookies, []);
  assert.deepEqual(discardedTokens.sort(), ["tok-0", "tok-1", "tok-2"]);
  assert.ok(useImportFlow.getState().step.notes.some((n) => n.includes("8 cookies from Zen containers weren't imported: include Tabs")));
});

test("deselecting every space of one Zen profile skips its cookies and passwords completely", async () => {
  zen = {
    "Profiles/a.Personal": {
      ...ZEN["Profiles/a.Personal"],
      vaultToken: "tok-a0",
      containerVaultTokens: { "1": "tok-a1" },
      credentials: [{ url: "https://a.example.com", username: "a", password: "pwA" }],
    },
    "Profiles/b.School": {
      ...ZEN["Profiles/b.School"],
      vaultToken: "tok-b0",
      containerVaultTokens: { "1": "tok-b1" },
      credentials: [{ url: "https://b.example.com", username: "b", password: "pwB" }],
    },
  };
  writtenCookies.length = 0;
  discardedTokens.length = 0;
  savedPasswords.length = 0;
  useBrowser.setState({ bookmarks: { nodes: {} } });
  S().hydrate({});
  S().createWindow({ url: "https://start.example/" });
  useImportFlow.setState({
    source: source(Object.keys(ZEN)),
    sourceProfiles: ["Profiles/a.Personal"],
    spaces: ["lab"],
    target: "default",
    kinds: new Set(["tabs", "cookies", "passwords"]),
    step: { name: "choose", error: null },
  });
  await runImport(new Set(["tabs", "cookies", "passwords"]));
  zen = ZEN;
  assert.deepEqual(writtenCookies.map(({ token }) => token), ["tok-b1"]);
  assert.deepEqual(discardedTokens, ["tok-b0"]);
  assert.deepEqual(savedPasswords.map((p) => p.username), ["b"]);
});

test("same-named spaces in different Zen containers stay in separate profiles with their own tabs, cookies and passwords", async () => {
  zen = {
    "Profiles/a.Personal": {
      spaces: [space("s0", "Same", 0, [link("https://a.example/")]), space("s1", "Same", 1, [link("https://b.example/")])],
      favorites: [],
      vaultToken: "tok-0",
      containerVaultTokens: { "1": "tok-1" },
      credentials: [{ url: "https://accounts.example.com", username: "user1", password: "pw1" }],
    },
  };
  const origConfirm = shellNativeModules.ArdiaDialogs.confirm;
  let confirmCalls = 0;
  shellNativeModules.ArdiaDialogs.confirm = async () => {
    confirmCalls += 1;
    return { confirmed: false, suppressed: false };
  };
  try {
    await importZen(["Profiles/a.Personal"], ["s0", "s1"], ["tabs", "cookies", "passwords"]);
  } finally {
    shellNativeModules.ArdiaDialogs.confirm = origConfirm;
    zen = ZEN;
  }
  assert.equal(confirmCalls, 0);
  assert.equal(S().profileOrder.length, 2);
  const [p0, p1] = S().profileOrder;
  assert.notEqual(engineProfile(S(), p0), engineProfile(S(), p1));
  assert.deepEqual(pinsOf(p0, "row"), ["https://a.example/"]);
  assert.deepEqual(pinsOf(p1, "row"), ["https://b.example/"]);
  assert.deepEqual(
    writtenCookies.map(({ token, profile }) => [token, profile]),
    [
      ["tok-0", engineProfile(S(), p0)],
      ["tok-1", engineProfile(S(), p1)],
    ],
  );
  assert.deepEqual(discardedTokens, []);
  assert.deepEqual(savedPasswords.map((p) => p.profile), [engineProfile(S(), p0), engineProfile(S(), p1)]);
});

test("a second Zen space in the same container shares its container store instead of replacing an unrelated profile", async () => {
  zen = {
    "Profiles/a.Personal": {
      spaces: [
        space("home", "Home", 0, [link("https://home.example/")]),
        space("lab", "Lab", 1, [link("https://lab.example/")]),
        space("shared", "Shared", 1, [link("https://shared.example/")]),
      ],
      favorites: [],
      vaultToken: "tok-0",
      containerVaultTokens: { "1": "tok-1" },
      credentials: [{ url: "https://accounts.example.com", username: "user1", password: "pw1" }],
    },
  };
  writtenCookies.length = 0;
  discardedTokens.length = 0;
  savedPasswords.length = 0;
  useBrowser.setState({ bookmarks: { nodes: {} } });
  S().hydrate({});
  S().createWindow({ url: "https://start.example/" });
  const existingShared = createProfile({ name: "Shared" });
  const origConfirm = shellNativeModules.ArdiaDialogs.confirm;
  let confirmCalls = 0;
  shellNativeModules.ArdiaDialogs.confirm = async () => {
    confirmCalls += 1;
    return { confirmed: false, suppressed: false };
  };
  useImportFlow.setState({
    source: source(["Profiles/a.Personal"]),
    sourceProfiles: ["Profiles/a.Personal"],
    spaces: ["home", "lab", "shared"],
    target: "default",
    kinds: new Set(["tabs", "cookies", "passwords"]),
    step: { name: "choose", error: null },
  });
  try {
    await runImport(new Set(["tabs", "cookies", "passwords"]));
  } finally {
    shellNativeModules.ArdiaDialogs.confirm = origConfirm;
    zen = ZEN;
  }
  assert.equal(confirmCalls, 0);
  const labId = named("Lab");
  const importedShared = S().profileOrder.find((id) => id !== existingShared && S().profiles[id].name === "Shared");
  assert.ok(labId && importedShared);
  assert.equal(engineProfile(S(), importedShared), engineProfile(S(), labId));
  assert.deepEqual(pinsOf(existingShared, "row"), []);
  assert.deepEqual(pinsOf(importedShared, "row"), ["https://shared.example/"]);
  assert.deepEqual(
    writtenCookies.map(({ token, profile }) => [token, profile]),
    [
      ["tok-0", engineProfile(S(), "default")],
      ["tok-1", engineProfile(S(), labId)],
    ],
  );
});

test("an unclaimed pre-existing Ardia profile can still be replaced and prompt errors or cancels discard all tokens", async () => {
  zen = {
    "Profiles/a.Personal": {
      spaces: [space("home", "Home", 0, [link("https://home.example/")]), space("work", "Work", 1, [link("https://work.example/")])],
      favorites: [],
      vaultToken: "tok-0",
      containerVaultTokens: { "1": "tok-1" },
    },
  };
  const origConfirm = shellNativeModules.ArdiaDialogs.confirm;
  const setupWithExistingWork = () => {
    writtenCookies.length = 0;
    discardedTokens.length = 0;
    useBrowser.setState({ bookmarks: { nodes: {} } });
    S().hydrate({});
    S().createWindow({ url: "https://start.example/" });
    const existingWork = createProfile({ name: "Work" });
    useImportFlow.setState({
      source: source(["Profiles/a.Personal"]),
      sourceProfiles: ["Profiles/a.Personal"],
      spaces: ["home", "work"],
      target: "default",
      kinds: new Set(["tabs", "cookies"]),
      step: { name: "choose", error: null },
    });
    return existingWork;
  };
  try {
    const existingWork = setupWithExistingWork();
    let confirmCalls = 0;
    shellNativeModules.ArdiaDialogs.confirm = async () => {
      confirmCalls += 1;
      return { confirmed: false, suppressed: false };
    };
    await runImport(new Set(["tabs", "cookies"]));
    assert.equal(confirmCalls, 1);
    assert.deepEqual(
      writtenCookies.map(({ token, profile }) => [token, profile]),
      [
        ["tok-0", engineProfile(S(), "default")],
        ["tok-1", engineProfile(S(), existingWork)],
      ],
    );

    setupWithExistingWork();
    shellNativeModules.ArdiaDialogs.confirm = async () => { throw new Error("dialog failed"); };
    await assert.rejects(() => runImport(new Set(["tabs", "cookies"])), /dialog failed/);
    assert.deepEqual(writtenCookies, []);
    assert.deepEqual(discardedTokens.sort(), ["tok-0", "tok-1"]);

    const workBeforeCancel = setupWithExistingWork();
    shellNativeModules.ArdiaDialogs.confirm = async () => {
      cancelImport();
      return { confirmed: false, suppressed: false };
    };
    await runImport(new Set(["tabs", "cookies"]));
    assert.deepEqual(pinsOf(workBeforeCancel, "row"), []);
    assert.deepEqual(writtenCookies, []);
    assert.deepEqual(discardedTokens.sort(), ["tok-0", "tok-1"]);
  } finally {
    shellNativeModules.ArdiaDialogs.confirm = origConfirm;
    zen = ZEN;
    startImport(0);
  }
});

test("cancelling during the first cookie write stops later partitions and discards remaining tokens", async () => {
  zen = {
    "Profiles/a.Personal": {
      ...ZEN["Profiles/a.Personal"],
      vaultToken: "tok-0",
      containerVaultTokens: { "1": "tok-1", "2": "tok-2" },
      credentials: [{ url: "https://accounts.example.com", username: "user1", password: "pw1" }],
    },
  };
  writtenCookies.length = 0;
  discardedTokens.length = 0;
  savedPasswords.length = 0;
  useBrowser.setState({ bookmarks: { nodes: {} } });
  S().hydrate({});
  S().createWindow({ url: "https://start.example/" });
  useImportFlow.setState({ source: source(["Profiles/a.Personal"]), sourceProfiles: ["Profiles/a.Personal"], spaces: ["home", "work", "money"], target: "default", kinds: new Set(["tabs", "cookies", "passwords"]), step: { name: "choose", error: null } });
  onWriteCookie = () => { cancelImport(); };
  try {
    await runImport(new Set(["tabs", "cookies", "passwords"]));
  } finally {
    onWriteCookie = null;
    zen = ZEN;
    startImport(0);
  }
  assert.deepEqual(writtenCookies.map(({ token }) => token), ["tok-0"]);
  assert.deepEqual(discardedTokens.sort(), ["tok-1", "tok-2"]);
  assert.equal(savedPasswords.length, 0);
  assert.deepEqual(tilesOf(S().profiles.default.name), []);
});

test("two Zen profiles with matching space names stay isolated, and password conflicts do not fail while real errors do", async () => {
  zen = {
    "Profiles/a.Personal": {
      spaces: [space("a0", "Shared", 0, [link("https://a.example/")])],
      favorites: [],
      vaultToken: "tok-a0",
      credentials: [{ url: "https://a.example.com", username: "a", password: "pwA" }],
    },
    "Profiles/b.School": {
      spaces: [space("b0", "Shared", 0, [link("https://b.example/")]), space("b1", "Lab", 1, [link("https://lab.example/")])],
      favorites: [],
      vaultToken: "tok-b0",
      containerVaultTokens: { "1": "tok-b1" },
      credentials: [
        { url: "https://b.example.com", username: "b1", password: "pwB1" },
        { url: "https://b2.example.com", username: "b2", password: "pwB2" },
      ],
    },
  };
  const origSave = ardiaCoreNativeModules.ArdiaPasswords.save;
  ardiaCoreNativeModules.ArdiaPasswords.save = async () => {
    throw new Error("Could not save the password (invalid, or already saved)");
  };
  try {
    await importZen(["Profiles/a.Personal", "Profiles/b.School"], ["a0", "b0", "b1"], ["tabs", "cookies", "passwords"]);
    assert.equal(S().profileOrder.length, 3);
    assert.deepEqual(writtenCookies.map(({ token }) => token), ["tok-a0", "tok-b0", "tok-b1"]);
    assert.equal(new Set(writtenCookies.map(({ profile }) => profile)).size, 3);
    assert.deepEqual(discardedTokens, []);
    assert.deepEqual(useImportFlow.getState().step.failures, []);

    ardiaCoreNativeModules.ArdiaPasswords.save = async (profile, origin, username) => {
      if (username === "b2" && profile === engineProfile(S(), named("Lab"))) throw new Error("engine store unavailable");
      savedPasswords.push({ profile, origin, username });
      return true;
    };
    await importZen(["Profiles/a.Personal", "Profiles/b.School"], ["a0", "b0", "b1"], ["tabs", "cookies", "passwords"]);
    assert.ok(savedPasswords.some((p) => p.username === "b1" && p.profile === engineProfile(S(), named("Lab"))));
    assert.ok(useImportFlow.getState().step.failures.some((f) => f.kind === "passwords"));
  } finally {
    ardiaCoreNativeModules.ArdiaPasswords.save = origSave;
    zen = ZEN;
  }
});

test("importing a non-default Zen container with autofill writes autofill from the default token without false failure on cookie error", async () => {
  zen = {
    "Profiles/a.Personal": {
      ...ZEN["Profiles/a.Personal"],
      vaultToken: "tok-0",
      containerVaultTokens: { "1": "tok-1" },
    },
  };
  onWriteCookie = ({ token }) => (token === "tok-1" ? { cookies: 0, cookiesRejected: 0, cookiesExisting: 0, addresses: 0, cards: 0, cookiesFailed: 1 } : null);
  try {
    await importZen(["Profiles/a.Personal"], ["work"], ["tabs", "cookies", "autofill"]);
  } finally {
    onWriteCookie = null;
    zen = ZEN;
  }
  assert.deepEqual(
    writtenCookies.map(({ token, kinds }) => [token, kinds]),
    [
      ["tok-1", ["cookies"]],
      ["tok-0", ["autofill"]],
    ],
  );
  const done = useImportFlow.getState().step;
  assert.equal(done.counts.addresses, 1);
  assert.deepEqual(done.failures.map((f) => f.kind), ["cookies"]);
});

test("replacing an Arc profile across two source profiles keeps writing autofill for both", async () => {
  zen = {
    "Profiles/a.Personal": { spaces: [], favorites: [], vaultToken: "arc-tok-1" },
    "Profiles/b.School": { spaces: [], favorites: [], vaultToken: "arc-tok-2" },
  };
  const arcSource = {
    id: "arc", name: "Arc", family: "arc", sidebar: "arc", requiresExport: false, needsKeychain: false,
    profiles: [
      { id: "Profiles/a.Personal", name: "Personal", path: "a", isDefault: true, available: ["autofill"] },
      { id: "Profiles/b.School", name: "Personal", path: "b", isDefault: false, available: ["autofill"] },
    ],
  };
  writtenCookies.length = 0;
  discardedTokens.length = 0;
  useBrowser.setState({ bookmarks: { nodes: {} } });
  S().hydrate({});
  S().createWindow({ url: "https://start.example/" });
  const origConfirm = shellNativeModules.ArdiaDialogs.confirm;
  shellNativeModules.ArdiaDialogs.confirm = async () => ({ confirmed: false, suppressed: false });
  useImportFlow.setState({
    source: arcSource,
    sourceProfiles: ["Profiles/a.Personal", "Profiles/b.School"],
    spaces: [],
    target: "default",
    kinds: new Set(["autofill"]),
    step: { name: "choose", error: null },
  });
  try {
    await runImport(new Set(["autofill"]));
  } finally {
    shellNativeModules.ArdiaDialogs.confirm = origConfirm;
    zen = ZEN;
  }
  assert.deepEqual(writtenCookies.map(({ token, kinds }) => [token, kinds]), [
    ["arc-tok-1", ["autofill"]],
    ["arc-tok-2", ["autofill"]],
  ]);
  assert.deepEqual(discardedTokens, []);

  zen = {
    "Profiles/a.Personal": { spaces: [space("arc-a", "Main", 0, [link("https://arc-a.example/")])], favorites: [], vaultToken: "arc-default-tok" },
    "Profiles/b.School": { spaces: [space("arc-b", "Side", 0, [link("https://arc-b.example/")])], favorites: [], vaultToken: "arc-side-tok" },
  };
  const arcWithSpaces = {
    ...arcSource,
    profiles: [
      { id: "Profiles/a.Personal", name: "Personal", path: "a", isDefault: true, available: ["tabs", "cookies"], spaces: [{ id: "arc-a", name: "Main", pinnedCount: 1, tabCount: 0 }] },
      { id: "Profiles/b.School", name: "School", path: "b", isDefault: false, available: ["tabs", "cookies"], spaces: [{ id: "arc-b", name: "Side", pinnedCount: 1, tabCount: 0 }] },
    ],
  };
  writtenCookies.length = 0;
  discardedTokens.length = 0;
  useBrowser.setState({ bookmarks: { nodes: {} } });
  S().hydrate({});
  S().createWindow({ url: "https://start.example/" });
  useImportFlow.setState({
    source: arcWithSpaces,
    sourceProfiles: ["Profiles/a.Personal"],
    spaces: ["arc-b"],
    target: "default",
    kinds: new Set(["tabs", "cookies"]),
    step: { name: "choose", error: null },
  });
  try {
    await runImport(new Set(["tabs", "cookies"]));
  } finally {
    zen = ZEN;
  }
  assert.deepEqual(writtenCookies.map(({ token }) => token), ["arc-default-tok", "arc-side-tok"]);
});

test("two Zen profiles keep their container tokens isolated per profile", async () => {
  zen = {
    "Profiles/a.Personal": {
      ...ZEN["Profiles/a.Personal"],
      vaultToken: "tok-a0",
      containerVaultTokens: { "1": "tok-a1" },
    },
    "Profiles/b.School": {
      ...ZEN["Profiles/b.School"],
      vaultToken: "tok-b0",
      containerVaultTokens: { "1": "tok-b1" },
    },
  };
  await importZen(["Profiles/a.Personal", "Profiles/b.School"], ["home", "work", "study", "lab"], ["tabs", "cookies"]);
  zen = ZEN;
  const eng = (name) => engineProfile(S(), named(name) ?? "default");
  assert.deepEqual(
    writtenCookies.map(({ token, profile }) => [token, profile]),
    [
      ["tok-a0", eng(S().profiles.default.name)],
      ["tok-a1", eng("Work")],
      ["tok-b0", eng("Study")],
      ["tok-b1", eng("Research")],
    ],
  );
  assert.deepEqual(discardedTokens, []);
});
