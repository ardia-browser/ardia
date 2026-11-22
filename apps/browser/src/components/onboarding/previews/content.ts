import { articleTints, tabTints } from "./tokens";
import { t } from "../../../lib/uiLanguage";


export type Tab = { title: string; host: string; color: string; icon: string };

export const TABS: readonly Tab[] = [
  { title: t(`Field Notes`), host: "fieldnotes.blog", color: tabTints.notes, icon: "leaf.fill" },
  { title: t(`Inbox`), host: "mail.fastmail.com", color: tabTints.mail, icon: "envelope.fill" },
  { title: t(`Weekend in Lisbon`), host: "maps.apple.com", color: tabTints.maps, icon: "map.fill" },
  { title: t(`Q4 roadmap`), host: "docs.new", color: tabTints.docs, icon: "doc.text.fill" },
  { title: t(`Focus mix`), host: "music.apple.com", color: tabTints.music, icon: "music.note" },
  { title: t(`Sourdough, day 2`), host: "cooking.nytimes.com", color: tabTints.cooking, icon: "fork.knife" },
  { title: t(`Pull requests`), host: "github.com", color: tabTints.github, icon: "arrow.triangle.pull" },
];
export const NEW_TAB: Tab = { title: t(`New Tab`), host: "", color: tabTints.newTab, icon: "plus" };
export const BLANK: Tab = { title: t(`New Tab`), host: "", color: tabTints.blank, icon: "globe" };
export const tab = (i: number) => TABS[i % TABS.length]!;

type Pair = readonly [string, string];

export type Article = {
  site: string;
  band: Pair;
  title: string;
  byline: string;
  body: string;
  hero: { sky: Pair; sun: Pair; far: Pair; near: Pair; sea: Pair };
};

const heroOf = ({ sky, sun, far, near, sea }: (typeof articleTints)[keyof typeof articleTints]) => ({ sky, sun, far, near, sea });

export const NOTES: Article = {
  site: t(`Field Notes`),
  band: articleTints.notes.band,
  title: t(`A slow morning on the coast trail`),
  byline: t(`Mara Lindqvist · 6 min read`),
  body: t(`We left before the fog lifted, coffee in the side pocket, and walked until the cliffs ran out. Nobody else was there, just gulls and the sound of the tide coming back in.`),
  hero: heroOf(articleTints.notes),
};

export const TRIP: Article = {
  site: t(`Wanderlog`),
  band: articleTints.trip.band,
  title: t(`Three days in Lisbon`),
  byline: t(`Itinerary · 12 places · shared with 2`),
  body: t(`Day one starts in Alfama with pastéis de nata at the corner bakery, then the 28 tram up to the castle before the crowds arrive.`),
  hero: heroOf(articleTints.trip),
};

export const SITE: Pair = NOTES.band;

export type Suggestion = { icon?: string; fav?: Tab; title: string; detail?: string; hint?: string };
