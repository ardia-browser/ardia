import type { ImportRows } from "../store/browserDatabase.ts";
import { POSITION_STEP, type BrowserTab } from "../tabs/tabModels.ts";
import { t } from "../../lib/uiLanguage";


type Page = { url: string; title: string; minutesAgo: number };

export const DEMO_OPEN: readonly Page[] = [
  { url: "https://en.wikipedia.org/wiki/Lisbon", title: t(`Lisbon - Wikipedia`), minutesAgo: 600 },
  { url: "https://www.nytimes.com/section/arts", title: t(`Arts - The New York Times`), minutesAgo: 420 },
  { url: "https://www.apple.com/iphone/", title: t(`iPhone - Apple`), minutesAgo: 240 },
  { url: "https://www.allrecipes.com/recipe/21014/good-old-fashioned-pancakes/", title: t(`Good Old-Fashioned Pancakes Recipe`), minutesAgo: 180 },
  { url: "https://www.bbc.com/news/science_and_environment", title: t(`Science - BBC News`), minutesAgo: 95 },
  { url: "https://www.swift.org/blog/", title: t(`Blog | Swift.org`), minutesAgo: 40 },
  { url: "https://www.theverge.com/", title: t(`The Verge`), minutesAgo: 12 },
  { url: "https://en.wikipedia.org/wiki/Sintra", title: t(`Sintra - Wikipedia`), minutesAgo: 3 },
];

export const DEMO_ARCHIVED: readonly Page[] = [
  { url: "https://www.timeout.com/lisbon", title: t(`Time Out Lisbon`), minutesAgo: 60 * 5 },
  { url: "https://www.metmuseum.org/", title: t(`The Metropolitan Museum of Art`), minutesAgo: 60 * 26 },
  { url: "https://news.ycombinator.com/", title: t(`Hacker News`), minutesAgo: 60 * 30 },
  { url: "https://www.npr.org/sections/music/", title: t(`Music : NPR`), minutesAgo: 60 * 60 },
];

export const DEMO_HISTORY: readonly Page[] = [
  { url: "https://www.google.com/search?q=best+time+to+visit+sintra", title: t(`best time to visit sintra - Google Search`), minutesAgo: 8 },
  { url: "https://www.google.com/search?q=past%C3%A9is+de+nata+recipe", title: t(`pastéis de nata recipe - Google Search`), minutesAgo: 50 },
  { url: "https://www.google.com/search?q=swift+concurrency", title: t(`swift concurrency - Google Search`), minutesAgo: 75 },
  { url: "https://www.apple.com/", title: t(`Apple`), minutesAgo: 30 },
  { url: "https://www.apple.com/iphone/", title: t(`iPhone - Apple`), minutesAgo: 240 },
  { url: "https://en.wikipedia.org/wiki/Lisbon", title: t(`Lisbon - Wikipedia`), minutesAgo: 600 },
  { url: "https://www.allrecipes.com/", title: t(`Allrecipes | Recipes, How-Tos, Videos and More`), minutesAgo: 900 },
];

const ARCHIVED_IDLE_MS = 600_000;

const DAY_MINUTES = 24 * 60;
const SCALED_DAYS = 30;
const VISITS_PER_ARCHIVED = 3;

export function demoSeed(now: number, newId: () => string, scale = 0): ImportRows {
  const ago = (minutes: number) => now - Math.round(minutes * 60_000);
  const tab = (page: Page, position: number, lastActive: number, archivedAt: number | null): BrowserTab => ({
    id: newId(),
    url: page.url,
    title: page.title,
    created: lastActive,
    lastActive,
    archivedAt,
    position,
    profileSyncId: null,
    faviconUrl: null,
    themeColorHex: null,
    snapshotFileName: null,
    origin: "typed",
    receivedKey: null,
    receivedFromDevice: null,
    pinnedKey: null,
    isPrivate: false,
  });
  const archived = DEMO_ARCHIVED.map((page, index) => tab(page, (index + 1) * POSITION_STEP, ago(page.minutesAgo) - ARCHIVED_IDLE_MS, ago(page.minutesAgo)));
  const open = DEMO_OPEN.map((page, index) => tab(page, (DEMO_ARCHIVED.length + index + 1) * POSITION_STEP, ago(page.minutesAgo), null));
  const visits = DEMO_HISTORY.map((page) => ({ url: page.url, title: page.title, visitedAt: ago(page.minutesAgo), profileSyncId: null, transition: "typed" as const }));
  const spread = (index: number, count: number) => DAY_MINUTES + (index * SCALED_DAYS * DAY_MINUTES) / count;
  const scaledArchived = Array.from({ length: scale }, (_, index) => {
    const page = DEMO_ARCHIVED[index % DEMO_ARCHIVED.length]!;
    const minutes = spread(index, scale);
    return tab({ ...page, url: `${page.url}#archived-${index}`, title: `${page.title} ${index + 1}`, minutesAgo: minutes }, -(index + 1) * POSITION_STEP, ago(minutes) - ARCHIVED_IDLE_MS, ago(minutes));
  });
  const visitCount = scale * VISITS_PER_ARCHIVED;
  const scaledVisits = Array.from({ length: visitCount }, (_, index) => {
    const page = DEMO_HISTORY[index % DEMO_HISTORY.length]!;
    return { url: `${page.url}#visit-${index}`, title: `${page.title} ${index + 1}`, visitedAt: ago(spread(index, visitCount)), profileSyncId: null, transition: "typed" as const };
  });
  return { tabs: [...archived, ...scaledArchived, ...open], states: [], visits: [...visits, ...scaledVisits], preferences: {} };
}
