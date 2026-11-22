import { t } from "./uiLanguage";
export type ArchiveDayKind = "today" | "yesterday" | "weekday" | "monthDay" | "monthDayYear";

const startOfDay = (at: number) => {
  const day = new Date(at);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
};

export function archiveDayKind(at: number, now: number): ArchiveDayKind {
  const day = startOfDay(at);
  const today = startOfDay(now);
  const back = Math.round((today - day) / 86_400_000);
  if (back === 0) return "today";
  if (back === 1) return "yesterday";
  if (back >= 0 && back <= 6) return "weekday";
  return new Date(at).getFullYear() === new Date(now).getFullYear() ? "monthDay" : "monthDayYear";
}

export function archiveDayTitle(at: number, now: number, locale?: string): string {
  const day = new Date(at);
  switch (archiveDayKind(at, now)) {
    case "today":
      return t(`Today`);
    case "yesterday":
      return t(`Yesterday`);
    case "weekday":
      return day.toLocaleDateString(locale, { weekday: "long" });
    case "monthDay":
      return day.toLocaleDateString(locale, { month: "long", day: "numeric" });
    case "monthDayYear":
      return day.toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric" });
  }
}

export const ARCHIVE_SEARCH_DELAY_MS = 120;
