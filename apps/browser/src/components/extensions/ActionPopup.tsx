import { useEffect, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";
import { closeExtensionPopup } from "../../state/extensions/actions";
import { MEASURE_POPUP_SCRIPT } from "../../state/extensions/popupSize";
import { useShownPageId } from "../../state/peek/hooks";
import { openFromPage, pageProfileId } from "../../state/tabs/openFromPage";
import { curve, duration, PANEL, Panel, shadow, useTheme, WebView, type WebViewHandle } from "../ui";
import { EXTENSION_PAGE_BACKGROUND } from "./tokens";
import { useCurrentInterfaceScale } from "../../state/settings/interfaceScale";

const MIN = { width: 25, height: 25 };
const MAX = { width: 800, height: 600 };

export function ActionPopup({ windowId, pageProfile, url, anchor }: { windowId: string; pageProfile: string; extensionId: string; url: string; anchor: { x: number; y: number; width: number; height: number } }) {
  const theme = useTheme();
  const web = useRef<WebViewHandle>(null);
  const scale = useCurrentInterfaceScale();
  const [windowWidth, setWindowWidth] = useState(0);
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);
  const appear = useRef(new Animated.Value(0)).current;
  const alive = useRef(true);
  const sized = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const tabId = useShownPageId(windowId);
  const openedOn = useRef(tabId);
  useEffect(() => {
    if (tabId !== openedOn.current) closeExtensionPopup();
  }, [tabId]);

  const resizePage = (w: number, h: number) => {
    const next = {
      width: Math.min(MAX.width, Math.max(MIN.width, Math.ceil(w))),
      height: Math.min(MAX.height, Math.max(MIN.height, Math.ceil(h))),
    };
    setPageSize((prev) => {
      if (!prev) Animated.timing(appear, { toValue: 1, duration: duration.base, easing: curve.enter, useNativeDriver: true }).start();
      return prev && prev.width === next.width && prev.height === next.height ? prev : next;
    });
  };

  const watchSize = () => {
    if (sized.current) return;
    void web.current?.evaluate<{ w: number; h: number }>(MEASURE_POPUP_SCRIPT).then((m) => {
      if (!alive.current || !m || sized.current) return;
      resizePage(m.w, m.h);
      watchSize();
    });
  };

  const width = (pageSize?.width ?? MIN.width) / scale + 1;
  const height = (pageSize?.height ?? MIN.height) / scale + 1;
  const left = windowWidth ? Math.max(8, Math.min(anchor.x + anchor.width - width, windowWidth - width - 8)) : Math.max(8, anchor.x + anchor.width - width);
  const top = anchor.y + anchor.height + 6;

  return (
    <>
      <Pressable testID="ardia-extension-popup-dismiss" style={StyleSheet.absoluteFill} onPress={closeExtensionPopup} onLayout={(e) => setWindowWidth(e.nativeEvent.layout.width)} />
      <Animated.View
        testID="ardia-extension-popup"
        style={{
          position: "absolute",
          left,
          top,
          opacity: appear,
          transform: [{ translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [-4, 0] }) }],
        }}
      >
        <Panel radius={PANEL.radius} border={theme.popoverBorder} shadow={shadow.card} style={{ width, height }}>
          <View style={{ flex: 1, borderRadius: PANEL.radius, overflow: "hidden" }}>
            <WebView
              ref={web}
              style={StyleSheet.absoluteFill}
              url={url}
              profile={pageProfile}
              standalone
              extensionHost="popup"
              pageBackgroundColor={EXTENSION_PAGE_BACKGROUND}
              onPreferredSize={({ width, height }) => {
                sized.current = true;
                resizePage(width * scale, height * scale);
              }}
              onNavigationChange={({ isLoading }) => {
                if (isLoading) return;
                watchSize();
                void web.current?.focus();
              }}
              onWindowClose={closeExtensionPopup}
              onOpenWindow={(request) => {
                openFromPage(request, { windowId, profileId: pageProfileId(windowId, pageProfile) });
                if (request.disposition !== "background") closeExtensionPopup();
              }}
            />
          </View>
        </Panel>
      </Animated.View>
    </>
  );
}
