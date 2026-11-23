import type { PlatformFeatures } from "../../lib/platformFeatures";
import type { PlatformTerms } from "../../lib/platformTerms";

export type Wording = (text: string) => string;

export type WhatsSentGroup = { title: string; items: string[] };

type FeatureFlag = { [K in keyof PlatformFeatures]: PlatformFeatures[K] extends boolean ? K : never }[keyof PlatformFeatures];

export const PHRASES_ONLY_WITH: Readonly<Partial<Record<FeatureFlag, string | readonly string[]>>> = {
  memoryPressure: ", the Mac's memory pressure",
  launchLoad: ". Also at launch: the Mac's load average (one number, how busy it was) and whether the app was started as a login item",
  holdsColdPagesUntilPainted:
    ". Also how many times a tab that hadn't loaded yet kept the New Tab page's background until its page first drew, how many of those waits ended because the page drew, finished loading, was clicked or took over 4 seconds, and how long they took in all",
  freezeWatch: [", and how many times Ardia's windows or its interface code stopped responding for a quarter of a second or more, in rough lengths from a quarter of a second to over 10 seconds, with the longest one, how many of those held up a click or key press and the longest such wait, how many of the interface code's stops had their time spent freeing its memory measured, how much time that was in all and the longest in one stop, how many of those stops went mostly to freeing memory, and how many times and for how long it freed memory in that hour, with that memory's size in rough steps. When Ardia's window or interface code freezes for 0.4 seconds or more (at most 5 a session and 20 a day, one of each kind a day): which of the two it was, how long it lasted in rough lengths, how long a click or key press waited, how much of it was freeing memory and how much memory that was in rough steps, which of Ardia's own background jobs was running (like sync or saving your session) and, when the window froze, which of them doing work on the window's thread overlapped the freeze and which only ran alongside, the tab count in rough steps, the window count, whether sync is on, sidebar or top tabs, whether a tab was opening, switching or loading, the Mac's memory pressure, how hot it was running, whether it was on battery, roughly how long Ardia had been open, and where Ardia's own code was stuck, as program addresses in Ardia's own files (everything else is just “system” or “other”, never names or paths)", ", and the last 20 times Ardia froze for 0.4 seconds or more: which part froze, for how long, which of its own jobs was running and the program addresses where it was stuck, kept whether sharing is on or off (Help › Copy Last Freeze copies the latest)"],
};

export const termRules = (terms: PlatformTerms): readonly { mac: RegExp; platform: string }[] => [
  { mac: /\bthis Mac\b/g, platform: `this ${terms.computer}` },
  { mac: /\bthe Mac\b/g, platform: `the ${terms.computer}` },
  { mac: /\bmacOS version\b/g, platform: `${terms.os} version` },
  { mac: /\bfrom the Dock\b/g, platform: `from the ${terms.dock}` },
  { mac: /\bin Finder\b/g, platform: `in ${terms.fileManager}` },
];

export const KEY_RUN = /(?<![\p{L}\p{N}])[⌃⌥⇧⌘]+(?:Tab|↩|[A-Z0-9])?(?![\p{L}\p{N}])/gu;

const QUOTED = /(“[^”]*”|"[^"]*")/;

const outsideQuotes = (text: string, change: Wording) =>
  text
    .split(QUOTED)
    .map((part, i) => (i % 2 ? part : change(part)))
    .join("");

export function dropFeaturePhrases(features: PlatformFeatures): Wording {
  const dropped = Object.entries(PHRASES_ONLY_WITH)
    .flatMap(([flag, phrase]) => (features[flag as FeatureFlag] ? [] : [phrase].flat()))
    .sort((a, b) => b.length - a.length);
  return (text) => dropped.reduce((kept, phrase) => kept.replaceAll(phrase, ""), text);
}

export function platformWording(terms: PlatformTerms, features: PlatformFeatures, keyText: (mac: string) => string): Wording {
  const dropPhrases = dropFeaturePhrases(features);
  const rules = termRules(terms);
  const reword = (part: string) => rules.reduce((text, rule) => text.replace(rule.mac, () => rule.platform), part).replace(KEY_RUN, (run) => keyText(run));
  return (text) => outsideQuotes(dropPhrases(text), reword);
}

export function rewordInPlace(value: object, words: Wording) {
  const fields = value as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    const field = fields[key];
    if (typeof field === "string") fields[key] = words(field);
    else if (field && typeof field === "object") rewordInPlace(field, words);
  }
}

export function addItems(groups: WhatsSentGroup[], added: Readonly<Record<string, readonly string[]>>) {
  for (const [title, items] of Object.entries(added)) {
    const group = groups.find((g) => g.title === title);
    if (group) group.items.push(...items);
    else groups.push({ title, items: [...items] });
  }
}
