import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Button } from "../ui";
import { DOWNLOADS_HIT, useDownloadsAnchor } from "../downloads/DownloadsButton";
import { SIDEBAR_FOOTER_DOWNLOADS } from "../sidebar/geometry";
import { PROFILE_DOTS_HEIGHT } from "../profiles/ProfileDots";
import { useShortcutHint, withShortcut } from "../../state/commands/commandShortcuts";
import { openLibrary, toggleLibrary } from "../../state/library/actions";
import { useLibraryOpen } from "../../state/library/hooks";
import { useWindowUiOf } from "../../state/windows/hooks";
import { useDownloads } from "../../state/browser/hooks";
import { consentToken } from "../../state/telemetry/client";
import { noteLibraryHoverPreview } from "../../state/telemetry/libraryCounts";
import { LibraryHoverPreview } from "./LibraryHoverPreview";
import { LibraryGlyph } from "./LibraryGlyph";
import { LIBRARY_GLYPH_LABELS, useLibraryGlyph } from "./useLibraryGlyph";
import { LIBRARY_MOTION } from "./motion";

const H = LIBRARY_MOTION.hover;
const ACTIVATE = [{ name: "activate" as const }];

export function LibraryFooter({ windowId, footer }: { windowId: string; footer: number }) {
  const open = useLibraryOpen(windowId);
  const popoverOpen = useWindowUiOf(windowId, (ui) => !!ui?.downloadsOpen);
  const hasDownloads = useDownloads(windowId, (list) => list.length > 0);
  const hint = useShortcutHint("toggleLibrary");
  const view = useRef<View>(null);
  useDownloadsAnchor(windowId, view);
  const [preview, setPreview] = useState(false);
  const [bounce, setBounce] = useState(0);
  const over = useRef({ button: false, preview: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const dismiss = () => {
    clear();
    over.current = { button: false, preview: false };
    setPreview(false);
  };
  const settle = () => {
    clear();
    const { button, preview: inPreview } = over.current;
    if (button || inPreview) return;
    timer.current = setTimeout(() => setPreview(false), H.leaveGrace);
  };
  const enterButton = () => {
    over.current.button = true;
    clear();
    if (preview) return;
    const consent = consentToken();
    timer.current = setTimeout(() => {
      timer.current = null;
      setPreview(true);
      noteLibraryHoverPreview(consent);
    }, H.delay);
  };
  const blocked = open || popoverOpen || !hasDownloads;
  useEffect(() => {
    if (blocked) dismiss();
  }, [blocked]);
  useEffect(() => clear, []);
  const shown = preview && !blocked;
  const glyph = useLibraryGlyph(windowId, open || popoverOpen || shown);

  return (
    <>
      <View pointerEvents="box-none" style={{ position: "absolute", left: SIDEBAR_FOOTER_DOWNLOADS.left, bottom: SIDEBAR_FOOTER_DOWNLOADS.bottom }}>
        <View
          ref={view}
          collapsable={false}
          accessible
          accessibilityRole="button"
          accessibilityLabel={LIBRARY_GLYPH_LABELS[glyph]}
          accessibilityState={{ selected: open }}
          accessibilityActions={ACTIVATE}
          onAccessibilityAction={() => toggleLibrary(windowId, "button")}
          onMouseEnter={blocked ? undefined : enterButton}
          onMouseLeave={() => {
            over.current.button = false;
            settle();
          }}
        >
          <Button
            variant="icon"
            hit={DOWNLOADS_HIT()}
            active={open}
            tooltip={open || hasDownloads ? undefined : withShortcut("Library", hint)}
            onPressIn={() => setBounce((count) => count + 1)}
            onPress={() => {
              dismiss();
              toggleLibrary(windowId, "button");
            }}
          >
            <LibraryGlyph glyph={glyph} frame={SIDEBAR_FOOTER_DOWNLOADS.size} bounce={bounce} />
          </Button>
        </View>
      </View>
      <LibraryHoverPreview
        windowId={windowId}
        shown={shown}
        bottom={footer - PROFILE_DOTS_HEIGHT + SIDEBAR_FOOTER_DOWNLOADS.bottom + SIDEBAR_FOOTER_DOWNLOADS.size + H.lift}
        onOpenLibrary={() => {
          dismiss();
          openLibrary(windowId, "button", "downloads");
        }}
        onHover={(inside: boolean) => {
          over.current.preview = inside;
          if (inside) clear();
          else settle();
        }}
        onPicked={dismiss}
      />
    </>
  );
}
