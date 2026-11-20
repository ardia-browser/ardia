import {
  getDisplayMediaThumbnailsFor,
  noteShareSegmentOf,
  answerDisplayMedia,
  askForScreenRecording,
  noteScreenRecordingMissing,
  screenRecordingAllowed,
  shareableTabs,
  shareTab,
  type DisplayMediaAudio,
  type DisplayMediaSource,
} from "../../state/media/screenShare";
import { runningAppIcon } from "../../state/app/system";
import { Badge, Symbol, Button, Checkbox, DialogActions, PANEL, PanelHeader, Popover, POPOVER_MARGIN, Segmented, Text, useHover } from "../ui";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Image, Pressable, ScrollView, View } from "react-native";
import { useTheme } from "../ui/theme";
import { hairline, opacity, radius, space } from "../ui/tokens";
import { useMediaTokens } from "./tokens";
import { Favicon } from "../favicon/Favicon";
import { useMedia } from "../../state/media/media";
import { originForSecurityDisplay } from "../../lib/url";
import { lastPicture, onPicturesChanged } from "../../state/tabs/tabPictures";

const WIDTH = 600;
const REFRESH_MS = 2500;
const THUMB_WIDTH = 320;
const FOCUS_MS = 50;
const TAB = "tab:";
const ASPECT = 10 / 16;
const AUDIO_SHARED_BY_DEFAULT = { tab: true, screen: false, window: false };

type SourceKind = keyof typeof AUDIO_SHARED_BY_DEFAULT;
type Segment = "tabs" | "windows" | "screen";
const SEGMENTS: { value: Segment; title: string }[] = [
  { value: "tabs", title: "Tabs" },
  { value: "windows", title: "Windows" },
  { value: "screen", title: "Entire Screen" },
];

const audioLabel = (kind: SourceKind, audio: DisplayMediaAudio) =>
  kind === "tab" ? "Also share tab audio" : kind === "window" && audio.window === "application" ? "Also share application audio" : "Also share system audio";

const audioOffered = (kind: SourceKind | null, audio: DisplayMediaAudio | null) =>
  !!audio && (kind === "tab" ? audio.tab : kind === "screen" ? audio.screen : kind === "window" ? !!audio.window : false);

export function SharePicker({ tabId, paneWidth }: { tabId: string; paneWidth: number }) {
  const theme = useTheme();
  const tokens = useMediaTokens();
  const request = useMedia((m) => m.displayRequests[tabId]);
  const [segment, setSegment] = useState<Segment>("tabs");
  const [sources, setSources] = useState<DisplayMediaSource[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [shareAudio, setShareAudio] = useState(AUDIO_SHARED_BY_DEFAULT);
  const [icons, setIcons] = useState<Record<number, string | null>>({});
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [screenAccess, setScreenAccess] = useState<boolean | null>(null);
  const list = useRef<ScrollView>(null);
  const asked = useRef(new Set<string>());

  useEffect(() => {
    if (!request) return;
    setSources(request.sources);
    setSelected(TAB + tabId);
    setShareAudio(AUDIO_SHARED_BY_DEFAULT);
    setScreenAccess(null);
    setThumbs({});
    asked.current = new Set();
    let live = true;
    void screenRecordingAllowed().then((allowed) => {
      if (!live) return;
      setScreenAccess(allowed);
      if (!allowed) noteScreenRecordingMissing();
    });
    const t = setInterval(() => {
      void screenRecordingAllowed().then((allowed) => live && setScreenAccess(allowed));
    }, REFRESH_MS);
    const focusList = setTimeout(() => (list.current as unknown as { focus?: () => void } | null)?.focus?.(), FOCUS_MS);
    return () => {
      live = false;
      clearInterval(t);
      clearTimeout(focusList);
    };
  }, [request?.id]);

  useEffect(() => {
    const missing = [...new Set(sources.map((s) => s.pid).filter((pid): pid is number => pid !== undefined && !(pid in icons)))];
    if (!missing.length) return;
    void Promise.all(missing.map(async (pid) => [pid, await runningAppIcon(pid, 20)] as const)).then((entries) =>
      setIcons((current) => ({ ...current, ...Object.fromEntries(entries) })),
    );
  }, [sources]);

  const tabs = [ ...shareableTabs(tabId) ].sort((a, b) => (a.id === tabId ? -1 : b.id === tabId ? 1 : b.lastActiveAt - a.lastActiveAt));
  const screens = request && screenAccess ? sources.filter((s) => s.kind === "screen") : [];
  const windows = request && screenAccess ? sources.filter((s) => s.kind === "window") : [];
  const isTab = (id: string | null) => !!id && id.startsWith(TAB) && tabs.some((t) => TAB + t.id === id);
  const kindOf = (id: string | null): SourceKind | null => (isTab(id) ? "tab" : ([...screens, ...windows].find((s) => s.id === id)?.kind ?? null));
  const valid = !!kindOf(selected);
  const selectedKind = kindOf(selected);
  const audioFor = (kind: SourceKind | null) => !!kind && !!request && audioOffered(kind, request.audio) && shareAudio[kind];
  const share = (id: string | null = selected) => {
    const kind = kindOf(id);
    if (!id || !kind || !request) return;
    noteShareSegmentOf(id);
    if (kind === "tab") return void shareTab(tabId, id.slice(TAB.length), audioFor(kind));
    answerDisplayMedia(tabId, id, audioFor(kind));
  };
  const cancel = () => answerDisplayMedia(tabId, null);
  const width = Math.min(WIDTH, paneWidth - 24);
  const columns = width < 560 ? 2 : 3;
  const cardWidth = (width - 2 * PANEL.inset - (columns - 1) * space.m) / columns;
  const cards = !request
    ? []
    : segment === "tabs"
      ? tabs.map((t) => ({ id: TAB + t.id, title: t.title || t.url, badge: t.id === tabId ? "This Tab" : null, kind: "tab" as const, source: null, icon: null }))
      : segment === "screen"
        ? screens.map((s) => ({ id: s.id, title: screenTitle(s), badge: null, kind: "screen" as const, source: s, icon: null }))
        : windows.map((s) => ({ id: s.id, title: s.name || s.app || "Window", badge: null, kind: "window" as const, source: s, icon: s.pid !== undefined ? (icons[s.pid] ?? null) : null }));
  const needsAccess = segment !== "tabs" && screenAccess === false;
  const loneCardId = request && cards.length === 1 && !needsAccess ? cards[0]!.id : null;
  useEffect(() => {
    if (loneCardId && selected !== loneCardId) setSelected(loneCardId);
  }, [loneCardId, selected]);
  const pickSegment = (next: Segment) => {
    setSegment(next);
    const nextCards = next === "tabs" ? tabs.map((t) => TAB + t.id) : next === "screen" ? screens.map((s) => s.id) : windows.map((s) => s.id);
    setSelected(nextCards.length === 1 ? nextCards[0]! : null);
    setTimeout(() => (list.current as unknown as { focus?: () => void } | null)?.focus?.(), FOCUS_MS);
  };
  const missingThumbs = cards.filter((c) => c.kind !== "tab" && !(c.id in thumbs) && !asked.current.has(c.id)).map((c) => c.id);
  if (missingThumbs.length) {
    for (const id of missingThumbs) asked.current.add(id);
    void getDisplayMediaThumbnailsFor(missingThumbs, THUMB_WIDTH).then((found) => setThumbs((current) => ({ ...current, ...found })));
  }

  if (!request) return null;
  const frameHost = request.frameOrigin ? originForSecurityDisplay(request.frameOrigin) : "";
  const receiver = frameHost && frameHost !== originForSecurityDisplay(request.origin) ? `${frameHost}, a frame on this page,` : originForSecurityDisplay(request.origin);
  return (
    <Popover key={request.id} width={width} top={POPOVER_MARGIN} left={(paneWidth - width) / 2} onDismiss={cancel}>
      <View style={{ paddingBottom: PANEL.inset }}>
        <PanelHeader
          icon={
            <Symbol name="rectangle.inset.filled.and.person.filled" size={13} color={theme.icon} style={{ width: PANEL.iconSlot, height: PANEL.iconSlot }} />
          }
          title="Share your screen"
          subtitle={
            audioFor(selectedKind)
              ? `${receiver} will see and hear what you choose.`
              : request.audio && !request.audio.screen && !request.audio.window && selectedKind !== "tab"
                ? `${receiver} will see what you choose. Only tabs share their audio.`
                : `${receiver} will see what you choose.`
          }
        />

        <View style={{ paddingHorizontal: PANEL.inset, marginTop: space.xs, marginBottom: space.s }}>
          <Segmented options={SEGMENTS} value={segment} onChange={pickSegment} fill />
        </View>

        <ScrollView
          ref={list}
          focusable
          enableFocusRing={false}
          keyDownEvents={[{ key: "Escape" }, { key: "Enter" }, { key: "ArrowLeft" }, { key: "ArrowRight" }, { key: "ArrowUp" }, { key: "ArrowDown" }]}
          onKeyDown={(e) => {
            const key = e.nativeEvent.key;
            if (key === "Escape") return cancel();
            if (key === "Enter") return share();
            const at = cards.findIndex((c) => c.id === selected);
            const first = cards[0]?.id;
            if (at < 0) return first !== undefined && setSelected(first);
            const column = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0;
            const row = key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0;
            const next = Math.min(cards.length - 1, Math.max(0, at + row * columns + column));
            const picked = cards[next]?.id;
            if (picked !== undefined && picked !== selected) setSelected(picked);
          }}
          style={{ maxHeight: 360 }}
          contentContainerStyle={{ paddingHorizontal: PANEL.rowInset, paddingTop: space.xs }}
        >
          {needsAccess ? (
            <ScreenRecordingNeeded />
          ) : cards.length ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.m }}>
              {cards.map((c) => (
                <SourceCard
                  key={c.id}
                  card={c}
                  width={cardWidth}
                  thumb={thumbs[c.id] ?? null}
                  selected={c.id === selected}
                  onSelect={() => setSelected(c.id)}
                  onShare={() => share(c.id)}
                />
              ))}
            </View>
          ) : (
            <Text size="small" tone="textSecondary" style={EMPTY}>
              {segment === "tabs" ? "No other tabs can be shared right now." : "Nothing can be shared right now."}
            </Text>
          )}
        </ScrollView>

        <View style={{ flexDirection: "row", alignItems: "center", gap: space.m, paddingHorizontal: PANEL.inset, marginTop: space.l }}>
          {selectedKind && request.audio && audioOffered(selectedKind, request.audio) ? (
            <Checkbox
              value={shareAudio[selectedKind]}
              onChange={(on) => setShareAudio((current) => ({ ...current, [selectedKind]: on }))}
              label={audioLabel(selectedKind, request.audio)}
            />
          ) : null}
          <View style={{ flex: 1 }} />
          <Button variant="pill" title="Cancel" onPress={cancel} />
          <View pointerEvents={valid ? "auto" : "none"} style={{ opacity: valid ? 1 : opacity.disabled }}>
            <Button variant="pill" title="Share" primary onPress={() => share()} />
          </View>
        </View>
      </View>
    </Popover>
  );
}

const EMPTY = { paddingHorizontal: PANEL.inset, paddingTop: space.xs } as const;
const NOTICE = { paddingHorizontal: PANEL.inset, paddingTop: space.xs, gap: space.xs, alignItems: "flex-start" } as const;

function screenTitle(source: DisplayMediaSource) {
  if (source.name && !/^Screen \d+$/.test(source.name)) return source.name;
  return "Built-in Display";
}

function ScreenRecordingNeeded() {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <View style={NOTICE}>
      <Text size="small" tone="textSecondary">
        To share a window or your entire screen, turn on Ardia in System Settings › Privacy & Security › Screen Recording, then quit and reopen Ardia.
      </Text>
      <View {...hoverProps}>
        <Pressable onPress={() => void askForScreenRecording()}>
          <Text size="small" weight="medium" tone="accent" style={{ textDecorationLine: hovered ? "underline" : "none" }}>Open System Settings</Text>
        </Pressable>
      </View>
    </View>
  );
}

type Card = { id: string; title: string; badge: string | null; kind: SourceKind; source: DisplayMediaSource | null; icon: string | null };

const CARD_NAME = { marginTop: space.s, flexDirection: "row", alignItems: "center", gap: space.s } as const;
const CARD_TITLE = { flexShrink: 1 } as const;

function SourceCard({ card, width, thumb, selected, onSelect, onShare }: { card: Card; width: number; thumb: string | null; selected: boolean; onSelect(): void; onShare(): void }) {
  const theme = useTheme();
  const tokens = useMediaTokens();
  const { hovered, hoverProps } = useHover();
  const previewWidth = width - 2 * space.m;
  const previewHeight = previewWidth * ASPECT;
  const picture = useSyncExternalStore(onPicturesChanged, () => (card.kind === "tab" ? lastPicture(card.id.slice(TAB.length)) : null));
  return (
    <View {...hoverProps} onDoubleClick={onShare}>
      <Pressable onPress={onSelect}>
        <View
          style={{
            width,
            padding: space.m,
            borderRadius: radius.tile,
            borderWidth: selected ? hairline.panel : 0,
            borderColor: tokens.pickerSelectedStroke,
            backgroundColor: selected ? tokens.pickerSelected : hovered ? theme.rowHover : undefined,
          }}
        >
          <View
            style={{
              width: previewWidth,
              height: previewHeight,
              borderRadius: radius.control,
              borderWidth: hairline.panel,
              borderColor: tokens.previewBorder,
              backgroundColor: tokens.previewFill,
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
            }}
          >
            {picture ? (
              <Image source={{ uri: `data:image/jpeg;base64,${picture.data}` }} resizeMode="cover" style={{ width: previewWidth, height: previewHeight }} />
            ) : thumb ? (
              <Image source={{ uri: `data:image/jpeg;base64,${thumb}` }} resizeMode="cover" style={{ width: previewWidth, height: previewHeight }} />
            ) : card.kind === "tab" ? (
              <Favicon url={tabUrlOf(card.id)} size={32} />
            ) : card.kind === "window" && card.icon ? (
              <Image source={{ uri: card.icon }} style={{ width: 28, height: 28 }} />
            ) : (
              <Symbol name={card.kind === "screen" ? "display" : "macwindow"} size={20} color={theme.textSecondary} style={{ width: 28, height: 28 }} />
            )}
          </View>
          <View style={CARD_NAME}>
            {card.kind === "tab" ? <Favicon url={tabUrlOf(card.id)} size={16} /> : card.kind === "window" && card.icon ? <Image source={{ uri: card.icon }} style={{ width: 16, height: 16 }} /> : <Symbol name={card.kind === "screen" ? "display" : "macwindow"} size={12} color={theme.textSecondary} style={{ width: 16, height: 16 }} />}
            <Text lines={1} size="small" style={CARD_TITLE}>
              {card.title}
            </Text>
            {card.badge ? <Badge text={card.badge} size="s" /> : null}
          </View>
        </View>
      </Pressable>
    </View>
  );
}

function tabUrlOf(id: string) {
  const shared = id.slice(TAB.length);
  return shareableTabs(shared).find((t) => t.id === shared)?.url ?? "";
}
