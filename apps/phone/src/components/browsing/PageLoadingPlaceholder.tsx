import { useEffect } from "react";
import { Platform, StyleSheet, Text } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import { Favicon, useTheme } from "../ui";
import { siteHost } from "./FloatingBar";
import { loadingPlaceholderLayout as layout } from "./pageStateTokens";
import { t } from "../../lib/uiLanguage";


const EASE_OUT = Easing.bezier(0, 0, 0.58, 1);

export type PlaceholderTab = { url: string; title: string; faviconUrl: string | null; themeColorHex: string | null };

export type PageTheme = { color: string; ink: string; hostInk: string };

export function pageTheme(hex: string | null): PageTheme | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex?.trim() ?? "");
  if (!match) return null;
  const value = parseInt(match[1]!, 16);
  const luminance = (0.2126 * ((value >> 16) & 0xff) + 0.7152 * ((value >> 8) & 0xff) + 0.0722 * (value & 0xff)) / 255;
  if (luminance >= layout.themeLightest) return null;
  const side = luminance > layout.themeInkFlip ? "onLight" : "onDark";
  return { color: `#${match[1]!.toUpperCase()}`, ink: layout.themeInk[side], hostInk: layout.themeHostInk[side] };
}

export function distinctTitle(title: string, host: string | null): string | null {
  const trimmed = title.trim();
  if (!trimmed) return host === null ? t(`New Tab`) : null;
  if (host === null) return trimmed;
  const bare = (text: string) => text.toLowerCase().replaceAll("www.", "");
  if (bare(trimmed) === bare(host) || trimmed.toLowerCase().startsWith("http")) return null;
  return trimmed;
}

export function PageLoadingPlaceholder({ tab, revealed = false }: { tab: PlaceholderTab; revealed?: boolean }) {
  const theme = useTheme();
  const page = pageTheme(tab.themeColorHex);
  const host = siteHost(tab.url);
  const title = distinctTitle(tab.title, host);
  const primary = page?.ink ?? theme.foregroundPrimary;
  const secondary = page?.hostInk ?? theme.foregroundSecondary;
  const reveal = useSharedValue(revealed ? 1 : 0);
  useEffect(() => {
    if (revealed) return;
    reveal.value = withDelay(layout.revealDelayMs, withTiming(1, { duration: layout.revealMs, easing: EASE_OUT }));
  }, []);
  const shown = useAnimatedStyle(() => ({ opacity: reveal.value }));
  const spoken = tab.title.trim() || host || t(`New Tab`);
  return (
    <Animated.View
      testID="pageLoadingPlaceholder"
      accessible={Platform.OS === "ios"}
      accessibilityLabel={`Loading ${spoken}`}
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, styles.page, { backgroundColor: page?.color ?? theme.surface }]}
    >
      <Animated.View testID="pageLoadingContent" style={[styles.column, shown]}>
        <Animated.View testID="pageLoadingIcon" style={styles.icon}>
          <Favicon iconUrl={tab.faviconUrl} pageUrl={tab.url || null} size={layout.icon} />
        </Animated.View>
        {title !== null ? (
          <Text testID="pageLoadingTitle" numberOfLines={layout.titleLines} style={[layout.title, styles.centred, { color: primary }]}>
            {title}
          </Text>
        ) : null}
        {host !== null ? (
          <Text testID="pageLoadingHost" numberOfLines={1} style={[title === null ? layout.title : layout.host, styles.centred, { color: title === null ? primary : secondary }]}>
            {host}
          </Text>
        ) : null}
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  page: { alignItems: "center", justifyContent: "center", paddingHorizontal: layout.sideInset },
  column: { alignItems: "center", gap: layout.spacing },
  icon: { width: layout.icon, height: layout.icon, borderRadius: layout.iconCorner, boxShadow: layout.iconShadow },
  centred: { textAlign: "center" },
});
