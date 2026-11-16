import { useContext } from "react";
import { Animated, View } from "react-native";
import { useIsActiveTab, usePageProfileId, useTab, useWindowId } from "../../state/browser/hooks";
import { useShownTabIdFor } from "../../state/tabs/topStrip";
import { TabIcon } from "../sidebar/TabIcon";
import { Divider, FadeLabel, Symbol } from "../ui";
import { surfaceTheme, useTheme } from "../ui/theme";
import { ThemeOverride } from "../ui/ThemeOverride";
import type { ToolbarPalette } from "../ui/toolbarColors";
import { font, space } from "../ui/tokens";
import { DockContext, FloatingStrip } from "./context";
import { SelectedTab } from "./SelectedTab";
import { dragGeometry, type DragGeometry } from "./stripGroups";
import { ItemRow, useWebsiteBand } from "./TabChip";
import { CHIP_LABEL_GAP, CHIP_PAD, GAP, TOP_STRIP_HEIGHT } from "./tokens";
import { useStripDrag } from "./useStripDrag";
import { StripScrollContext } from "./stripScroll";
import { useStripCardHover } from "./StripHoverCard";
import { useChipHover, useChipHovered } from "./reachableHover";
import { TabPressArea } from "../sidebar/TabPressArea";
import { tabTitle } from "../../state/browser/model";
import { useStruckTitle } from "../../state/sidebar/rowState";
import { SLEEPING_TITLE_OPACITY } from "../sidebar/tokens";

export function SplitChip({ tabIds, width, paneWidths, geometry: givenGeometry, from: givenFrom, group }: { tabIds: string[]; width: number; paneWidths?: number[]; geometry?: DragGeometry; from?: number; group: string | null }) {
  const strip = useContext(DockContext);
  const scroll = useContext(StripScrollContext);
  const geometryOf = () => givenGeometry ?? strip!.current.top;
  const fromOf = () => givenFrom ?? strip?.current.slotOf(tabIds[0]!) ?? -1;
  const onTint = useTheme();
  const windowId = useWindowId();
  const profileId = usePageProfileId();
  const focusedId = useShownTabIdFor(windowId, profileId);
  const active = tabIds.includes(focusedId);
  const theme = active ? surfaceTheme(onTint) : onTint;
  const { band, palette } = useWebsiteBand(active ? focusedId : tabIds[0]!);
  const floating = useContext(FloatingStrip);
  const ink = active && !floating && palette.background ? palette : null;
  const hover = useChipHover();
  const hovered = useChipHovered(hover);
  const shown = paneWidths?.slice(0, tabIds.length);
  const even = !shown || shown.every((w) => Math.abs(w - shown[0]!) < 0.5) || Math.abs(shown.reduce((a, b) => a + b, 0) - width) > 1;
  const paneWidth = (id: string) => (even ? undefined : shown![tabIds.indexOf(id)]);
  const drag = useStripDrag({
    tabId: null,
    ids: () => tabIds,
    pinned: false,
    groupId: group,
    get geometry() {
      return geometryOf();
    },
    get from() {
      return fromOf();
    },
    width,
    gap: GAP,
    scroll,
    axis: "x",
  });
  return (
    <ThemeOverride theme={theme}>
      <Animated.View ref={drag.ref} {...drag.panHandlers} mouseDownCanMoveWindow={false} style={{ ...drag.style, zIndex: drag.dragging ? 10 : active ? 1 : 0 }}>
        <Animated.View {...hover.hoverProps} style={{ width, height: TOP_STRIP_HEIGHT }}>
          {active && <SelectedTab width={width} band={band} opaque={drag.dragging} />}
          <ItemRow hovered={hovered && !active} pressed={false} padded={false}>
            {tabIds.map((id, i) => (
              <SplitPart key={id} tabId={id} first={i === 0} last={i === tabIds.length - 1} ink={ink} width={paneWidth(id)} />
            ))}
          </ItemRow>
        </Animated.View>
      </Animated.View>
    </ThemeOverride>
  );
}

const NO_SLOTS = dragGeometry([], GAP);

const PART_FILL = { flex: 1 } as const;

function SplitPart({ tabId, first, last, ink, width }: { tabId: string; first: boolean; last: boolean; ink: ToolbarPalette | null; width?: number }) {
  const theme = useTheme();
  const windowId = useWindowId();
  const tab = useTab(tabId);
  const focused = useIsActiveTab(tabId);
  const drag = useStripDrag({ tabId, ids: () => [tabId], pinned: false, groupId: null, geometry: NO_SLOTS, from: -1, width: 0, gap: 0, axis: "y" });
  const hover = useChipHover();
  const card = useStripCardHover(windowId, tabId, drag.ref, hover);
  const struck = useStruckTitle(tabId);
  if (!tab) return null;
  return (
    <Animated.View ref={drag.ref} {...drag.panHandlers} {...card} {...hover.hoverProps} style={{ ...(width === undefined ? { flex: 1 } : { width }), alignSelf: "stretch", opacity: drag.style.opacity }}>
      <TabPressArea
        windowId={windowId}
        tab={tab}
        style={PART_FILL}
        pressStyle={{ flex: 1, flexDirection: "row", alignItems: "center", paddingLeft: first ? CHIP_PAD.left : 0, paddingRight: last ? CHIP_PAD.right : 0 }}
      >
        {first ? (
          <Symbol name="rectangle.split.2x1" size={11} color={ink?.secondary ?? theme.textSecondary} style={SPLIT_GLYPH} />
        ) : (
          <Divider vertical length={SPLIT_DIVIDER_LENGTH} color={ink?.divider ?? theme.textTertiary} style={SPLIT_DIVIDER_GAP} />
        )}
        <View pointerEvents="none">
          <TabIcon url={tab.url} favicon={tab.favicon} icon={tab.customIcon} compact profileId={tab.profileId} />
        </View>
        <FadeLabel text={tabTitle(tab)} fontSize={font.small.fontSize} color={ink ? (focused ? ink.text : ink.secondary) : focused ? theme.tabSelectedText : theme.textTab} strikethrough={struck} style={{ flex: 1, height: 16, marginLeft: CHIP_LABEL_GAP, opacity: struck ? SLEEPING_TITLE_OPACITY : 1 }} />
      </TabPressArea>
    </Animated.View>
  );
}

const SPLIT_GLYPH = { width: 14, height: 16, marginRight: space.xs } as const;
const SPLIT_DIVIDER_LENGTH = 16;
const SPLIT_DIVIDER_GAP = { marginHorizontal: space.s } as const;
