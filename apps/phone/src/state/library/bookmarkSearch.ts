const words = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);

export type BookmarkLike = { key: string; title: string; url: string | null; root: string | null; children: readonly BookmarkLike[] | null };

export type BookmarkSection<T extends BookmarkLike> = { id: string; title: string | null; items: readonly T[] };

export function bookmarkSections<T extends BookmarkLike>(bookmarks: readonly T[]): BookmarkSection<T>[] {
  const bar = bookmarks.filter((item) => item.root === "bar");
  const other = bookmarks.filter((item) => item.root !== "bar");
  const sections: BookmarkSection<T>[] = [];
  if (bar.length) sections.push({ id: "bar", title: "Bookmarks Bar", items: bar });
  if (other.length) sections.push({ id: "other", title: "Other Bookmarks", items: other });
  return sections;
}

export function bookmarkMatches<T extends BookmarkLike>(bookmarks: readonly T[], query: string): T[] {
  const needles = words(query);
  const found: T[] = [];
  const visit = (items: readonly T[]) => {
    for (const item of items) {
      if (item.url) {
        const haystack = `${item.title} ${item.url}`.toLowerCase();
        if (needles.every((needle) => haystack.includes(needle))) found.push(item);
      }
      if (item.children) visit(item.children as readonly T[]);
    }
  };
  visit(bookmarks);
  return found;
}
