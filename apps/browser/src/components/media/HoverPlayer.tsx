import { devRegister } from "../dev/devRegister";
import { HoverCard } from "../ui";
import { clickTab } from "../../state/sidebar/actions";
import { dismissHover } from "../../state/sidebar/hover";
import { cardHoverProps } from "../sidebar/hoverController";
import { useHoverCardOrigin } from "../sidebar/hoverMotion";
import { measureRow, setSidebarUi, type Anchor } from "../../state/sidebar/sidebarUi";
import { MINI_PLAYER_HEIGHT, MINI_PLAYER_WIDTH, MiniPlayer } from "./MiniPlayer";

export function HoverPlayer({ tabId, windowId, anchor }: { tabId: string; windowId: string; anchor: Anchor }) {
  const origin = useHoverCardOrigin(anchor);
  return (
    <HoverCard {...cardHoverProps} width={MINI_PLAYER_WIDTH} pad="none" style={{ position: "absolute", ...origin, height: MINI_PLAYER_HEIGHT }}>
      <MiniPlayer
        tabId={tabId}
        onBackToTab={() => {
          dismissHover();
          clickTab(windowId, tabId);
        }}
      />
    </HoverCard>
  );
}

devRegister("acMediaHover", null, async (windowId: string, tabId: string | null) => {
  if (!tabId) return setSidebarUi({ hover: null });
  const anchor = await measureRow(windowId, tabId);
  if (anchor) setSidebarUi({ hover: { windowId, kind: "tab", id: tabId, anchor } });
  return anchor;
});
