import { createContext, memo, useContext, useEffect, useMemo, useState } from "react";
import { Animated, Pressable, View } from "react-native";
import { useTheme } from "../ui/theme";
import { useGroup, usePageProfileId, useWindowId, useWindowProfileId } from "../../state/browser/hooks";
import { updateGroup } from "../../state/groups/actions";
import { noteGroupHeaderHide } from "../../state/telemetry/usage";
import { useGroupLabel } from "../../state/groups/hooks";
import { useSelectionInGroup } from "../../state/pins/hooks";
import { newCapture } from "../../state/sidebar/listCapture";
import { useCapturedGroupEntries, useGroupTabIds, useKeptEntries, useShowsExtraTabs } from "../../state/sidebar/hooks";
import { MeetingTimeLabel, useMeetingCountdown } from "../live/MeetingCountdown";
import { HoverSlot } from "../ui/HoverSlot";
import { Button, ContextMenuArea, ink, Symbol, weight, withAlpha } from "../ui";
import { commitRename, endRename } from "../../state/sidebar/actions";
import { useDragFolded, useDragItem, useDropInto } from "./DragProvider";
import { useShift, type EntryMotion } from "./EntryMotion";
import { Fold, useFold } from "./Fold";
import { GROUP_BORDER, GROUP_INNER_RADIUS, GROUP_INDENT, GROUP_INSET, GROUP_RADIUS, groupMembersPadBottom } from "./geometry";
import { entryHeightNow, foldedGroupHeight, headGap } from "../../state/sidebar/geometry";
import { dismissHover } from "../../state/sidebar/hover";
import { useGroupHover, useRowHover } from "./hoverController";
import { useHoverFade } from "./hoverMotion";
import { Squish, useSquish } from "../ui/Squish";
import { GhostSlot, ListMotionContext, useGroupMotion } from "./ListMotion";
import { pressGroupClose, useGroupCloseControlWhile } from "../../state/sidebar/closeControl";
import { openGroupMenu } from "../../state/sidebar/menus";
import { registerRow, useSidebarUi } from "../../state/sidebar/sidebarUi";
import { FolderOrIcon } from "./AnimatedFolder";
import { RenameField, SplitRowItem, TabRowItem } from "./TabRow";
import { groupBoxAtRest, groupSurface, useSidebarTokens } from "./tokens";
import { SidebarRowSurface } from "./SidebarRow";
import { entryKey, parseEntry } from "../../state/sidebar/entryKey";
import { LiveFolderBlock } from "./LiveFolderBlock";
import { tailKey, type RowSection } from "./dragModel";
import { SharedFolderMark } from "./SharedFolderMark";
import { FolderHeaderTitle } from "./FolderHeaderTitle";
import { t } from "../../lib/uiLanguage";


const NO_GROUPS: ReadonlySet<string> = new Set();

type ReportInnerHover = (groupId: string, hovered: boolean) => void;
const InnerGroupHover = createContext<ReportInnerHover | null>(null);
const NO_SLIDE_BELOW = { slideBelow: null };

function useInnermostHover(groupId: string, hovered: boolean) {
  const reportToParent = useContext(InnerGroupHover);
  const [hoveredInside, setHoveredInside] = useState(NO_GROUPS);
  const [reportInside] = useState(() => (id: string, on: boolean) =>
    setHoveredInside((was) => {
      if (was.has(id) === on) return was;
      const next = new Set(was);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    }),
  );
  useEffect(() => {
    if (!reportToParent || !hovered) return;
    reportToParent(groupId, true);
    return () => reportToParent(groupId, false);
  }, [reportToParent, hovered, groupId]);
  return { innermost: hovered && hoveredInside.size === 0, reportInside };
}

export const GroupBlock = memo(function GroupBlock({
  groupId,
  section,
  parentGroup,
  motion: own = null,
}: {
  groupId: string;
  section: "list" | "pinnedGroups";
  parentGroup?: string;
  motion?: EntryMotion | null;
}) {
  const windowId = useWindowId();
  const tokens = useSidebarTokens();
  const stored = useGroup(groupId, (g) => !!g?.collapsed);
  const collapsed = useDragFolded(entryKey("group", groupId)) || stored;
  const color = useGroup(groupId, (g) => g?.color ?? null);
  const tabIds = useGroupTabIds(groupId);
  const [captured] = useState(newCapture);
  const entries = useCapturedGroupEntries(groupId, captured);
  const selectedInside = useSelectionInGroup(windowId, groupId);
  const profileId = usePageProfileId();
  const keptEntries = useKeptEntries(windowId, profileId, groupId);
  const foldedHeight = () => foldedGroupHeight(windowId, profileId, groupId);
  const { wrapper, handle, headerRef } = useDragItem(entryKey("group", groupId), { kind: "group", tabIds, section, groupId, collapsed: stored, foldedHeight, parentGroup }, own?.clip);
  const tail = useDragItem(tailKey({ group: groupId }), { kind: "tail", tabIds: [], section, parentGroup: groupId });

  const fold = useFold(collapsed);
  const scope = useContext(ListMotionContext);
  const onShownPage = useWindowProfileId() === profileId;
  const motion = useGroupMotion(windowId, profileId, groupId, entries, captured, section === "list" && !parentGroup ? scope : NO_SLIDE_BELOW, onShownPage && !collapsed);
  const [moved, movedRef] = useShift(own?.shift ?? null);
  const box = useGroupHover(windowId, groupId);
  const dropInto = useDropInto(groupId);
  const nested = useInnermostHover(groupId, box.hovered);
  const boxOpacity = useHoverFade(nested.innermost || dropInto || groupBoxAtRest(color));

  const { fill, stroke } = groupSurface(color, tokens);

  return (
    <Animated.View ref={wrapper.ref} style={wrapper.style}>
      <View {...moved} {...box.hoverProps} ref={movedRef} style={[{ paddingVertical: GROUP_BORDER }, moved.style as object]}>
        <Animated.View
          pointerEvents="none"
          style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, borderRadius: GROUP_RADIUS, backgroundColor: fill, borderWidth: GROUP_BORDER, borderColor: stroke, opacity: boxOpacity }}
        />
        <View ref={headerRef} {...handle}>
          <GroupHeader groupId={groupId} windowId={windowId} collapsed={collapsed} open={fold.open} />
        </View>
        <InnerGroupHover.Provider value={nested.reportInside}>
          <Fold
            fold={fold}
            collapsed={collapsed}
            entries={motion.slots(entries).map((slot) =>
              "ghost" in slot
                ? { key: slot.ghost.key, ghost: true, node: <GhostSlot snapshot={slot.ghost.snapshot} top={slot.top} opacity={slot.ghost.opacity} /> }
                : {
                    key: slot.entry,
                    node: (
                      <SidebarEntry entry={slot.entry} section={section} parentGroup={groupId} motion={motion.motion(slot.entry)} />
                    ),
                  },
            )}
            keep={keptEntries}
            rowHeight={(key) => entryHeightNow(windowId, profileId, key)}
            padTop={headGap(collapsed && keptEntries.length ? keptEntries[0] : entries[0])}
            padBottom={groupMembersPadBottom(collapsed ? keptEntries.length : entries.length)}
            indent={GROUP_INDENT}
            indentEnd={GROUP_INSET}
            mountClosed={selectedInside}
            footer={<Animated.View ref={tail.wrapper.ref} style={tail.wrapper.style} />}
          />
        </InnerGroupHover.Provider>
        {motion.tail ? <Animated.View style={{ marginTop: motion.tail }} /> : null}
      </View>
    </Animated.View>
  );
});

export const SidebarEntry = memo(function SidebarEntry({
  entry,
  section,
  rowSection = section,
  parentGroup,
  motion = null,
}: {
  entry: string;
  section: "list" | "pinnedGroups";
  rowSection?: RowSection;
  parentGroup?: string;
  motion?: EntryMotion | null;
}) {
  const windowId = useWindowId();
  const { kind, id } = parseEntry(entry);
  if (kind === "live") return <LiveFolderBlock folderId={id} windowId={windowId} />;
  if (kind === "group") return <GroupBlock groupId={id} section={section} parentGroup={parentGroup} motion={motion} />;
  if (kind === "split") return <SplitRowItem splitId={id} section={rowSection} parentGroup={parentGroup} motion={motion} />;
  return <TabRowItem tabId={id} section={rowSection} parentGroup={parentGroup} motion={motion} />;
});

const CHEVRON_BOX = { width: 10, height: 10, alignItems: "center", justifyContent: "center" } as const;

const GroupHeader = memo(function GroupHeader({ groupId, windowId, collapsed, open }: { groupId: string; windowId: string; collapsed: boolean; open: Animated.Value }) {
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const group = useGroup(groupId, (g) => g);
  const label = useGroupLabel(groupId);
  const renaming = useSidebarUi((u) => u.renaming?.kind === "group" && u.renaming.id === groupId);
  const dropInto = useDropInto(groupId);
  const { hovered, hoverProps } = useRowHover(windowId, collapsed && !renaming ? { kind: "group", id: groupId } : null);
  const countdown = useMeetingCountdown(groupId);
  const closeControl = useGroupCloseControlWhile(groupId, hovered && !renaming);
  const profileId = usePageProfileId();
  const showsExtra = useShowsExtraTabs(windowId, profileId, groupId);
  const squish = useSquish(renaming ? null : "row");
  const chevronTurn = useMemo(() => ({ ...CHEVRON_BOX, transform: [{ rotate: open.interpolate({ inputRange: [0, 1], outputRange: ["-90deg", t(`0deg`)] }) }] }), [open]);
  if (!group) return null;
  const target = { kind: "group" as const, id: groupId };

  return (
    <View ref={(v) => registerRow(windowId, groupId, v)} {...hoverProps}>
      <ContextMenuArea
        onContextMenu={() => {
          dismissHover();
          void openGroupMenu(windowId, groupId);
        }}
      >
        <Pressable
          onPressIn={squish.onPressIn}
          onPressOut={squish.onPressOut}
          onPress={() => {
            dismissHover();
            if (renaming) return;
            if (!collapsed || !showsExtra) return updateGroup(groupId, { collapsed: !collapsed });
            noteGroupHeaderHide();
            updateGroup(groupId, { shownTabIds: [] });
          }}
        >
          {() => (
            <Squish scale={squish.scale}>
            <SidebarRowSurface fill={dropInto ? theme.tabPressed : ink.clear} cornerRadius={GROUP_INNER_RADIUS}>
              <FolderOrIcon icon={group.icon} open={!collapsed || dropInto} color={group.color} />
              {renaming ? (
                <RenameField
                  initial={group.name}
                  placeholder={label}
                  color={tokens.groupTitle}
                  weight={weight.medium}
                  onDone={(text) => (text === null ? endRename(target) : commitRename(target, text))}
                />
              ) : (
                <FolderHeaderTitle label={label} color={tokens.groupTitle} style={{ transform: [{ rotate: countdown.rotate }] }}>
                  <SharedFolderMark groupId={groupId} />
                  <Animated.View style={chevronTurn}>
                    <Symbol name="chevron.down" size={9} weight="semibold" color={withAlpha(tokens.groupTitle, 0.5)} style={{ width: 10, height: 10 }} />
                  </Animated.View>
                </FolderHeaderTitle>
              )}
              <HoverSlot
                hovered={hovered && !renaming}
                hover={closeControl && <Button variant="icon" icon={closeControl.icon} size="s" weight="semibold" onPress={() => pressGroupClose(groupId)} tooltip={closeControl.tooltip} />}
              >
                {countdown.label && !renaming ? <MeetingTimeLabel label={countdown.label} urgent={countdown.urgent} /> : null}
              </HoverSlot>
            </SidebarRowSurface>
            </Squish>
          )}
        </Pressable>
      </ContextMenuArea>
    </View>
  );
});
