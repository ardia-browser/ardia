import { memo, type ReactNode, type RefObject, useCallback, useRef } from "react";
import type { GestureResponderEvent } from "react-native";
import type { HistoryEntry } from "../../state/browser/types";
import { useWindow } from "../../state/browser/hooks";
import { removeHistory } from "../../state/history/actions";
import { openHistoryRowMenu } from "../../state/history/historyMenus";
import { openVisitInProfile, pickLibraryItem, setLibraryQuery } from "../../state/library/actions";
import { useLibraryDayGroups, useLibraryScope, useSectionLive } from "../../state/library/hooks";
import { actingOwner, historyOwnersOf, visitKeyOf } from "../../state/library/profileScope";
import type { LibraryView } from "../../state/library/views";
import { modifiersOf } from "../../lib/keys";
import { noteLibraryQuickRemove } from "../../state/telemetry/libraryCounts";
import { Button, iconButton } from "../ui";
import { Favicon } from "../favicon/Favicon";
import { hostLabel } from "../pages/PageLayout";
import { CardGrid } from "./CardGrid";
import { LibraryViewPair } from "./LibraryViewPair";
import { DayList } from "./DayList";
import { LibraryCard } from "./LibraryCard";
import { LibraryRow, RowSubtitle } from "./LibraryRow";
import { cardFaceHeight, LIBRARY, textCardHeight } from "./tokens";
import { LibraryProfileBadge, useOwnedLabel } from "./LibraryProfileBadge";

const L = LIBRARY.list;
const C = LIBRARY.card;

type SectionProps = { windowId: string; panelWidth: number; entry: RefObject<(() => void) | null>; empty: ReactNode };

function HistorySectionPage({ view, windowId, panelWidth, entry, empty }: SectionProps & { view: LibraryView }) {
  const groups = useLibraryDayGroups(windowId, "history");
  const live = useSectionLive(windowId, "history");
  const profileId = useWindow(windowId, (w) => w?.profileId ?? "");
  const merged = useLibraryScope(windowId).merged;
  const latest = useRef(profileId);
  latest.current = profileId;
  const open = useCallback(
    (item: HistoryEntry) => pickLibraryItem(windowId, "history", item.url, {}, merged ? actingOwner(historyOwnersOf(item), latest.current) : undefined),
    [windowId, merged],
  );
  const actions = useRef({
    moreFromSite: (url: string) => setLibraryQuery(windowId, hostLabel(url)),
    remove: (urls: string[], owner?: string) => removeHistory(owner ?? latest.current, urls),
  });
  const renderRow = useCallback(
    (item: HistoryEntry, highlighted: boolean) => <HistoryEntryView entry={item} profileId={profileId} merged={merged} windowId={windowId} highlighted={highlighted} actions={actions.current} />,
    [windowId, profileId, merged],
  );
  const renderCard = useCallback(
    (item: HistoryEntry, tile: number, highlighted: boolean) => (
      <HistoryEntryView entry={item} profileId={profileId} merged={merged} windowId={windowId} highlighted={highlighted} actions={actions.current} tile={tile} />
    ),
    [windowId, profileId, merged],
  );
  if (!groups.length) return <>{empty}</>;
  return (
    <LibraryViewPair
      view={view}
      live={live}
      entry={entry}
      render={(v, slot) =>
        v === "cards" ? (
          <CardGrid windowId={windowId} groups={groups} panelWidth={panelWidth} keyOf={keyOf} rowHeight={textCardHeight} renderCard={renderCard} onOpen={open} entry={slot.entry} scroll={slot.scroll} />
        ) : (
          <DayList windowId={windowId} groups={groups} keyOf={keyOf} renderRow={renderRow} onOpen={open} entry={slot.entry} scroll={slot.scroll} />
        )
      }
    />
  );
}

const keyOf = visitKeyOf;

type EntryActions = { moreFromSite: (url: string) => void; remove: (urls: string[], owner?: string) => void };

const OPEN_IN_PROFILE: Record<string, { metaKey?: boolean; shiftKey?: boolean }> = { tab: { metaKey: true, shiftKey: true }, window: { shiftKey: true }, split: {} };

const HistoryEntryView = memo(function HistoryEntryView({
  entry,
  profileId,
  merged,
  windowId,
  highlighted,
  actions,
  tile,
}: {
  entry: HistoryEntry;
  profileId: string;
  merged: boolean;
  windowId: string;
  highlighted: boolean;
  actions: EntryActions;
  tile?: number;
}) {
  const title = entry.title || entry.url;
  const host = hostLabel(entry.url);
  const owners = merged ? historyOwnersOf(entry) : undefined;
  const owner = actingOwner(owners, profileId);
  const elsewhere = owner !== undefined && owner !== profileId ? owner : undefined;
  const label = useOwnedLabel(title, owners, merged);
  const remove = (urls: string[]) => actions.remove(urls, owner);
  const shared = {
    windowId,
    card: { kind: "visit" as const, id: visitKeyOf(entry) },
    title,
    label,
    highlighted,
    subtitle: <RowSubtitle text={host} />,
    actions: [{ name: "remove", label: "Remove from History", run: () => remove([entry.url]) }],
    onPress: (e: GestureResponderEvent) => pickLibraryItem(windowId, "history", entry.url, modifiersOf(e), owner),
    onMiddleClick: () => pickLibraryItem(windowId, "history", entry.url, { middle: true }, owner),
    onContextMenu: () =>
      void openHistoryRowMenu([entry], windowId, actions.moreFromSite, remove, elsewhere ? (choice) => {
        const modifiers = OPEN_IN_PROFILE[choice];
        if (!modifiers) return false;
        openVisitInProfile(windowId, entry.url, elsewhere, modifiers);
        return true;
      } : undefined),
  };
  const removeButton = (
    <Button
      variant="icon"
      icon="xmark.circle.fill"
      size="l"
      tooltip="Remove from History"
      onPress={() => {
        noteLibraryQuickRemove(tile !== undefined ? "cards" : "list");
        remove([entry.url]);
      }}
    />
  );
  const iconProfile = owner ?? profileId;
  if (tile !== undefined) {
    return (
      <LibraryCard
        {...shared}
        width={tile}
        faceHeight={cardFaceHeight(tile)}
        face={<Favicon url={entry.url} favicon={entry.favicon} profileId={iconProfile} size={C.favicon} />}
        badge={owners ? <LibraryProfileBadge owners={owners} place="card" /> : null}
        corner={removeButton}
      />
    );
  }
  return (
    <LibraryRow
      {...shared}
      icon={<Favicon url={entry.url} favicon={entry.favicon} profileId={iconProfile} size={L.favicon} />}
      badge={owners ? <LibraryProfileBadge owners={owners} place="row" /> : null}
      trailing={{ width: iconButton.l.box, node: removeButton }}
    />
  );
});

export const HistorySection = memo(HistorySectionPage);
