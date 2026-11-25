import { displayHostOf } from "./url";

const LETTER = /\p{L}/u;

const firstLetter = (text: string): string | null => {
  for (const char of text) if (LETTER.test(char)) return char.toLocaleUpperCase();
  return null;
};

const SECOND_LEVEL = /^(?:co|com|net|org|gov|edu|ac|ne|or|go)$/;

function siteName(host: string): string {
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return host;
  const suffix = labels.length > 2 && SECOND_LEVEL.test(labels[labels.length - 2]!) ? 2 : 1;
  return labels[labels.length - 1 - suffix] ?? host;
}

export function tileLetterOf(url: string, title: string): string {
  const host = url ? siteName(displayHostOf(url)) : "";
  const fromHost = host && LETTER.test([...host][0] ?? "") ? firstLetter(host) : null;
  return fromHost ?? firstLetter(title) ?? "•";
}
