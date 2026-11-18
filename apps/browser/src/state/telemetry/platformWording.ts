import type { PlatformFeatures } from "../../lib/platformFeatures";
import type { PlatformTerms } from "../../lib/platformTerms";

export type Wording = (text: string) => string;

export type WhatsSentGroup = { title: string; items: string[] };

type FeatureFlag = { [K in keyof PlatformFeatures]: PlatformFeatures[K] extends boolean ? K : never }[keyof PlatformFeatures];

export const PHRASES_ONLY_WITH: Readonly<Partial<Record<FeatureFlag, string>>> = {
  memoryPressure: ", the Mac's memory pressure",
  launchLoad: ". Also at launch: the Mac's load average (one number, how busy it was) and whether the app was started as a login item",
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

export function platformWording(terms: PlatformTerms, features: PlatformFeatures, keyText: (mac: string) => string): Wording {
  const dropped = Object.entries(PHRASES_ONLY_WITH).flatMap(([flag, phrase]) => (features[flag as FeatureFlag] ? [] : [phrase]));
  const rules = termRules(terms);
  const reword = (part: string) => {
    let text = part;
    for (const phrase of dropped) text = text.replaceAll(phrase, "");
    for (const rule of rules) text = text.replace(rule.mac, () => rule.platform);
    return text.replace(KEY_RUN, (run) => keyText(run));
  };
  return (text) => outsideQuotes(text, reword);
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
