import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Image, Pressable, StyleSheet, View, type GestureResponderEvent } from "react-native";
import { useShallow } from "zustand/react/shallow";
import { Button, MouseArea, ProgressTrack, Text, useHover, useTheme, menuRowFill, WindowBackdrop, withAlpha } from "../ui";
import { reduceMotion } from "../ui/reduceMotion";
import { usePresence } from "../ui/motion";
import { FileIcon } from "../downloads/Downloads";
import { useDownloadView } from "../downloads/useDownloadView";
import { SIDEBAR_FOOTER_DOWNLOADS } from "../sidebar/geometry";
import { openFile } from "../../state/app/system";
import { useDownloads } from "../../state/browser/hooks";
import { useWindowRootHeight, useWindowRootWidth } from "../../state/windows/rootSize";
import { cancelDownload, keepDownload, type Download } from "../../state/downloads/actions";
import { useDownload } from "../../state/downloads/hooks";
import { currentInterfaceScale } from "../../state/settings/interfaceScale";
import { noteLibraryHoverDrag, noteLibraryHoverPick } from "../../state/telemetry/libraryCounts";
import { firstThatFits, fitName, previewLineChoices, type TextWidth } from "./format";
import { LIBRARY_MOTION } from "./motion";
import { LIBRARY } from "./tokens";
import { useFileThumbnail } from "./useFileThumbnail";

const H = LIBRARY_MOTION.hover;
const L = LIBRARY.list;
const ANCHOR_X = SIDEBAR_FOOTER_DOWNLOADS.left + SIDEBAR_FOOTER_DOWNLOADS.size / 2 - H.inset;
const FILE_DRAG_SLOP_WINDOW_POINTS = 4;
const KEEP_OR_DISCARD = [
  { name: "keep", label: "Keep" },
  { name: "discard", label: "Discard" },
];

const recentIds = (list: readonly Download[]) => list.slice(0, H.count).map((d) => d.id);
const recentNames = (list: readonly Download[]) => list.slice(0, H.count).map((d) => d.filename);

export function LibraryHoverPreview({
  windowId,
  shown,
  bottom,
  onHover,
  onPicked,
  onOpenLibrary,
}: {
  windowId: string;
  shown: boolean;
  bottom: number;
  onHover: (inside: boolean) => void;
  onPicked: () => void;
  onOpenLibrary: () => void;
}) {
  const ids = useDownloads(windowId, useShallow(recentIds));
  const names = useDownloads(windowId, useShallow(recentNames));
  const { shown: visible, appear } = usePresence(shown ? ids : null, { show: H.show, hide: H.hide });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const still = reduceMotion() === true;
  const motion = useMemo(() => {
    if (still) return { opacity: appear };
    const lean = 1 - H.from;
    return {
      opacity: appear,
      transform: [
        { translateX: appear.interpolate({ inputRange: [0, 1], outputRange: [(ANCHOR_X - size.width / 2) * lean, 0] }) },
        { translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [(size.height / 2) * lean, 0] }) },
        { scale: appear.interpolate({ inputRange: [0, 1], outputRange: [H.from, 1] }) },
      ],
    };
  }, [appear, size.width, size.height, still]);
  if (!visible || !visible.length) return null;
  return (
    <Animated.View
      pointerEvents={shown ? "auto" : "none"}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        if (width !== size.width || height !== size.height) setSize({ width, height });
      }}
      accessibilityLabel="Recent Downloads"
      style={[{ position: "absolute", left: H.inset, right: H.inset, bottom }, motion]}
    >
      <SidebarSlice windowId={windowId} />
      <View style={{ paddingTop: H.pad, paddingHorizontal: H.rowInset }}>
        {visible.map((id) => (
          <PreviewRow key={id} id={id} names={names} onPicked={onPicked} onOpenLibrary={onOpenLibrary} />
        ))}
      </View>
    </Animated.View>
  );
}

function SidebarSlice({ windowId }: { windowId: string }) {
  const theme = useTheme();
  const width = useWindowRootWidth(windowId);
  const height = useWindowRootHeight(windowId);
  const view = useRef<View>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const measure = () => view.current?.measureInWindow((x, y) => setAt((was) => (was?.x === x && was.y === y ? was : { x, y })));
  useEffect(measure, [width, height]);
  return (
    <View
      ref={view}
      pointerEvents="none"
      onLayout={measure}
      style={[StyleSheet.absoluteFill, { borderRadius: H.radius, overflow: "hidden" }]}
    >
      {at && width && height ? (
        <WindowBackdrop
          vibrancy
          {...theme.backdrop}
          colors={theme.windowTint}
          grainOpacity={theme.grain}
          style={{ position: "absolute", left: -at.x, top: -at.y, width, height }}
        />
      ) : null}
    </View>
  );
}

type RowProps = { names: string[]; onPicked: () => void; onOpenLibrary: () => void };

const PreviewRow = memo(function PreviewRow({ id, ...rest }: RowProps & { id: string }) {
  const d = useDownload(id);
  return d ? <PreviewFace d={d} {...rest} /> : null;
});

function PreviewFace({ d, names, onPicked, onOpenLibrary }: RowProps & { d: Download }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const { exists, done, progress, blocked } = useDownloadView(d);
  const uri = useFileThumbnail(d, H.thumb, done);
  const choices = previewLineChoices(d, exists);
  const running = d.state === "downloading" && !blocked;
  const filename = d.filename || "Download";
  const [room, setRoom] = useState(0);
  const nameWidth = useNaturalWidth(filename, "body");
  const metaWidth = useNaturalWidth(choices.texts[0], "small");
  const name = useMemo(
    () => (room && nameWidth.ready ? fitName(filename, names, room - H.fitSlack, nameWidth.of, H.nameHeadMin) : { head: filename, kept: "" }),
    [filename, names, room, nameWidth],
  );
  const meta = room && metaWidth.ready ? firstThatFits(choices.texts, room - H.fitSlack, metaWidth.of) : choices.texts[0];
  const nameColor = exists ? withAlpha(theme.textPrimary, H.labelAlpha) : undefined;
  const tone = exists ? "textPrimary" : "textSecondary";
  const draggable = done && exists && !!d.path;
  const grab = useRef<{ x: number; y: number; dragged: boolean } | null>(null);
  const [dragged, setDragged] = useState(false);
  const press = (e: GestureResponderEvent) => {
    grab.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY, dragged: false };
    setDragged(false);
  };
  const move = (e: GestureResponderEvent) => {
    const at = grab.current;
    if (!draggable || !at || at.dragged) return;
    const moved = Math.hypot(e.nativeEvent.pageX - at.x, e.nativeEvent.pageY - at.y) * currentInterfaceScale();
    if (moved <= FILE_DRAG_SLOP_WINDOW_POINTS) return;
    at.dragged = true;
    setDragged(true);
    noteLibraryHoverDrag();
  };
  return (
    <View {...hoverProps} onTouchStart={press} onTouchMove={move}>
      <MouseArea path={draggable ? d.path : null}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${filename}, ${choices.texts[0]}`}
          accessibilityActions={blocked ? KEEP_OR_DISCARD : undefined}
          onAccessibilityAction={({ nativeEvent }) => {
            if (nativeEvent.actionName === "keep") void keepDownload(d.id);
            else if (nativeEvent.actionName === "discard") void cancelDownload(d.id);
          }}
          onPress={() => {
            if (grab.current?.dragged) return;
            if (!done) return onOpenLibrary();
            noteLibraryHoverPick();
            void openFile(d.path);
            onPicked();
          }}
        >
          {({ pressed }) => (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: H.gap,
                height: H.row,
                paddingHorizontal: H.rowPad,
                borderRadius: H.rowRadius,
                backgroundColor: hovered || (pressed && !dragged) ? menuRowFill(theme, pressed && !dragged) : undefined,
              }}
            >
              <View style={{ width: H.thumb, height: H.thumb, alignItems: "center", justifyContent: "center", opacity: exists ? 1 : L.missingOpacity }}>
                {uri ? (
                  <Image source={{ uri }} resizeMode="cover" style={{ width: H.thumb, height: H.thumb, borderRadius: H.thumbRadius }} />
                ) : (
                  <FileIcon path={d.path || d.filename} size={H.thumb} />
                )}
              </View>
              <View style={{ flex: 1, minWidth: 0, gap: H.lineGap }} onLayout={(e) => setRoom(e.nativeEvent.layout.width)}>
                {nameWidth.probe}
                {metaWidth.probe}
                <View style={{ flexDirection: "row" }}>
                  <Text lines={1} ellipsizeMode={name.kept ? "tail" : "middle"} tone={tone} color={nameColor} style={{ flexShrink: 1 }}>
                    {name.head}
                  </Text>
                  {name.kept ? (
                    <Text lines={1} tone={tone} color={nameColor} style={{ flexShrink: 0 }}>
                      {name.kept}
                    </Text>
                  ) : null}
                </View>
                {running ? <ProgressTrack value={Math.max(progress, L.progressMin)} height={L.progressHeight} tone={d.paused ? "textTertiary" : "accent"} style={{ marginVertical: H.progressGap }} /> : null}
                <Text lines={1} size="small" tone={choices.tone}>
                  {meta}
                </Text>
              </View>
              {blocked ? (
                <View style={{ flexDirection: "row" }}>
                  <Button variant="icon" icon="checkmark.circle.fill" size="l" onPress={() => void keepDownload(d.id)} tooltip="Keep" />
                  <Button variant="icon" icon="xmark.circle.fill" size="l" onPress={() => void cancelDownload(d.id)} tooltip="Discard" />
                </View>
              ) : null}
            </View>
          )}
        </Pressable>
      </MouseArea>
    </View>
  );
}

function useNaturalWidth(text: string, size: "body" | "small") {
  const [measured, setMeasured] = useState({ text: "", width: 0 });
  const ready = measured.text === text && measured.width > 0;
  const of = useMemo<TextWidth>(() => (sample) => (ready ? (measured.width * sample.length) / Math.max(1, text.length) : Infinity), [ready, measured.width, text.length]);
  const probe = (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, width: H.measureRoom, opacity: 0, alignItems: "flex-start" }}>
      <Text lines={1} size={size} onLayout={(e) => setMeasured({ text, width: e.nativeEvent.layout.width })}>
        {text}
      </Text>
    </View>
  );
  return useMemo(() => ({ ready, of, probe }), [ready, of, text, size]);
}
