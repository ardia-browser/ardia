import { createElement, useCallback, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { Pressable, Text, View, type NativeSyntheticEvent, type ViewStyle } from "react-native";
import type { PageEvent } from "@ardia/ardiacore";
import type { CaptionRegion, SymbolProps, WindowControlsNative, WindowsNative } from "@ardia/shell";
import { requireNativeModule } from "../modules";
import { Symbol } from "../symbol/Symbol";
import { useAppDark } from "../views/appearance";
import { EngineWebView } from "./EngineWebView";
import { callPage, followPage, pageOpened } from "./pages";
import { POPUP_CAPTION_HEIGHT, POPUP_ORIGIN_STRIP_HEIGHT, popupOriginText, popupSecurity, popupTitle, type PopupSecurity } from "./popupPlacement";
import { closePopupWindow, popupWindowInfo, requestPopupClose, setPopupWindowTitle, type PopupWindowInfo } from "./popupWindows";

type Controls = WindowControlsNative & Pick<WindowsNative, "addListener">;

const controls = () => requireNativeModule<Controls>("ArdiaAppWindows");

const BUTTON = { width: 30, height: 28, edge: 12, gap: 3, radius: 7, glyph: 10, glyphRadius: 1.5, restoreCorner: 2 } as const;
const BUTTON_COUNT = 3;
const CONTROLS_WIDTH = BUTTON_COUNT * BUTTON.width + (BUTTON_COUNT - 1) * BUTTON.gap;
const CONTROLS_ROOM = BUTTON.edge + CONTROLS_WIDTH + BUTTON.gap;
const TITLE_INSET = 12;
const STRIP = { inset: 10, glyph: 16, symbol: 11, gap: 5, text: 12 } as const;
const CLOSE = { hover: "#C42B1C", pressed: "#B3271A", ink: "#FFFFFF" } as const;
const CERTIFICATE_ERROR_TINT = "#FF5F57";
const PAGE_EVENTS = ["ready", "navigation", "security"];

const PALETTE = {
  dark: {
    background: "#2B2A2B",
    strip: "#323132",
    text: "rgba(255,255,255,0.85)",
    secondary: "rgba(255,255,255,0.55)",
    separator: "rgba(255,255,255,0.10)",
    hover: "rgba(255,255,255,0.08)",
    pressed: "rgba(255,255,255,0.12)",
  },
  light: {
    background: "#F4F3F4",
    strip: "#ECEBEC",
    text: "rgba(0,0,0,0.85)",
    secondary: "rgba(0,0,0,0.5)",
    separator: "rgba(0,0,0,0.10)",
    hover: "rgba(0,0,0,0.05)",
    pressed: "rgba(0,0,0,0.09)",
  },
} as const;

type Palette = (typeof PALETTE)["dark"] | (typeof PALETTE)["light"];
type ButtonKind = "minimize" | "maximize" | "restore" | "close";

const LABEL: Record<ButtonKind, string> = { minimize: "Minimize", maximize: "Maximize", restore: "Restore Down", close: "Close" };

const SECURITY_SYMBOL: Record<PopupSecurity, { name: string; label: string }> = {
  secure: { name: "lock.fill", label: "Connection is secure" },
  notSecure: { name: "lock.open.trianglebadge.exclamationmark.fill", label: "Connection is not secure" },
  certificateError: { name: "lock.open.trianglebadge.exclamationmark.fill", label: "Connection is not secure" },
  unknown: { name: "info.circle", label: "Connection security unknown" },
  local: { name: "info.circle", label: "Local or internal page" },
};

const CAPTION_REGIONS: readonly CaptionRegion[] = [
  [0, 0, CONTROLS_ROOM, POPUP_CAPTION_HEIGHT],
  [0, POPUP_CAPTION_HEIGHT, 0, POPUP_ORIGIN_STRIP_HEIGHT],
];

const view = (style: ViewStyle, ...children: ReactNode[]) => createElement(View, { style }, ...children);

const symbol = (props: SymbolProps & { accessibilityLabel?: string }) => createElement(Symbol as ComponentType<SymbolProps & { accessibilityLabel?: string }>, props);

function Glyph({ kind, color }: { kind: ButtonKind; color: string }) {
  const box = BUTTON.glyph;
  if (kind === "minimize") return view({ width: box, height: 1, backgroundColor: color });
  if (kind === "maximize") return view({ width: box, height: box, borderWidth: 1, borderRadius: BUTTON.glyphRadius, borderColor: color });
  if (kind === "restore") {
    const pane = box - 2;
    return view(
      { width: box, height: box },
      view({ position: "absolute", right: 0, top: 0, width: pane, height: pane, borderTopWidth: 1, borderRightWidth: 1, borderTopRightRadius: BUTTON.restoreCorner, borderColor: color }),
      view({ position: "absolute", left: 0, bottom: 0, width: pane, height: pane, borderWidth: 1, borderRadius: BUTTON.glyphRadius, borderColor: color }),
    );
  }
  return symbol({ name: "xmark", size: box, weight: "regular", color, style: { width: box + 4, height: box + 4 } });
}

function ControlButton({ kind, palette, onPress }: { kind: ButtonKind; palette: Palette; onPress: () => void }) {
  const [hovered, setHovered] = useState(false);
  const close = kind === "close";
  return createElement(
    View as ComponentType<Record<string, unknown>>,
    { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) },
    createElement(Pressable as ComponentType<Record<string, unknown>>, {
      onPress,
      accessibilityRole: "button",
      accessibilityLabel: LABEL[kind],
      children: ({ pressed }: { pressed: boolean }) =>
        createElement(
          View,
          {
            style: {
              width: BUTTON.width,
              height: BUTTON.height,
              borderRadius: BUTTON.radius,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: pressed ? (close ? CLOSE.pressed : palette.pressed) : hovered ? (close ? CLOSE.hover : palette.hover) : undefined,
            },
          },
          createElement(Glyph, { kind, color: close && (hovered || pressed) ? CLOSE.ink : palette.text }),
        ),
    }),
  );
}

function useMaximized(windowId: string) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const subscription = controls().addListener("onWindowEvent", (event) => {
      if (event.type === "maximized" && event.id === windowId) setMaximized(event.on);
    });
    return () => subscription.remove();
  }, [windowId]);
  return maximized;
}

function PopupControls({ windowId, palette }: { windowId: string; palette: Palette }) {
  const maximized = useMaximized(windowId);
  return createElement(
    View,
    {
      pointerEvents: "box-none",
      style: {
        position: "absolute",
        right: BUTTON.edge,
        top: (POPUP_CAPTION_HEIGHT - BUTTON.height) / 2,
        width: CONTROLS_WIDTH,
        height: BUTTON.height,
        flexDirection: "row",
        gap: BUTTON.gap,
      },
    },
    createElement(ControlButton, { kind: "minimize", palette, onPress: () => void controls().minimizeWindow(windowId) }),
    createElement(ControlButton, { kind: maximized ? "restore" : "maximize", palette, onPress: () => void controls().toggleMaximizeWindow(windowId) }),
    createElement(ControlButton, { kind: "close", palette, onPress: () => requestPopupClose(windowId) }),
  );
}

function OriginStrip({ url, level, palette }: { url: string; level: string | null; palette: Palette }) {
  const security = popupSecurity(url, level);
  const glyph = SECURITY_SYMBOL[security];
  return createElement(
    View,
    {
      style: {
        height: POPUP_ORIGIN_STRIP_HEIGHT,
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: STRIP.inset,
        gap: STRIP.gap,
        backgroundColor: palette.strip,
        borderBottomWidth: 1,
        borderBottomColor: palette.separator,
      },
    },
    view(
      { width: STRIP.glyph, height: STRIP.glyph, alignItems: "center", justifyContent: "center" },
      symbol({
        name: glyph.name,
        size: STRIP.symbol,
        weight: "medium",
        color: security === "certificateError" ? CERTIFICATE_ERROR_TINT : palette.secondary,
        accessibilityLabel: glyph.label,
        style: { width: STRIP.glyph, height: STRIP.glyph },
      }),
    ),
    createElement(Text, { numberOfLines: 1, ellipsizeMode: "head", style: { flex: 1, fontSize: STRIP.text, color: palette.text } }, popupOriginText(url)),
  );
}

function PopupContent({ popup }: { popup: PopupWindowInfo }) {
  const palette = useAppDark() ? PALETTE.dark : PALETTE.light;
  const [page, setPage] = useState({ url: popup.url, title: "" });
  const [level, setLevel] = useState<string | null>(null);
  const title = popupTitle(page.title, page.url);
  const { windowId, pageKey } = popup;

  useEffect(() => void controls().setCaptionRegions(windowId, CAPTION_REGIONS), [windowId]);

  useEffect(() => setPopupWindowTitle(windowId, title), [windowId, title]);

  useEffect(() => {
    let current = true;
    void pageOpened(pageKey).then((opened) => {
      if (current && !opened) closePopupWindow(windowId);
    });
    return () => {
      current = false;
    };
  }, [windowId, pageKey]);

  useEffect(() => {
    const subscription = controls().addListener("onWindowEvent", (event) => {
      if (event.type === "focus" && event.id === windowId && !event.fromPage) void callPage(pageKey, "focus");
    });
    return () => subscription.remove();
  }, [windowId, pageKey]);

  const onPageEvent = useCallback(
    ({ nativeEvent: { name, data } }: Pick<NativeSyntheticEvent<PageEvent>, "nativeEvent">) => {
      const fields = (data ?? {}) as { url?: unknown; title?: unknown; level?: unknown };
      if (name === "ready") {
        void callPage<{ level?: unknown }>(pageKey, "getSecurityInfo").then((info) => {
          if (typeof info?.level === "string") setLevel(info.level);
        });
        return void (popup.focused ? followPage(pageKey, windowId) : undefined);
      }
      if (name === "security") return setLevel(typeof fields.level === "string" ? fields.level : null);
      if (name !== "navigation") return;
      setPage((shown) => ({
        url: typeof fields.url === "string" && fields.url ? fields.url : shown.url,
        title: typeof fields.title === "string" ? fields.title : shown.title,
      }));
    },
    [pageKey, windowId, popup.focused],
  );

  return view(
    { flex: 1, backgroundColor: palette.background },
    view(
      { height: POPUP_CAPTION_HEIGHT, justifyContent: "center", paddingLeft: TITLE_INSET, paddingRight: CONTROLS_ROOM },
      createElement(Text, { numberOfLines: 1, style: { fontSize: STRIP.text, color: palette.text } }, title),
    ),
    createElement(OriginStrip, { url: page.url, level, palette }),
    createElement(EngineWebView, {
      tabId: pageKey,
      url: "",
      profile: popup.profile,
      adoptId: popup.adopt,
      style: { flex: 1 },
      pageEvents: PAGE_EVENTS,
      onPageEvent,
    }),
    createElement(PopupControls, { windowId, palette }),
  );
}

export function PopupWindow({ windowId }: { windowId: string }) {
  const popup = popupWindowInfo(windowId);
  const dark = useAppDark();
  if (!popup) return view({ flex: 1, backgroundColor: dark ? PALETTE.dark.background : PALETTE.light.background });
  return createElement(PopupContent, { popup });
}
