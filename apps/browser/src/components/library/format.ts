import type { Download } from "../../state/downloads/actions";
import { awaitsKeep, dangerWarning } from "../../state/downloads/status";
import { UI_LOCALE } from "../../lib/uiLocale";

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const STEP = 1000;
const whole = new Intl.NumberFormat(UI_LOCALE, { maximumFractionDigits: 0 });
const tenths = new Intl.NumberFormat(UI_LOCALE, { maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat(UI_LOCALE, { style: "percent", maximumFractionDigits: 0 });

export function byteSize(bytes: number): string {
  let n = Math.max(0, bytes);
  let unit = 0;
  while (n >= STEP && unit < UNITS.length - 1) {
    n /= STEP;
    unit++;
  }
  return `${(unit > 0 && n < 10 ? tenths : whole).format(n)} ${UNITS[unit]}`;
}

export type DownloadLine = { text: string; tone: "textSecondary" | "destructive" };

export function downloadLine(d: Download, exists: boolean): DownloadLine {
  if (awaitsKeep(d)) return { text: dangerWarning(d, true), tone: "destructive" };
  if (d.state === "failed") return { text: "Failed", tone: "destructive" };
  if (d.state === "cancelled") return { text: "Cancelled", tone: "textSecondary" };
  if (d.state === "finished") return { text: exists ? byteSize(d.total > 0 ? d.total : d.received) : "Deleted", tone: "textSecondary" };
  if (d.paused) return { text: "Paused", tone: "textSecondary" };
  if (d.total > 0) return { text: percent.format(Math.min(1, d.received / d.total)), tone: "textSecondary" };
  return { text: byteSize(d.received), tone: "textSecondary" };
}

export const tabCount = (n: number): string => `${whole.format(n)} ${n === 1 ? "Tab" : "Tabs"}`;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const monthDay = new Intl.DateTimeFormat(UI_LOCALE, { month: "short", day: "numeric" });

const startOfDay = (at: number) => {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

const calendarDaysBetween = (at: number, now: number) => Math.round((startOfDay(now) - startOfDay(at)) / DAY);

export function shortAgo(at: number, now = Date.now(), compact = false): string {
  const elapsed = Math.max(0, now - at);
  if (compact) return compactAgo(elapsed, at, now);
  if (elapsed < MINUTE) return "Just now";
  if (elapsed < HOUR) return `${whole.format(Math.floor(elapsed / MINUTE))} min ago`;
  if (elapsed < DAY) return `${whole.format(Math.floor(elapsed / HOUR))} hr ago`;
  const days = calendarDaysBetween(at, now);
  if (days <= 1) return "Yesterday";
  if (days < 7) return `${whole.format(days)} days ago`;
  return monthDay.format(at);
}

function compactAgo(elapsed: number, at: number, now: number): string {
  if (elapsed < MINUTE) return "now";
  if (elapsed < HOUR) return `${whole.format(Math.floor(elapsed / MINUTE))}m`;
  if (elapsed < DAY) return `${whole.format(Math.floor(elapsed / HOUR))}h`;
  const days = Math.max(1, calendarDaysBetween(at, now));
  if (days < 7) return `${whole.format(days)}d`;
  return monthDay.format(at);
}

export function timeLeft(seconds: number, compact = false): string {
  if (compact) return `${compactLeft(seconds)} left`;
  if (seconds < 60) return `${whole.format(Math.max(1, Math.round(seconds)))} sec left`;
  if (seconds < 3600) return `${whole.format(Math.round(seconds / 60))} min left`;
  return `${whole.format(Math.round(seconds / 3600))} hr left`;
}

const compactLeft = (seconds: number) => {
  if (seconds < 60) return `${whole.format(Math.max(1, Math.round(seconds)))}s`;
  if (seconds < 3600) return `${whole.format(Math.round(seconds / 60))}m`;
  return `${whole.format(Math.round(seconds / 3600))}h`;
};

export function previewLine(d: Download, exists: boolean, now = Date.now()): DownloadLine {
  const { tone, texts } = previewLineChoices(d, exists, now);
  return { tone, text: texts[0] };
}

export function previewLineChoices(d: Download, exists: boolean, now = Date.now()): { tone: DownloadLine["tone"]; texts: [string, ...string[]] } {
  const line = downloadLine(d, exists);
  const pair = (rest: (compact: boolean) => string): { tone: DownloadLine["tone"]; texts: [string, ...string[]] } => ({ tone: line.tone, texts: [`${line.text} · ${rest(false)}`, `${line.text} · ${rest(true)}`, rest(true)] });
  if (d.state === "finished") return d.startTime ? pair((compact) => shortAgo(d.startTime!, now, compact)) : { tone: line.tone, texts: [line.text] };
  if (d.state !== "downloading" || awaitsKeep(d) || d.paused) return { tone: line.tone, texts: [line.text] };
  if (d.speed > 0 && d.total > d.received) {
    const seconds = (d.total - d.received) / d.speed;
    return { tone: line.tone, texts: [`${line.text} · ${timeLeft(seconds)}`, `${line.text} · ${timeLeft(seconds, true)}`, line.text] };
  }
  return { tone: line.tone, texts: [line.text] };
}

export type TextWidth = (text: string) => number;

export const firstThatFits = (texts: readonly [string, ...string[]], room: number, widthOf: TextWidth): string =>
  texts.find((text) => widthOf(text) <= room) ?? texts[texts.length - 1] ?? texts[0];

const NAME_BREAKS = [/[\s_-]/, /[\s_.-]/];
const KEPT_AFTER = /\./;
const SAFE_PREFIX = 6;
const KEPT_MAX = 16;

const sharedPrefix = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

export function splitName(name: string, siblings: readonly string[]): { head: string; kept: string } {
  const shared = siblings.reduce((most, other) => (other === name ? most : Math.max(most, sharedPrefix(name, other))), 0);
  if (shared <= SAFE_PREFIX || shared >= name.length) return { head: name, kept: "" };
  for (const breaks of NAME_BREAKS) {
    let word = shared;
    while (word > 0 && !breaks.test(name.charAt(word))) word--;
    const cut = KEPT_AFTER.test(name.charAt(word)) ? word + 1 : word;
    if (word > 0 && name.length - cut <= KEPT_MAX) return { head: name.slice(0, cut), kept: name.slice(cut) };
  }
  return { head: name, kept: "" };
}


export type NameFit = { head: string; kept: string };

const ELLIPSIS = "\u2026";

const closestSibling = (name: string, siblings: readonly string[]) =>
  siblings.reduce<{ other: string; shared: number }>((best, other) => {
    if (other === name) return best;
    const shared = sharedPrefix(name, other);
    return shared > best.shared ? { other, shared } : best;
  }, { other: "", shared: 0 });

const sharedSuffix = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
};

export function fitName(name: string, siblings: readonly string[], room: number, widthOf: TextWidth, headMin: number): NameFit {
  if (widthOf(name) <= room) return { head: name, kept: "" };
  const { head, kept } = splitName(name, siblings);
  if (!kept) return { head: name, kept: "" };
  if (widthOf(kept) + headMin <= room) return { head, kept };
  const tail = ELLIPSIS + kept;
  if (widthOf(tail) <= room) return { head: "", kept: tail };
  const cut = name.length - kept.length;
  const { other } = closestSibling(name, siblings);
  const end = Math.max(cut + 1, name.length - sharedSuffix(name, other));
  const dot = name.lastIndexOf(".");
  const ext = dot >= end ? name.slice(dot) : "";
  const run = name.slice(cut, end).replace(/[\s_.-]+$/, "");
  return { head: "", kept: `${ELLIPSIS}${run}${ext ? ELLIPSIS + ext : ""}` };
}

const clock = new Intl.DateTimeFormat(UI_LOCALE, { hour: "numeric", minute: "2-digit" });
const dateThisYear = new Intl.DateTimeFormat(UI_LOCALE, { month: "short", day: "numeric" });
const dateWithYear = new Intl.DateTimeFormat(UI_LOCALE, { month: "short", day: "numeric", year: "numeric" });

export function whenLong(at: number, now = Date.now()): string {
  const days = calendarDaysBetween(at, now);
  const date = days === 0 ? "Today" : days === 1 ? "Yesterday" : (new Date(at).getFullYear() === new Date(now).getFullYear() ? dateThisYear : dateWithYear).format(at);
  return `${date} at ${clock.format(at)}`;
}

export const visitCount = (n: number): string => `${whole.format(n)} ${n === 1 ? "time" : "times"}`;

const HOME = /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/;

export function folderLabel(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const folder = cut > 0 ? path.slice(0, cut) : path;
  return folder.replace(HOME, "~");
}

const KIND_WORDS: [RegExp, string][] = [
  [/^image\//, "Image"],
  [/^video\//, "Video"],
  [/^audio\//, "Audio"],
  [/^text\//, "Text"],
  [/pdf$/, "Document"],
  [/(zip|x-tar|gzip|x-7z|x-rar|x-bzip2|x-xz)/, "Archive"],
  [/(apple-diskimage|x-apple-diskimage)/, "Disk Image"],
];

export function fileKind(filename: string, mimeType: string): string {
  const dot = filename.lastIndexOf(".");
  const ext = dot > 0 && dot < filename.length - 1 ? filename.slice(dot + 1).toUpperCase() : "";
  const word = KIND_WORDS.find(([test]) => test.test(mimeType))?.[1] ?? (ext === "DMG" ? "Disk Image" : "File");
  return ext ? `${ext} ${word}` : word;
}
