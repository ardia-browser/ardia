import { pinKeysOf } from "./world.mjs";

export function structureProblems(world, s) {
  const problems = [];
  const isIncognito = world.modules.model.isIncognitoProfile ?? (() => false);
  const owner = new Map();
  for (const [wid, w] of Object.entries(s.windows)) {
    for (const id of w.tabIds) {
      const t = s.tabs[id];
      if (!t) problems.push(`window ${wid} lists missing tab ${id}`);
      else if (t.windowId !== wid) problems.push(`window ${wid} lists tab ${id} whose windowId is ${t.windowId}`);
      if (owner.has(id)) problems.push(`tab ${id} listed by ${owner.get(id)} and ${wid}`);
      owner.set(id, wid);
    }
    for (const [profileId, active] of Object.entries(w.activeTabIds ?? {})) {
      const t = s.tabs[active];
      if (!t) problems.push(`window ${wid} active tab for ${profileId} is missing (${active})`);
      else if (t.windowId !== wid || t.profileId !== profileId) problems.push(`window ${wid} active tab for ${profileId} is ${active}, which lives in ${t.windowId}/${t.profileId}`);
    }
    if (!s.profiles[w.profileId] && !isIncognito(w.profileId)) problems.push(`window ${wid} shows missing profile ${w.profileId}`);
  }
  for (const [id, t] of Object.entries(s.tabs)) {
    if (!s.windows[t.windowId]) problems.push(`tab ${id} belongs to missing window ${t.windowId}`);
    else if (!owner.has(id)) problems.push(`tab ${id} is not listed by its window ${t.windowId}`);
    if (!s.profiles[t.profileId] && !isIncognito(t.profileId)) problems.push(`tab ${id} belongs to missing profile ${t.profileId}`);
  }
  const ordered = new Set(s.windowOrder);
  for (const id of s.windowOrder) if (!s.windows[id]) problems.push(`windowOrder names missing window ${id}`);
  for (const id of Object.keys(s.windows)) if (!ordered.has(id)) problems.push(`window ${id} is missing from windowOrder`);
  for (const [gid, g] of Object.entries(s.groups)) {
    if (!s.windows[g.windowId]) problems.push(`group ${gid} belongs to missing window ${g.windowId}`);
    for (const id of g.tabIds) {
      const t = s.tabs[id];
      if (!t) problems.push(`group ${gid} lists missing tab ${id}`);
      else if (t.windowId !== g.windowId) problems.push(`group ${gid} lists tab ${id} from window ${t.windowId}`);
    }
  }
  for (const [wid, ids] of Object.entries(s.selection ?? {})) for (const id of ids) if (!s.tabs[id]) problems.push(`selection in ${wid} names missing tab ${id}`);
  for (const [sid, split] of Object.entries(s.splits ?? {})) {
    const panes = (split.slots ?? []).flat(Infinity).filter((x) => typeof x === "string");
    for (const id of panes) if (!s.tabs[id] && !String(id).startsWith("empty")) problems.push(`split ${sid} names missing tab ${id}`);
  }
  for (const profileId of Object.keys(s.parkedPins ?? {})) if (!s.profiles[profileId]) problems.push(`parked pins kept for missing profile ${profileId}`);
  for (const id of s.profileOrder) if (!s.profiles[id]) problems.push(`profileOrder names missing profile ${id}`);
  return problems;
}

export function sessionShape(s, sectioned = (ids) => ids) {
  const sortById = (list) => [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    profiles: [...s.profileOrder],
    share: !!s.settings.shareTabsAcrossWindows,
    windows: s.windowOrder
      .filter((id) => s.windows[id] && (s.windows[id].kind ?? "main") === "main")
      .map((id) => {
        const w = s.windows[id];
        return { id, profileId: w.profileId, tabIds: sectioned(w.tabIds), active: Object.entries(w.activeTabIds).sort() };
      }),
    tabs: sortById(Object.values(s.tabs).filter((t) => (s.windows[t.windowId]?.kind ?? "main") === "main")).map((t) => ({
      id: t.id,
      windowId: t.windowId,
      profileId: t.profileId,
      url: t.url,
      pin: t.pin ? JSON.stringify(t.pin) : null,
      pinKey: t.pinKey ?? null,
    })),
    closedTabs: (s.closedTabs ?? []).map((c) => `${c.id}|${c.tab?.url ?? ""}`),
    closedWindows: (s.closedWindows ?? []).map((c) => `${c.id}|${(c.tabs ?? []).map((t) => t.url).join(",")}`),
    closedGroups: (s.closedGroups ?? []).map((c) => c.id),
    groups: sortById(Object.values(s.groups)).map((g) => ({ id: g.id, windowId: g.windowId, profileId: g.profileId, pinned: !!g.pinned, name: g.name ?? "", tabIds: g.tabIds })),
    parked: Object.fromEntries(
      Object.entries(s.parkedPins ?? {})
        .sort()
        .map(([p, park]) => [p, (park.tabs ?? []).map((t) => t.id)]),
    ),
  };
}

export function pinnedAreaShape(s, profileId = "default") {
  const tabs = Object.values(s.tabs)
    .filter((t) => t.profileId === profileId && t.pin)
    .map((t) => `${t.pinKey ?? t.id}|${t.pinnedUrl ?? t.url}|${t.pin?.as ?? "tile"}|${t.windowId}`)
    .sort();
  const folders = Object.values(s.groups)
    .filter((g) => g.profileId === profileId && g.pinned)
    .map((g) => `${g.pinKey ?? g.id}|${g.name}|${g.tabIds.join(",")}`)
    .sort();
  const parked = (s.parkedPins?.[profileId]?.tabs ?? []).map((t) => t.id).sort();
  const order = Object.values(s.windows)
    .map((w) => `${w.id}:${w.tabIds.filter((id) => s.tabs[id]?.profileId === profileId && s.tabs[id]?.pin).map((id) => s.tabs[id].pinKey ?? id).join(",")}`)
    .sort();
  return { tabs, folders, parked, order };
}

export function firstDifference(a, b, path = "") {
  if (Object.is(a, b)) return null;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return `${path || "(root)"}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: shape changed`;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const found = firstDifference(a[key], b[key], path ? `${path}.${key}` : key);
    if (found) return found;
  }
  return null;
}

export function createPinLedger(world) {
  let expected = new Map();
  return {
    reset() {
      expected = pinKeysOf(world, world.S());
    },
    check(outcome) {
      const now = pinKeysOf(world, outcome.after);
      const problems = [];
      const allowed = (profileId, key) => {
        if (outcome.removesProfile === profileId) return true;
        return !!outcome.removes?.[profileId]?.includes(key);
      };
      for (const [profileId, keys] of expected) {
        for (const key of keys) {
          if (now.get(profileId)?.has(key)) continue;
          if (allowed(profileId, key)) continue;
          problems.push(`pin ${key} of profile ${profileId} disappeared`);
        }
      }
      const { pinKeyOf, inPinnedContainer } = world.modules.model;
      for (const id of outcome.pinned ?? []) {
        const was = outcome.before.tabs[id];
        const family = `${was.profileId}|${pinKeyOf(was)}`;
        const pinnedCopy = Object.values(outcome.after.tabs).some((t) => `${t.profileId}|${pinKeyOf(t)}` === family && inPinnedContainer(outcome.after, t.id));
        if (!pinnedCopy) problems.push(`pinning ${id} left no pinned copy of it`);
      }
      const families = new Set(Object.values(outcome.after.tabs).map((t) => `${t.profileId}|${pinKeyOf(t)}`));
      const pages = new Set(Object.values(outcome.after.tabs).flatMap((t) => [t.url, t.pinnedUrl].filter(Boolean).map((u) => `${t.profileId}|${u}`)));
      for (const id of outcome.keeps ?? []) {
        const t = outcome.before.tabs[id];
        if (t && !families.has(`${t.profileId}|${pinKeyOf(t)}`) && !pages.has(`${t.profileId}|${t.url}`)) problems.push(`tab ${id} and every copy of it (${t.url}) were closed by an action that only unpins or regroups it`);
      }
      expected = new Map([...now].map(([p, keys]) => [p, new Set(keys)]));
      return problems;
    },
  };
}

function reopenProblems(outcome) {
  if (!outcome.reopened) return [];
  const s = outcome.after;
  const { expected, tabsBefore } = outcome.reopened;
  const stillThere = new Set([...s.closedTabs, ...s.closedWindows].map((c) => c.id));
  const restored = [...outcome.reopened.tabs, ...outcome.reopened.windows].filter((c) => !stillThere.has(c.id));
  const problems = [];
  if (expected && !restored.some((c) => c.id === expected.id)) problems.push(`reopening left the entry it should restore (${expected.kind} ${expected.id}) on the list`);
  const active = new Set(Object.values(s.windows).flatMap((w) => Object.values(w.activeTabIds ?? {})));
  const broughtBack = (url) => Object.values(s.tabs).some((t) => (t.url === url || t.pinnedUrl === url) && (!tabsBefore[t.id] || active.has(t.id)));
  for (const entry of restored) {
    const promised = entry.kind === "window" ? entry.tabs.map((t) => t.url).filter(Boolean) : [entry.tab.url].filter(Boolean);
    const missing = promised.filter((url) => !broughtBack(url));
    if (missing.length) problems.push(`reopening ${entry.kind} ${entry.id} took it off the list but did not open or show ${missing.join(", ")}`);
  }
  return problems;
}

export function stepProblems(world, ledger, outcome) {
  const problems = [];
  for (const p of structureProblems(world, outcome.after)) problems.push({ rule: "structure", message: p });
  for (const p of ledger.check(outcome)) problems.push({ rule: "pins", message: p });
  for (const p of reopenProblems(outcome)) problems.push({ rule: "reopen", message: p });
  for (const p of outcome.errors ?? []) problems.push({ rule: "errors", message: p });
  const { orderSections } = world.modules.groups;
  const shapeOf = (s) => sessionShape(s, (ids) => orderSections(ids, s.tabs, s.groups));
  if (outcome.roundTrip) {
    const diff = firstDifference(shapeOf(outcome.roundTrip[0]), shapeOf(outcome.roundTrip[1]));
    if (diff) problems.push({ rule: "session", message: `save then reload changed ${diff}` });
  }
  if (outcome.relaunch) {
    const diff = firstDifference(shapeOf(outcome.relaunch[0]), shapeOf(outcome.relaunch[1]));
    if (diff) problems.push({ rule: "relaunch", message: `quit then relaunch changed ${diff}` });
  }
  if (outcome.syncPair) {
    const diff = firstDifference(pinnedAreaShape(outcome.syncPair[0]), pinnedAreaShape(outcome.syncPair[1]));
    if (diff) problems.push({ rule: "sync", message: `the second sync changed ${diff}` });
  }
  return problems;
}
