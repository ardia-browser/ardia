import { memo, useLayoutEffect, useState, type ReactNode } from "react";
import { Image, View, type LayoutChangeEvent } from "react-native";
import { displayUrl } from "@ardia/core";
import type { Download } from "../../state/downloads/actions";
import { useDownload } from "../../state/downloads/hooks";
import { useWindow } from "../../state/browser/hooks";
import { useLibraryItems, useLibraryScope, useLibraryVisit } from "../../state/library/hooks";
import { parseVisitKey, profileNamesOf } from "../../state/library/profileScope";
import { mediaTypeOf } from "../../state/library/items";
import { dismissLibraryCard } from "../../state/sidebar/hover";
import type { Anchor, LibraryItemKind } from "../../state/sidebar/sidebarUi";
import { FadeLabel, font, HoverCard, space, Text, useTheme } from "../ui";
import { FileIcon } from "../downloads/Downloads";
import { useDownloadView } from "../downloads/useDownloadView";
import { Favicon } from "../favicon/Favicon";
import { hostLabel } from "../pages/PageLayout";
import { useHoverCardOrigin } from "../sidebar/hoverMotion";
import { HOVER_CARD_GAP, HOVER_CARD_HEADER } from "../sidebar/hoverPlacement";
import { byteSize, downloadLine, fileKind, folderLabel, visitCount, whenLong } from "./format";
import { aspectOf, dimensionsLabel, fitInBox } from "./thumbnailFit";
import { useFileThumb, useImageSize } from "./useFileThumbnail";

const WIDTH = 264;
const PAD = space.ml;
const PREVIEW_MAX = 160;
const LABEL_WIDTH = 72;
const HEADER = { flexDirection: "row", alignItems: "center", gap: space.s, height: HOVER_CARD_HEADER } as const;
const TITLE = { flex: 1, height: HOVER_CARD_HEADER } as const;
const FACTS = { marginTop: space.s, gap: space.xxs } as const;
const FACT = { flexDirection: "row", gap: space.s } as const;
const FACT_VALUE = { flex: 1 } as const;

type Fact = { label: string; value: string; tone?: "textSecondary" | "destructive" };

type Place = { windowId: string; anchor: Anchor; windowHeight: number };

export function LibraryItemCard({ kind, id, windowId, anchor, windowHeight }: { kind: LibraryItemKind; id: string } & Place) {
  const place = { windowId, anchor, windowHeight };
  return kind === "visit" ? <VisitDetails visitKey={id} place={place} /> : <FileDetails kind={kind} id={id} place={place} />;
}

function Frame({ place, children }: { place: Place; children: ReactNode }) {
  const origin = useHoverCardOrigin(place.anchor);
  const [height, setHeight] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setHeight(Math.round(e.nativeEvent.layout.height));
  const top = height ? Math.max(HOVER_CARD_GAP, Math.min(origin.top, place.windowHeight - HOVER_CARD_GAP - height)) : origin.top;
  return (
    <HoverCard pointerEvents="none" width={WIDTH} pad="ml" onLayout={onLayout} style={{ position: "absolute", ...origin, top }}>
      {children}
    </HoverCard>
  );
}

function Gone({ windowId }: { windowId: string }) {
  useLayoutEffect(() => dismissLibraryCard(windowId), [windowId]);
  return null;
}

function FileDetails({ kind, id, place }: { kind: "media" | "download"; id: string; place: Place }) {
  const items = useLibraryItems(place.windowId, kind === "media" ? "media" : "downloads");
  const item = items.find((entry) => entry.id === id);
  const live = useDownload(id);
  const d = live ?? item?.download;
  const owners = useOwnerNames(place.windowId, item?.owners);
  if (!d) return <Gone windowId={place.windowId} />;
  return (
    <Frame place={place}>
      <FileFacts key={d.id} d={d} owners={owners} />
    </Frame>
  );
}

function useOwnerNames(windowId: string, owners: readonly string[] | undefined) {
  const { merged, profiles } = useLibraryScope(windowId);
  return merged ? profileNamesOf(owners, profiles) : "";
}

const ownerFact = (names: string): Fact | null => (names ? { label: names.includes(", ") ? "Profiles" : "Profile", value: names } : null);

const FileFacts = memo(function FileFacts({ d, owners }: { d: Download; owners: string }) {
  const theme = useTheme();
  const { exists } = useDownloadView(d);
  const name = d.filename || d.path || "Download";
  const line = downloadLine(d, exists);
  const finished = d.state === "finished";
  const media = mediaTypeOf(d);
  const ready = exists && finished;
  const box = WIDTH - 2 * PAD;
  const preview = useFileThumb(d, box, ready && (media === "image" || media === "video"));
  const size = useImageSize(d, ready && media === "image");
  const at = d.startTime;
  const facts: Fact[] = [
    { label: "Kind", value: fileKind(name, d.mimeType) },
    finished && exists ? { label: "Size", value: byteSize(d.total > 0 ? d.total : d.received) } : { label: "Status", value: line.text, tone: line.tone },
    size ? { label: "Dimensions", value: dimensionsLabel(size) } : null,
    at ? { label: finished ? "Downloaded" : "Started", value: whenLong(at) } : null,
    d.url && !d.url.startsWith("file:") ? { label: "From", value: hostLabel(d.url) } : null,
    d.path && exists ? { label: "Where", value: folderLabel(d.path) } : null,
    ownerFact(owners),
  ].filter((fact): fact is Fact => !!fact);
  const fit = preview ? fitInBox(box, aspectOf(preview)) : null;
  const shown = fit && fit.height > PREVIEW_MAX ? { width: (fit.width * PREVIEW_MAX) / fit.height, height: PREVIEW_MAX } : fit;
  return (
    <>
      <View style={HEADER}>
        <FileIcon path={d.path || d.filename} size={16} />
        <FadeLabel text={name} fontSize={font.body.fontSize} weight="medium" color={exists ? theme.textPrimary : theme.textSecondary} style={TITLE} />
      </View>
      {preview && shown ? (
        <Image
          source={{ uri: preview.uri }}
          resizeMode="cover"
          style={{ marginTop: space.s, alignSelf: "center", width: shown.width, height: shown.height, borderRadius: space.s }}
        />
      ) : null}
      <Facts facts={facts} />
    </>
  );
});

function VisitDetails({ visitKey, place }: { visitKey: string; place: Place }) {
  const theme = useTheme();
  const { windowId } = place;
  const entry = useLibraryVisit(windowId, visitKey);
  const owner = parseVisitKey(visitKey).profileId;
  const windowProfile = useWindow(windowId, (w) => w?.profileId ?? "");
  const profileId = owner ?? windowProfile;
  const owners = useOwnerNames(windowId, owner === null ? undefined : [owner]);
  if (!entry) return <Gone windowId={windowId} />;
  const visits = entry.visitTimes?.length ? Math.max(entry.visits, entry.visitTimes.length) : entry.visits;
  const first = entry.visitTimes?.length ? earliest(entry.visitTimes) : null;
  const facts: Fact[] = [
    { label: "Last Visit", value: whenLong(entry.lastVisit) },
    first && visits > 1 && first < entry.lastVisit ? { label: "First Visit", value: whenLong(first) } : null,
    visits > 0 ? { label: "Visited", value: visitCount(visits) } : null,
    ownerFact(owners),
  ].filter((fact): fact is Fact => !!fact);
  return (
    <Frame place={place}>
      <View style={HEADER}>
        <Favicon url={entry.url} favicon={entry.favicon} profileId={profileId} size={16} />
        <FadeLabel text={entry.title || displayUrl(entry.url)} fontSize={font.body.fontSize} weight="medium" color={theme.textPrimary} style={TITLE} />
      </View>
      <Text lines={2} size="caption" tone="textSecondary" style={{ marginTop: space.xxs }}>
        {displayUrl(entry.url)}
      </Text>
      <Facts facts={facts} />
    </Frame>
  );
}

function earliest(times: readonly number[]) {
  let first = times[0]!;
  for (const t of times) if (t < first) first = t;
  return first;
}

function Facts({ facts }: { facts: Fact[] }) {
  return (
    <View style={FACTS}>
      {facts.map((fact) => (
        <View key={fact.label} style={FACT}>
          <Text size="caption" tone="textTertiary" style={{ width: LABEL_WIDTH }}>
            {fact.label}
          </Text>
          <Text size="caption" tone={fact.tone ?? "textSecondary"} lines={2} style={FACT_VALUE}>
            {fact.value}
          </Text>
        </View>
      ))}
    </View>
  );
}
