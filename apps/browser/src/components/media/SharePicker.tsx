import {
  answerDisplayMedia,
  askForScreenRecording,
  getDisplayMediaSources,
  getDisplayMediaThumbnails,
  noteScreenRecordingMissing,
  screenRecordingAllowed,
  shareableTabs,
  shareTab,
  startSharePreviews,
  type DisplayMediaAudio,
  type DisplayMediaSource,
} from "../../state/media/screenShare";
import { runningAppIcon } from "../../state/app/system";
import { Badge, Symbol, Button, Checkbox, PANEL, PanelHeader, Popover, POPOVER_MARGIN, Segmented, tapActivates, Text, useHover } from "../ui";
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
const PREVIEW_REFRESH_MS = 5000;
const THUMB_WIDTH = 320;
const FOCUS_MS = 50;
const TAB = "tab:";
const ASPECT = 10 / 16;
const SELECTED_RING = 2;
const AUDIO_SHARED_BY_DEFAULT = { tab: true, screen: false, window: false };

type SourceKind = keyof typeof AUDIO_SHARED_BY_DEFAULT;
type Segment = "tabs" | "windows" | "screen";
type Picked = Record<Segment, string | null>;
const SEGMENTS: { value: Segment; title: string }[] = [
  { value: "tabs", title: "Tabs" },
  { value: "windows", title: "Windows" },
  { value: "screen", title: "Entire Screen" },
];
const NOTHING_PICKED: Picked = { tabs: null, windows: null, screen: null };

const audioLabel = (kind: SourceKind, audio: DisplayMediaAudio) =>
  kind === "tab" ? "Also share tab audio" : kind === "window" && audio.window === "application" ? "Also share application audio" : "Also share system audio";

const audioOffered = (kind: SourceKind | null, audio: DisplayMediaAudio | null) =>
  !!audio && (kind === "tab" ? audio.tab : kind === "screen" ? audio.screen : kind === "window" ? !!audio.window : false);

const focusList = (list: ScrollView | null) => (list as unknown as { focus?: () => void } | null)?.focus?.();

export function SharePicker({ tabId, paneWidth }: { tabId: string; paneWidth: number }) {
  const theme = useTheme();
  const request = useMedia((m) => m.displayRequests[tabId]);
  const [segment, setSegment] = useState<Segment>("tabs");
  const [picked, setPicked] = useState<Picked>(NOTHING_PICKED);
  const [sources, setSources] = useState<DisplayMediaSource[]>([]);
  const [shareAudio, setShareAudio] = useState(AUDIO_SHARED_BY_DEFAULT);
  const [icons, setIcons] = useState<Record<number, string | null>>({});
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [screenAccess, setScreenAccess] = useState<boolean | null>(null);
  const list = useRef<ScrollView>(null);
  const previewsCounted = useRef(new Set<Segment>());

  useEffect(() => {
    if (!request) return;
    setSegment("tabs");
    setPicked({ ...NOTHING_PICKED, tabs: TAB + tabId });
    setSources(request.sources);
    setShareAudio(AUDIO_SHARED_BY_DEFAULT);
    setScreenAccess(null);
    setThumbs({});
    previewsCounted.current = new Set();
    let live = true;
    void screenRecordingAllowed()
      .then((allowed) => {
        if (!live) return;
        setScreenAccess(allowed);
        if (!allowed) noteScreenRecordingMissing();
      })
      .catch(() => live && setScreenAccess(false));
    const refresh = setInterval(() => {
      void getDisplayMediaSources()
        .then((next) => live && setSources(next))
        .catch(() => {});
      void screenRecordingAllowed()
        .then((allowed) => live && setScreenAccess(allowed))
        .catch(() => {});
    }, REFRESH_MS);
    const focus = setTimeout(() => focusList(list.current), FOCUS_MS);
    return () => {
      live = false;
      clearInterval(refresh);
      clearTimeout(focus);
    };
  }, [request?.id]);

  useEffect(() => {
    const missing = [...new Set(sources.map((s) => s.pid).filter((pid): pid is number => pid !== undefined && !(pid in icons)))];
    if (!missing.length) return;
    let live = true;
    void Promise.all(missing.map(async (pid) => [pid, await runningAppIcon(pid, 20)] as const))
      .then((entries) => live && setIcons((current) => ({ ...current, ...Object.fromEntries(entries) })))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [sources]);

  const tabs = request ? [...shareableTabs(tabId)].sort((a, b) => (a.id === tabId ? -1 : b.id === tabId ? 1 : b.lastActiveAt - a.lastActiveAt)) : [];
  const screens = request && screenAccess ? sources.filter((s) => s.kind === "screen") : [];
  const windows = request && screenAccess ? sources.filter((s) => s.kind === "window") : [];
  const cards: Card[] =
    segment === "tabs"
      ? tabs.map((t) => ({ id: TAB + t.id, title: t.title || t.url, url: t.url, badge: t.id === tabId ? "This Tab" : null, kind: "tab", icon: null }))
      : segment === "screen"
        ? screens.map((s, index) => ({ id: s.id, title: screenTitle(s, index), url: "", badge: null, kind: "screen", icon: null }))
        : windows.map((s) => ({ id: s.id, title: s.name || s.app || "Window", url: "", badge: null, kind: "window", icon: s.pid !== undefined ? (icons[s.pid] ?? null) : null }));
  const selected = picked[segment];
  const selectedKind = cards.find((c) => c.id === selected)?.kind ?? null;
  const needsAccess = segment !== "tabs" && screenAccess === false;
  const loneCardId = request && cards.length === 1 && !needsAccess ? cards[0]!.id : null;
  const previewKey = request && segment !== "tabs" && screenAccess ? cards.map((c) => c.id).join("\n") : "";
  const select = (id: string | null) => setPicked((current) => (current[segment] === id ? current : { ...current, [segment]: id }));

  useEffect(() => {
    if (loneCardId && selected !== loneCardId) select(loneCardId);
  }, [loneCardId, selected]);

  useEffect(() => {
    if (!previewKey) return;
    const ids = previewKey.split("\n");
    const shown = segment;
    let live = true;
    const fetchPreviews = () => {
      const counted = previewsCounted.current.has(shown) ? null : startSharePreviews(ids.length);
      previewsCounted.current.add(shown);
      void getDisplayMediaThumbnails(ids, THUMB_WIDTH)
        .then((found) => {
          counted?.found(ids.filter((id) => !found[id]).length);
          if (live) setThumbs((current) => ({ ...current, ...found }));
        })
        .catch(() => counted?.failed());
    };
    fetchPreviews();
    const refresh = setInterval(fetchPreviews, PREVIEW_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(refresh);
    };
  }, [request?.id, previewKey]);

  if (!request) return null;
  const audioFor = (kind: SourceKind | null) => !!kind && audioOffered(kind, request.audio) && shareAudio[kind];
  const share = (id: string | null = selected) => {
    const kind = cards.find((c) => c.id === id)?.kind;
    if (!id || !kind) return;
    if (kind === "tab") return void shareTab(tabId, id.slice(TAB.length), audioFor(kind));
    answerDisplayMedia(tabId, id, audioFor(kind));
  };
  const cancel = () => answerDisplayMedia(tabId, null);
  const pickSegment = (next: Segment) => {
    setSegment(next);
    setTimeout(() => focusList(list.current), FOCUS_MS);
  };
  const width = Math.min(WIDTH, paneWidth - 24);
  const columns = width < 560 ? 2 : 3;
  const cardWidth = Math.floor((width - 2 * PANEL.rowInset - (columns - 1) * space.m) / columns);
  const frameHost = request.frameOrigin ? originForSecurityDisplay(request.frameOrigin) : "";
  const receiver = frameHost && frameHost !== originForSecurityDisplay(request.origin) ? `${frameHost}, a frame on this page,` : originForSecurityDisplay(request.origin);
  return (
    <Popover key={request.id} width={width} top={POPOVER_MARGIN} left={(paneWidth - width) / 2} onDismiss={cancel}>
      <View style={{ paddingBottom: PANEL.inset }}>
        <PanelHeader
          icon={<Symbol name="rectangle.inset.filled.and.person.filled" size={13} color={theme.icon} style={{ width: PANEL.iconSlot, height: PANEL.iconSlot }} />}
          title="Share your screen"
          subtitle={
            audioFor(selectedKind)
              ? `${receiver} will see and hear what you choose.`
              : request.audio && !request.audio.screen && !request.audio.window && selectedKind !== "tab"
                ? `${receiver} will see what you choose. Only tabs share their audio.`
                : `${receiver} will see what you choose.`
          }
        />

        <View style={{ paddingHorizontal: PANEL.inset, marginTop: space.xs, marginBottom: space.m }}>
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
            if (at < 0) return first !== undefined && select(first);
            const column = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0;
            const row = key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0;
            const next = cards[Math.min(cards.length - 1, Math.max(0, at + row * columns + column))]?.id;
            if (next !== undefined) select(next);
          }}
          style={{ maxHeight: 360 }}
          contentContainerStyle={{ paddingHorizontal: PANEL.rowInset }}
        >
          {needsAccess ? (
            <ScreenRecordingNeeded />
          ) : cards.length ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.m }}>
              {cards.map((c) => (
                <SourceCard key={c.id} card={c} width={cardWidth} thumb={thumbs[c.id] ?? null} selected={c.id === selected} onSelect={() => select(c.id)} onShare={() => share(c.id)} />
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
            <Checkbox value={shareAudio[selectedKind]} onChange={(on) => setShareAudio((current) => ({ ...current, [selectedKind]: on }))} label={audioLabel(selectedKind, request.audio)} />
          ) : null}
          <View style={{ flex: 1 }} />
          <Button variant="pill" title="Cancel" onPress={cancel} />
          <View pointerEvents={selectedKind ? "auto" : "none"} style={{ opacity: selectedKind ? 1 : opacity.disabled }}>
            <Button variant="pill" title="Share" primary onPress={() => share()} />
          </View>
        </View>
      </View>
    </Popover>
  );
}

const EMPTY = { paddingHorizontal: PANEL.inset, paddingTop: space.xs } as const;
const NOTICE = { paddingHorizontal: PANEL.inset, paddingTop: space.xs, gap: space.xs, alignItems: "flex-start" } as const;

function screenTitle(source: DisplayMediaSource, index: number) {
  const name = source.name.trim();
  return name && !/^Screen \d+$/.test(name) ? name : `Display ${index + 1}`;
}

function ScreenRecordingNeeded() {
  const { hovered, hoverProps } = useHover();
  return (
    <View style={NOTICE}>
      <Text size="small" tone="textSecondary">
        To share a window or your entire screen, turn on Ardia in System Settings › Privacy & Security › Screen Recording, then quit and reopen Ardia.
      </Text>
      <View {...hoverProps}>
        <Pressable accessibilityRole="button" accessibilityLabel="Open System Settings" onPress={() => void askForScreenRecording()} onAccessibilityTap={tapActivates(() => void askForScreenRecording())}>
          <Text size="small" weight="medium" tone="accent" style={{ textDecorationLine: hovered ? "underline" : "none" }}>
            Open System Settings
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

type Card = { id: string; title: string; url: string; badge: string | null; kind: SourceKind; icon: string | null };

const CARD_NAME = { marginTop: space.s, flexDirection: "row", alignItems: "center", gap: space.s } as const;
const CARD_TITLE = { flexShrink: 1 } as const;

function SourceCard({ card, width, thumb, selected, onSelect, onShare }: { card: Card; width: number; thumb: string | null; selected: boolean; onSelect(): void; onShare(): void }) {
  const theme = useTheme();
  const tokens = useMediaTokens();
  const { hovered, hoverProps } = useHover();
  const ring = selected ? SELECTED_RING : 0;
  const previewWidth = width - 2 * space.m;
  const previewHeight = previewWidth * ASPECT;
  const picture = useSyncExternalStore(onPicturesChanged, () => (card.kind === "tab" ? lastPicture(card.id.slice(TAB.length)) : null));
  const preview = picture?.data ?? thumb;
  return (
    <View {...hoverProps} onDoubleClick={onShare}>
      <Pressable accessibilityRole="button" accessibilityLabel={card.title} accessibilityState={{ selected }} onPress={onSelect} onAccessibilityTap={tapActivates(onSelect)}>
        <View
          style={{
            width,
            padding: space.m - ring,
            borderRadius: radius.tile,
            borderWidth: ring,
            borderColor: theme.formAccent,
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
            {preview ? (
              <Image source={{ uri: `data:image/jpeg;base64,${preview}` }} resizeMode="cover" style={{ width: previewWidth, height: previewHeight }} />
            ) : card.kind === "tab" ? (
              <Favicon url={card.url} size={32} />
            ) : card.kind === "window" && card.icon ? (
              <Image source={{ uri: card.icon }} style={{ width: 28, height: 28 }} />
            ) : (
              <Symbol name={card.kind === "screen" ? "display" : "macwindow"} size={20} color={theme.textSecondary} style={{ width: 28, height: 28 }} />
            )}
          </View>
          <View style={CARD_NAME}>
            {card.kind === "tab" ? (
              <Favicon url={card.url} size={16} />
            ) : card.kind === "window" && card.icon ? (
              <Image source={{ uri: card.icon }} style={{ width: 16, height: 16 }} />
            ) : (
              <Symbol name={card.kind === "screen" ? "display" : "macwindow"} size={12} color={theme.textSecondary} style={{ width: 16, height: 16 }} />
            )}
            <Text lines={1} size="small" style={CARD_TITLE}>
              {card.title}
            </Text>
            {card.badge ? <Badge text={card.badge} size="s" tone="accent" /> : null}
          </View>
        </View>
      </Pressable>
    </View>
  );
}
