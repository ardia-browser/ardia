import type { LegacyReadInput, LegacyVisitInput } from "../src/state/legacy/importRules.ts";

export const T = 1_790_000_000_000;

export const OTTER = "6F9619FF-8B86-D011-B42D-00C04FC964FF";
export const EXAMPLE = "1B4E28BA-2FA1-11D2-883F-0016D3CCA427";
export const NEWS = "C0FFEE00-0000-0000-0000-000000000002";

export function legacyRead(): LegacyReadInput {
  return {
    tabs: [
      {
        id: OTTER,
        url: "https://en.wikipedia.org/wiki/Otter",
        title: "Otter - Wikipedia",
        created: T,
        lastActive: T + 5_000,
        position: 1024,
        origin: "search",
        profileSyncId: "work",
        savedState: "AAECAw==",
        faviconUrl: "https://en.wikipedia.org/favicon.ico",
        themeColor: "#FFFFFF",
        snapshotPath: "/data/user/0/com.ardia.browser.android/files/PageSnapshots/otter-1-300x600.jpg",
      },
      {
        id: EXAMPLE,
        url: "https://example.com/",
        title: "Example Domain",
        created: T + 1_000,
        lastActive: T + 9_000,
        position: 2048,
        origin: "sent",
        receivedKey: "k-1",
        receivedFromDevice: "Mac Studio",
      },
      { id: "AAAA0000-0000-0000-0000-000000000001", url: "file:///etc/passwd", title: "bad", created: T, lastActive: T, position: 3072, origin: "typed" },
    ],
    selectedTabId: OTTER,
    archive: [
      {
        id: NEWS,
        url: "https://news.example/",
        title: "News",
        created: T - 9_000,
        lastActive: T - 8_000,
        position: 512,
        origin: "weird",
        archivedAt: T - 7_000,
        savedState: "BAUG",
        snapshotPath: "/data/user/0/com.ardia.browser.android/files/PageSnapshots/news-1-300x600.jpg",
      },
    ],
    preferences: {
      "tabs.autoArchiveInterval": "week",
      "browsing.nightShade": "automatic",
      "browsing.searchEngine": "duckduckgo",
      "browsing.searchSuggestions": "false",
      "settings.finishedOnboarding": "true",
      "settings.color": "green",
      "settings.autoOpenKeyboard": "true",
      "reader.sizeStep": "4",
      "reader.serif": "false",
      "reader.theme": "",
      "browsing.swipeNavigation": "sideways",
      "blocking.ads": "true",
    },
  };
}

export function legacyVisits(): (LegacyVisitInput & { id: number })[] {
  return [
    { id: 1, url: "https://www.google.com/search?q=otters", title: "otters - Google Search", visitedAt: T, transition: "formSubmit" },
    { id: 2, url: "https://en.wikipedia.org/wiki/Otter", title: "Otter", visitedAt: T + 1_000, transition: "typed", profileSyncId: "work" },
    { id: 4, url: "https://example.com/", title: "Example Domain", visitedAt: T + 2_000, transition: "link" },
    { id: 5, url: "javascript:void(0)", title: "", visitedAt: T, transition: "other" },
    { id: 7, url: "https://odd.example/", title: "Odd", visitedAt: T + 3_000, transition: "hyperjump" },
  ];
}
