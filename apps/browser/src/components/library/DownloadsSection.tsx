import { memo, type ReactNode, type RefObject, useCallback, useRef } from "react";
import { View, type GestureResponderEvent } from "react-native";
import { revealFile } from "../../state/app/system";
import { cancelDownload, keepDownload, type Download } from "../../state/downloads/actions";
import { downloadMenu } from "../../state/downloads/downloadMenu";
import { useDownload } from "../../state/downloads/hooks";
import { pickLibraryItem } from "../../state/library/actions";
import { useLibraryDayGroups, useLibraryScope, useSectionLive } from "../../state/library/hooks";
import { soleOwner } from "../../state/library/profileScope";
import { mediaTypeOf, type DownloadItem } from "../../state/library/items";
import type { LibraryView } from "../../state/library/views";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import { modifiersOf } from "../../lib/keys";
import { Button, iconButton, ProgressTrack, space } from "../ui";
import { FileIcon } from "../downloads/Downloads";
import { useDownloadView } from "../downloads/useDownloadView";
import { CardGrid } from "./CardGrid";
import { LibraryViewPair } from "./LibraryViewPair";
import { DayList } from "./DayList";
import { LibraryCard } from "./LibraryCard";
import { LibraryRow, RowSubtitle } from "./LibraryRow";
import { Thumbnail } from "./MediaSection";
import { downloadLine } from "./format";
import { cardFaceHeight, LIBRARY, textCardHeight } from "./tokens";
import { useFileThumb } from "./useFileThumbnail";
import { LibraryProfileBadge, useOwnedLabel } from "./LibraryProfileBadge";

const L = LIBRARY.list;
const C = LIBRARY.card;
const G = LIBRARY.grid;
const REVEAL_WIDTH = iconButton.l.box;
const PROGRESS = { marginTop: space.xxs } as const;
const DECIDE = { flexDirection: "row" } as const;
const DECIDE_WIDTH = 2 * iconButton.l.box;
const FACE_PROGRESS = { position: "absolute", left: C.progressInset, right: C.progressInset, bottom: C.progressInset } as const;

const keyOf = (item: DownloadItem) => item.id;

type SectionProps = { windowId: string; panelWidth: number; entry: RefObject<(() => void) | null>; empty: ReactNode };

function DownloadsSectionPage({ view, windowId, panelWidth, entry, empty }: SectionProps & { view: LibraryView }) {
  const groups = useLibraryDayGroups(windowId, "downloads");
  const live = useSectionLive(windowId, "downloads");
  const merged = useLibraryScope(windowId).merged;
  const open = useCallback((item: DownloadItem) => pickLibraryItem(windowId, "downloads", item.id, {}, merged ? soleOwner(item.owners) : undefined), [windowId, merged]);
  const renderRow = useCallback(
    (item: DownloadItem, highlighted: boolean) => <DownloadEntry id={item.id} listed={item.download} owners={merged ? item.owners : undefined} windowId={windowId} highlighted={highlighted} />,
    [windowId, merged],
  );
  const renderCard = useCallback(
    (item: DownloadItem, tile: number, highlighted: boolean) => (
      <DownloadEntry id={item.id} listed={item.download} owners={merged ? item.owners : undefined} windowId={windowId} highlighted={highlighted} tile={tile} />
    ),
    [windowId, merged],
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

const DownloadEntry = memo(function DownloadEntry({
  id,
  listed,
  owners,
  windowId,
  highlighted,
  tile,
}: {
  id: string;
  listed: Download;
  owners: readonly string[] | undefined;
  windowId: string;
  highlighted: boolean;
  tile?: number;
}) {
  const live = useDownload(id);
  const last = useRef(listed);
  if (live) last.current = live;
  const d = last.current;
  const view = useDownloadView(d);
  const { exists, done, progress, blocked } = view;
  const line = downloadLine(d, exists);
  const running = d.state === "downloading" && !blocked;
  const name = d.filename || "Download";
  const label = useOwnedLabel(name, owners, !!owners);
  const onPress = (e: GestureResponderEvent) => {
    if (done) pickLibraryItem(windowId, "downloads", d.id, modifiersOf(e), soleOwner(owners));
  };
  const onContextMenu = () => void downloadMenu(d, windowId);
  const actions = blocked
    ? [
        { name: "keep", label: "Keep", run: () => void keepDownload(d.id) },
        { name: "discard", label: "Discard", run: () => void cancelDownload(d.id) },
      ]
    : done && exists
      ? [{ name: "reveal", label: `Show in ${PLATFORM_TERMS.fileManager}`, run: () => void revealFile(d.path) }]
      : undefined;
  const bar = running ? <ProgressTrack value={Math.max(progress, L.progressMin)} height={L.progressHeight} tone={d.paused ? "textTertiary" : "accent"} style={tile ? FACE_PROGRESS : PROGRESS} /> : null;
  if (tile !== undefined) {
    return (
      <LibraryCard
        windowId={windowId}
        card={{ kind: "download", id: d.id }}
        width={tile}
        faceHeight={cardFaceHeight(tile)}
        highlighted={highlighted}
        label={label}
        title={name}
        muted={!exists}
        truncate="middle"
        path={done ? d.path : null}
        face={
          <>
            <DownloadFace d={d} exists={exists} box={cardFaceHeight(tile) - 2 * G.tileInset} />
            {bar}
          </>
        }
        subtitle={<RowSubtitle text={line.text} tone={line.tone} />}
        badge={owners ? <LibraryProfileBadge owners={owners} place="card" /> : null}
        onPress={onPress}
        onContextMenu={onContextMenu}
        actions={actions}
      />
    );
  }
  return (
    <LibraryRow
      windowId={windowId}
      card={{ kind: "download", id: d.id }}
      icon={
        <View style={{ opacity: exists ? 1 : L.missingOpacity }}>
          <FileIcon path={d.path || d.filename} size={L.fileIcon} />
        </View>
      }
      title={name}
      label={label}
      muted={!exists}
      truncate="middle"
      highlighted={highlighted}
      path={done ? d.path : null}
      badge={owners ? <LibraryProfileBadge owners={owners} place="row" /> : null}
      subtitle={
        <>
          {bar}
          <RowSubtitle text={line.text} tone={line.tone} />
        </>
      }
      trailing={blocked ? {
        width: DECIDE_WIDTH,
        always: true,
        node: (
          <View style={DECIDE}>
            <Button variant="icon" icon="checkmark.circle.fill" size="l" onPress={() => void keepDownload(d.id)} tooltip="Keep" />
            <Button variant="icon" icon="xmark.circle.fill" size="l" onPress={() => void cancelDownload(d.id)} tooltip="Discard" />
          </View>
        ),
      } : done ? { width: REVEAL_WIDTH, node: <Button variant="icon" icon="magnifyingglass.circle.fill" size="l" onPress={() => void revealFile(d.path)} tooltip={`Show in ${PLATFORM_TERMS.fileManager}`} /> } : undefined}
      onPress={onPress}
      onContextMenu={onContextMenu}
      actions={actions}
    />
  );
});

function DownloadFace({ d, exists, box }: { d: Download; exists: boolean; box: number }) {
  const media = mediaTypeOf(d);
  const thumb = useFileThumb(d, Math.round(box), exists && d.state === "finished" && (media === "image" || media === "video"));
  if (thumb) return <Thumbnail thumb={thumb} box={box} />;
  return (
    <View style={{ opacity: exists ? 1 : L.missingOpacity }}>
      <FileIcon path={d.path || d.filename} size={Math.min(C.fileIcon, box)} />
    </View>
  );
}

export const DownloadsSection = memo(DownloadsSectionPage);
