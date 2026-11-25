export function profileSeed(origin, count, settings = {}) {
  if (!Number.isSafeInteger(count) || count < 2) throw new Error("the profiles phase needs at least 2 profiles");
  const ids = Array.from({ length: count }, (_, i) => (i ? `profile-${i}` : "default"));
  const windowId = "w-profile-bench";
  const tabs = ids.map((profileId, i) => ({
    id: `t-profile-${i}`, windowId, profileId, url: `${origin}/static?id=profile-${i}`, title: `Profile ${i + 1}`, favicon: null,
    pinned: false, muted: false, zoom: 1, customTitle: null, customIcon: null, pinnedUrl: null, openerId: null, createdAt: 0, lastActiveAt: 0,
  }));
  return {
    version: 2,
    profiles: Object.fromEntries(ids.map((id, i) => [id, { id, name: `Profile ${i + 1}`, color: "plum", icon: null, createdAt: i }])),
    profileOrder: ids,
    orphanedProfileData: [],
    settings: { searchSuggestions: false, warnBeforeClosingLastTab: false, warnBeforeClosingWindow: false, ...settings },
    windows: [{
      id: windowId, profileId: "default", incognito: false, tabIds: tabs.map((tab) => tab.id),
      activeTabIds: Object.fromEntries(tabs.map((tab) => [tab.profileId, tab.id])), sidebarOpen: true, frame: [100, 100, 1100, 760], createdAt: 0,
    }],
    windowOrder: [windowId],
    focusedWindowId: windowId,
    tabs,
    groups: [],
    splits: [],
    closedTabs: [],
    closedWindows: [],
  };
}

export function parseSettings(pairs) {
  const settings = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at < 1) throw new Error(`a setting is K=V, got "${pair}"`);
    const value = pair.slice(at + 1);
    try {
      settings[pair.slice(0, at)] = JSON.parse(value);
    } catch {
      settings[pair.slice(0, at)] = value;
    }
  }
  return settings;
}
