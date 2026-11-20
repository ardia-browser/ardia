import { useEffect, useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { placeholderIndex } from "../../lib/tabFace";
import { forgetPicturePainted, notePicturePainted, noteSnapshotAspect, noteSnapshotShown, pictureKey, snapshotAspect, snapshotWasShown } from "../../lib/shownSnapshots";
import { tabsMotion } from "./motion";
import { isDarkColor } from "../../lib/color";
import { Favicon } from "./Favicon";
import { IncognitoSpecs } from "./IncognitoSpecs";
import { font, space, tabsInk, tabsLayout, type ColorRoles } from "./tokens";

export type TabFaceTab = { url: string; title: string; isPrivate: boolean; snapshotFileName: string | null; themeColorHex: string | null; faviconUrl: string | null };

export function placeholderTint(url: string, roles: ColorRoles): string {
  return roles.placeholderTints[placeholderIndex(url, roles.placeholderTints.length)]!;
}

export function tabFill(tab: TabFaceTab, tone: string | null, roles: ColorRoles): string {
  if (tab.isPrivate) return tabsInk.incognitoCard;
  return tab.themeColorHex ?? tone ?? placeholderTint(tab.url, roles);
}

type Props = { tab: TabFaceTab; title: string; host: string; tone: string | null; roles: ColorRoles; compact?: boolean; paintedAs?: string };

export function TabFace({ tab, title, host, tone, roles, compact, paintedAs }: Props) {
  const fill = tabFill(tab, tone, roles);
  const face = <PlainFace tab={tab} title={title} host={host} fill={fill} roles={roles} compact={compact} />;
  if (tab.snapshotFileName) return <Snapshot key={tab.snapshotFileName} uri={tab.snapshotFileName} fill={fill} under={face} paintedAs={paintedAs} />;
  return face;
}

function PlainFace({ tab, title, host, fill, roles, compact }: { tab: TabFaceTab; title: string; host: string; fill: string; roles: ColorRoles; compact?: boolean }) {
  if (tab.isPrivate) {
    return (
      <View style={[StyleSheet.absoluteFill, styles.private, { backgroundColor: fill }]}>
        <IncognitoSpecs size={compact ? tabsLayout.specsCompact : tabsLayout.specsFace} color={tabsInk.onDark} />
        {compact ? null : (
          <>
            <Text style={[font.footnote, styles.privateTitle]}>Incognito Tab</Text>
            <Text style={[font.caption, styles.privateCaption]} numberOfLines={2}>
              {title}
            </Text>
          </>
        )}
      </View>
    );
  }
  const dark = isDarkColor(fill);
  const ink = dark ? tabsInk.onDark : roles.label;
  const soft = dark ? tabsInk.onDarkSoft : roles.foregroundSecondary;
  return (
    <View style={[StyleSheet.absoluteFill, compact ? styles.compact : styles.page, { backgroundColor: fill }]}>
      <Favicon iconUrl={tab.faviconUrl} pageUrl={tab.url} size={compact ? 12 : 32} />
      {compact ? null : (
        <>
          <Text style={[font.body, styles.title, { color: ink }]} numberOfLines={4}>
            {title}
          </Text>
          <Text style={[font.subheadline, { color: soft }]} numberOfLines={1}>
            {host}
          </Text>
        </>
      )}
    </View>
  );
}

function Snapshot({ uri, fill, under, paintedAs }: { uri: string; fill: string; under: ReactNode; paintedAs?: string }) {
  const [aspect, setAspect] = useState<number | null>(() => snapshotAspect(uri));
  const [loaded, setLoaded] = useState(false);
  const [wasShown] = useState(() => snapshotWasShown(uri));
  const [covered, setCovered] = useState(!wasShown);
  const appear = useSharedValue(wasShown ? 1 : 0);
  const appearing = useAnimatedStyle(() => ({ opacity: appear.value }));
  useEffect(() => {
    if (!loaded) return;
    const key = paintedAs ? pictureKey(paintedAs, uri) : uri;
    const frame = requestAnimationFrame(() => notePicturePainted(key));
    return () => {
      cancelAnimationFrame(frame);
      forgetPicturePainted(key);
    };
  }, [loaded, aspect, uri, paintedAs]);
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: fill }]}>
      {covered ? under : null}
      <Animated.Image
        source={{ uri }}
        resizeMethod="scale"
        onLoad={(event) => {
          const { width, height } = event.nativeEvent.source;
          if (width > 0 && height > 0) {
            noteSnapshotAspect(uri, width / height);
            setAspect(width / height);
          }
          setLoaded(true);
          if (snapshotWasShown(uri)) {
            appear.value = 1;
            setCovered(false);
            return;
          }
          noteSnapshotShown(uri);
          appear.value = withTiming(1, { duration: tabsMotion.fade }, (finished) => {
            if (finished) runOnJS(setCovered)(false);
          });
        }}
        style={[aspect ? [styles.snapshot, { aspectRatio: aspect }] : StyleSheet.absoluteFill, appearing]}
        resizeMode="cover"
        fadeDuration={0}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  snapshot: { width: "100%" },
  page: { padding: space.l, paddingTop: space.huge + space.l, gap: space.m },
  compact: { alignItems: "center", justifyContent: "center" },
  title: { fontWeight: "600" },
  private: { alignItems: "center", justifyContent: "center", gap: space.m, paddingHorizontal: space.m },
  privateTitle: { color: tabsInk.onDark, fontWeight: "600" },
  privateCaption: { color: tabsInk.onDarkSoft, textAlign: "center" },
});
