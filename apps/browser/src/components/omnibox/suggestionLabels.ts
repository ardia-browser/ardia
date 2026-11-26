import { displayHost, displayUrl, hostOf, type Suggestion } from "@ardia/core";

const MAX_ROW_TEXT = 300;

function clipRowText(text: string): string {
  if (text.length <= MAX_ROW_TEXT) return text;
  const last = text.charCodeAt(MAX_ROW_TEXT - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? MAX_ROW_TEXT - 1 : MAX_ROW_TEXT;
  return `${text.slice(0, end)}…`;
}

export function suggestionLabels(s: Suggestion): [string, string | null] {
  switch (s.kind) {
    case "page":
      if (s.tabId) return [clipRowText(s.title || displayUrl(s.url)), "Switch to Tab"];
      return s.title ? [clipRowText(s.title), clipRowText(displayUrl(s.url))] : [clipRowText(displayUrl(s.url)), null];
    case "search":
      return [clipRowText(s.bang ? `Search ${s.engine} for ${s.query}` : s.query), null];
    case "calc":
      return [clipRowText(s.value), clipRowText(s.expression)];
    case "action":
    case "create":
      return [clipRowText(s.title), null];
    case "extension":
      return [clipRowText(s.title), s.open === "action" ? "Open Extension" : "Extension Options"];
    case "provider": {
      const host = displayHost(hostOf(s.url)) || displayUrl(s.url);
      return [clipRowText(s.title), clipRowText(s.subtitle ? `${host} · ${s.subtitle}` : host)];
    }
  }
}
