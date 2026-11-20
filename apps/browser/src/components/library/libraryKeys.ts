export type LibraryKeyPress = { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean };

export type SearchKeyAction = "escape" | "enterList" | null;

export const SEARCH_KEYS = [{ key: "Escape" }, { key: "ArrowDown" }, { key: "Enter" }];

export const plainKey = (press: LibraryKeyPress): string | null => (press.metaKey || press.ctrlKey || press.altKey || press.shiftKey ? null : press.key);

export function searchKeyAction(press: LibraryKeyPress): SearchKeyAction {
  const key = plainKey(press);
  if (key === "Escape") return "escape";
  if (key === "ArrowDown" || key === "Enter") return "enterList";
  return null;
}
