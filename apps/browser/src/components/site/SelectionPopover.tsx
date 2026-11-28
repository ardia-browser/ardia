import { useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { useSettings } from "../../state/browser/hooks";
import { useTabValue } from "../../state/tabs/tabWatch";
import { consentToken, type ConsentToken } from "../../state/telemetry/client";
import { notePageOverlay } from "../../state/telemetry/usage";
import { defaultSearchEngine } from "../../state/settings/settings";
import { snappedToDevicePixels } from "../../state/settings/interfaceScale";
import { POPOVER_MOTION, PopoverSurface, space } from "../ui";
import { searchSelection, setPageSelection, usePageSelection, type ClickModifiers, type PageSelection } from "../../state/site/selection";
import { selectionBar } from "./tokens";
import { ChipButton, SITE_PANEL } from "./SiteControlsParts";

const HEIGHT = SITE_PANEL.footerControl + 2 * space.xs;
const GAP = 6;

export function SelectionPopover({ tabId }: { tabId: string }) {
  const zoom = useTabValue(tabId, (t) => t?.zoom ?? 1);
  const enabled = useSettings((st) => st.showSelectionSearch);
  const selection = usePageSelection((s) => (enabled ? (s[tabId] ?? null) : null));
  const [shown, setShown] = useState<{ selection: PageSelection; consent: ConsentToken | null } | null>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!selection) return setShown(null);
    const consent = consentToken();
    const timer = setTimeout(() => setShown({ selection, consent }), selectionBar.showDelay);
    return () => clearTimeout(timer);
  }, [selection]);
  useEffect(() => () => setPageSelection(tabId, null), [tabId]);
  const counted = useRef(false);
  const returned = useRef(false);
  useEffect(() => {
    if (shown) return;
    counted.current = false;
    returned.current = false;
  }, [shown]);
  const noteShown = () => {
    if (counted.current || !shown) return;
    counted.current = true;
    notePageOverlay("paneOverlayOpened", returned.current ? consentToken() : shown.consent);
  };
  const noteHidden = () => {
    if (counted.current) returned.current = true;
    counted.current = false;
  };
  if (!selection && !shown) return null;

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill} onLayout={(e) => setArea(e.nativeEvent.layout)}>
      {shown && area.width > 0 && <SelectionBar key={`${shown.selection.rect.x},${shown.selection.rect.y}`} tabId={tabId} selection={shown.selection} zoom={zoom} area={area} onShown={noteShown} onHidden={noteHidden} />}
    </View>
  );
}

type Area = { width: number; height: number };

export function barPlacement(rect: PageSelection["rect"], zoom: number, area: Area, width: number) {
  const top = rect.y * zoom;
  const bottom = (rect.y + rect.height) * zoom;
  if (bottom < 0 || top > area.height) return null;
  const above = top - GAP - HEIGHT >= 4;
  const y = above ? top - GAP - HEIGHT : Math.min(bottom + GAP, area.height - HEIGHT - 4);
  const center = (rect.x + rect.width / 2) * zoom;
  const barWidth = snappedToDevicePixels(width);
  const x = snappedToDevicePixels(Math.max(8, Math.min(center - barWidth / 2, area.width - barWidth - 8)));
  return { x, y, above };
}

function SelectionBar({ tabId, selection, zoom, area, onShown, onHidden }: { tabId: string; selection: PageSelection; zoom: number; area: Area; onShown: () => void; onHidden: () => void }) {
  const [width, setWidth] = useState(0);
  const appear = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(appear, { toValue: 1, ...POPOVER_MOTION.open, useNativeDriver: true }).start();
  }, []);
  const placement = barPlacement(selection.rect, zoom, area, width);
  const inPane = placement !== null;
  const visible = inPane && width > 0;
  useEffect(() => {
    if (visible) onShown();
    else if (!inPane) onHidden();
  }, [visible, inPane]);
  if (!placement) return null;
  const { x, y, above } = placement;

  return (
    <Animated.View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{
        position: "absolute",
        left: x,
        top: y,
        opacity: width ? appear : 0,
        transformOrigin: above ? "center bottom" : "center top",
        transform: [
          { scale: appear.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) },
          { translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [above ? 3 : -3, 0] }) },
        ],
      }}
    >
      <PopoverSurface glass style={{ height: HEIGHT, padding: space.xs, flexDirection: "row", alignItems: "center" }}>
        <SearchButton tabId={tabId} text={selection.text} />
      </PopoverSurface>
    </Animated.View>
  );
}

function SearchButton({ tabId, text }: { tabId: string; text: string }) {
  const engine = useSettings((st) => defaultSearchEngine(st).name);
  const quoted = text.length > 40 ? `${text.slice(0, 40).trimEnd()}…` : text;
  return (
    <ChipButton
      quiet
      icon="magnifyingglass"
      title="Search"
      tooltip={`Search ${engine} for “${quoted.replace(/\s+/g, " ")}”`}
      label={`Search ${engine}`}
      onPress={(e) => searchSelection(tabId, text, e.nativeEvent as unknown as ClickModifiers)}
    />
  );
}
