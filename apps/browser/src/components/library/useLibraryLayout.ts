import { useProfileOrder } from "../../state/profiles/hooks";
import { useLibrarySection } from "../../state/library/hooks";
import { useSidebarWidth } from "../../state/sidebar/hooks";
import { useWindowRootWidth } from "../../state/windows/rootSize";
import { LIBRARY, libraryLayout, type LibraryLayout } from "./tokens";

export function useLibraryLayout(windowId: string): LibraryLayout {
  const width = useWindowRootWidth(windowId) ?? LIBRARY.rail.width + LIBRARY.panel.width;
  const section = useLibrarySection(windowId);
  const profiles = useProfileOrder((order) => order.length);
  const sidebar = useSidebarWidth(windowId);
  return libraryLayout(width, section, profiles, sidebar);
}

export function useLibraryListPanel(windowId: string): number {
  const width = useWindowRootWidth(windowId) ?? LIBRARY.rail.width + LIBRARY.panel.width;
  const sidebar = useSidebarWidth(windowId);
  return libraryLayout(width, "media", 0, sidebar).panel;
}
