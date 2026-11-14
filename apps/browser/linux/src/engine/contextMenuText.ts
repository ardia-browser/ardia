const SELECTION_LABEL_LENGTH = 50;
const SELECTION_BREAK_AFTER = 25;
const HIGHLIGHT_WORDS = 5;
const HIGHLIGHT_WHOLE_LENGTH = 80;

export function selectionLabel(text: string): string {
  const characters = Array.from(text.split(/\s+/).filter(Boolean).join(" "));
  if (characters.length <= SELECTION_LABEL_LENGTH) return characters.join("");
  const space = characters.lastIndexOf(" ", SELECTION_LABEL_LENGTH);
  const end = space > SELECTION_BREAK_AFTER ? space : SELECTION_LABEL_LENGTH;
  return `${characters.slice(0, end).join("")}…`;
}

const fragmentPart = (text: string) => encodeURIComponent(text).replace(/-/g, "%2D").replace(/,/g, "%2C").replace(/&/g, "%26");

export function linkToHighlight(pageUrl: string, selection: string): string | null {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const words = selection.split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const whole = words.join(" ");
  const directive =
    whole.length <= HIGHLIGHT_WHOLE_LENGTH || words.length <= HIGHLIGHT_WORDS * 2
      ? fragmentPart(whole)
      : `${fragmentPart(words.slice(0, HIGHLIGHT_WORDS).join(" "))},${fragmentPart(words.slice(-HIGHLIGHT_WORDS).join(" "))}`;
  url.hash = "";
  return `${url.toString()}#:~:text=${directive}`;
}
