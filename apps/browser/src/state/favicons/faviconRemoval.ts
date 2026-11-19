import type { Icons } from "./faviconStore";

const entriesOf = <T,>(map: Record<string, T>, keep: (key: string, value: T) => boolean) => Object.fromEntries(Object.entries(map).filter(([key, value]) => keep(key, value)));

export const heldUris = (icons: Icons): string[] => [...Object.values(icons.pages), ...Object.values(icons.srcs), ...Object.values(icons.appearances).flat()].filter((uri): uri is string => !!uri);

export function withoutPages(icons: Icons, gone: ReadonlySet<string>, shownSources: ReadonlySet<string | null>): Icons {
  if (![...gone].some((page) => page in icons.pages || page in icons.appearances)) return icons;
  const pages = entriesOf(icons.pages, (page) => !gone.has(page));
  const appearances = entriesOf(icons.appearances, (page) => !gone.has(page));
  const kept = new Set<string | null>([...Object.values(pages), ...Object.values(appearances).flat()]);
  const lost = new Set<string>();
  for (const page of gone) for (const uri of [icons.pages[page], ...(icons.appearances[page] ?? [])]) if (uri && !kept.has(uri)) lost.add(uri);
  return { pages, appearances, srcs: entriesOf(icons.srcs, (src, uri) => shownSources.has(src) || !lost.has(uri)) };
}
