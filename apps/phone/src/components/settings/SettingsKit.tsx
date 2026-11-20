import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, type GestureResponderEvent, Pressable, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View, type StyleProp, type TextStyle } from "react-native";
import Animated, { FadeIn, FadeOut, LayoutAnimationConfig, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { rememberSettingsScroll, settingsScroll } from "../../state/settings/nav";
import { MenuTrigger } from "../ui/MenuTrigger";
import { duration, LookBackdrop, settingsMotion, useSheetFrame, font, ink, settingsLayout, space, Symbol, tabsLayout, ToggleTrack, useTheme, type MenuItem, type SymbolName } from "../ui";

export const SettingsHostedContext = createContext(false);

type PageProps = { title: string; onBack?: () => void; leading?: ReactNode; trailing?: ReactNode; children: ReactNode; scroll?: boolean; onRefresh?: () => Promise<unknown>; heroTitle?: boolean; overlay?: ReactNode; dismissesKeyboard?: boolean };

export function SettingsPage({ title, onBack, leading, trailing, children, scroll = true, onRefresh, heroTitle = false, overlay, dismissesKeyboard = false }: PageProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [startOffset] = useState(() => ({ x: 0, y: settingsScroll(title) }));
  const frame = useSheetFrame();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = onRefresh
    ? () => {
        setRefreshing(true);
        void onRefresh().finally(() => setRefreshing(false));
      }
    : null;
  const sheetList = frame?.list(refresh !== null);
  const [heroAway, setHeroAway] = useState(false);
  const titleShown = !heroTitle || heroAway;
  const titleOpacity = useSharedValue(titleShown ? 1 : 0);
  useEffect(() => {
    titleOpacity.value = withSpring(titleShown ? 1 : 0, settingsMotion.titleFade);
  }, [titleShown, titleOpacity]);
  const titleStyle = useAnimatedStyle(() => ({ opacity: titleOpacity.value }));
  const hosted = useContext(SettingsHostedContext);
  return (
    <View style={StyleSheet.absoluteFill}>
      <LookBackdrop />
      {hosted ? (
        leading || trailing ? (
          <View testID="settingsHostedActions" style={styles.hostedActions}>
            <View style={styles.topSide}>{leading}</View>
            <View style={[styles.topSide, styles.end]}>{trailing}</View>
          </View>
        ) : null
      ) : (
      <View style={[styles.top, { paddingTop: frame ? 0 : insets.top }]}>
        <View style={styles.topSide}>
          {onBack ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} style={styles.back}>
              <Symbol name="chevronLeft" size={22} color={theme.formAccent} />
            </Pressable>
          ) : null}
          {leading}
        </View>
        <Animated.Text
          testID="settingsTitle"
          accessibilityRole="header"
          accessibilityElementsHidden={!titleShown}
          importantForAccessibility={titleShown ? "auto" : "no-hide-descendants"}
          style={[font.body, styles.bold, styles.title, { color: theme.label }, titleStyle]}
          numberOfLines={1}
        >
          {title}
        </Animated.Text>
        <View style={[styles.topSide, styles.end]}>{trailing}</View>
      </View>
      )}
      {scroll ? (
        <ScrollView
          style={{ marginBottom: insets.bottom }}
          contentContainerStyle={[styles.content, { paddingBottom: space.huge }]}
          contentOffset={startOffset}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={dismissesKeyboard ? "on-drag" : "none"}
          refreshControl={refresh ? <RefreshControl refreshing={refreshing} onRefresh={refresh} /> : undefined}
          {...sheetList}
          scrollEventThrottle={16}
          onScroll={(event) => {
            sheetList?.onScroll(event);
            rememberSettingsScroll(title, event.nativeEvent.contentOffset.y);
            if (heroTitle) setHeroAway(event.nativeEvent.contentOffset.y > settingsLayout.heroScrollThreshold);
          }}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.fill, { paddingBottom: insets.bottom }]}>{children}</View>
      )}
      {overlay}
    </View>
  );
}

export function CrossfadeText({ text, style, testID }: { text: string; style: StyleProp<TextStyle>; testID?: string }) {
  return (
    <LayoutAnimationConfig skipEntering>
      <Animated.Text key={text} testID={testID} entering={FadeIn.duration(duration.crossfade)} exiting={FadeOut.duration(duration.crossfade)} style={style}>
        {text}
      </Animated.Text>
    </LayoutAnimationConfig>
  );
}

export function BarButton({ title, onPress, emphasized, enabled = true }: { title: string; onPress: () => void; emphasized?: boolean; enabled?: boolean }) {
  const theme = useTheme();
  return (
    <Pressable accessibilityRole="button" disabled={!enabled} onPress={onPress} style={styles.barButton}>
      <Text style={[font.body, emphasized ? styles.bold : null, { color: enabled ? theme.formAccent : theme.tertiaryLabel }]}>{title}</Text>
    </Pressable>
  );
}

export function Group({ header, footer, children }: { header?: string; footer?: string | null; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={styles.groupOuter}>
      {header ? (
        <Text accessibilityRole="header" style={[font.footnote, styles.groupHeader, { color: theme.secondaryLabel }]}>
          {header}
        </Text>
      ) : null}
      <View style={[styles.group, { backgroundColor: theme.groupFill }]}>{children}</View>
      {footer ? <Text style={[font.footnote, styles.groupFooter, { color: theme.secondaryLabel }]}>{footer}</Text> : null}
    </View>
  );
}

export function IconTile({ icon, tint, side = settingsLayout.tile }: { icon: SymbolName; tint: string; side?: number }) {
  return (
    <View style={[styles.tile, { width: side, height: side, borderRadius: side * 0.26, backgroundColor: tint }]}>
      <Symbol name={icon} size={side * 0.62} color={ink.white} />
    </View>
  );
}

function Label({ title, icon, tint, color }: { title: string; icon?: SymbolName; tint?: string; color?: string }) {
  const theme = useTheme();
  return (
    <View style={styles.label}>
      {icon && tint ? <IconTile icon={icon} tint={tint} /> : null}
      <Text style={[font.body, styles.labelText, { color: color ?? theme.label }]}>{title}</Text>
    </View>
  );
}

export function Divider({ inset = settingsLayout.rowInset }: { inset?: number }) {
  const theme = useTheme();
  return <View style={[styles.divider, { marginLeft: inset, backgroundColor: theme.separator }]} />;
}

type RowBase = { title: string; icon?: SymbolName; tint?: string; divider?: boolean };

export function NavRow({ title, icon, tint, value, divider, onPress }: RowBase & { value?: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityValue={value ? { text: value } : undefined}
        onPress={onPress} style={({ pressed }) => [styles.row, pressed ? { backgroundColor: theme.rowHighlight } : null]}>
        <Label title={title} icon={icon} tint={tint} />
        {value ? (
          <Text style={[font.body, styles.value, { color: theme.secondaryLabel }]} numberOfLines={1}>
            {value}
          </Text>
        ) : null}
        <Symbol name="chevronRight" size={14} color={theme.tertiaryLabel} />
      </Pressable>
      {divider ? <Divider /> : null}
    </View>
  );
}

export function ToggleRow({ title, icon, tint, divider, value, onChange, detail }: RowBase & { value: boolean; onChange: (value: boolean) => void; detail?: string }) {
  const theme = useTheme();
  return (
    <View>
      <Pressable
        accessibilityRole="switch"
        accessibilityLabel={title}
        accessibilityHint={detail}
        accessibilityState={{ checked: value }}
        onPress={() => onChange(!value)}
        style={({ pressed }) => [styles.row, pressed ? { backgroundColor: theme.rowHighlight } : null]}
      >
        <View style={styles.fill} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          <Label title={title} icon={icon} tint={tint} />
          {detail ? <Text style={[font.footnote, { color: theme.secondaryLabel, marginLeft: icon ? settingsLayout.tile + settingsLayout.labelGap : 0 }]}>{detail}</Text> : null}
        </View>
        <ToggleTrack value={value} />
      </Pressable>
      {divider ? <Divider /> : null}
    </View>
  );
}

export function ButtonRow({ title, onPress, destructive, enabled = true, busy, divider }: { title: string; onPress: (event?: GestureResponderEvent) => void; destructive?: boolean; enabled?: boolean; busy?: boolean; divider?: boolean }) {
  const theme = useTheme();
  const color = !enabled ? theme.tertiaryLabel : destructive ? theme.destructive : theme.formAccent;
  return (
    <View>
      <Pressable accessibilityRole="button" disabled={!enabled} onPress={onPress} style={({ pressed }) => [styles.row, pressed ? { backgroundColor: theme.rowHighlight } : null]}>
        <Text style={[font.body, styles.fill, { color }]}>{title}</Text>
        {busy ? <ActivityIndicator color={theme.secondaryLabel} /> : null}
      </Pressable>
      {divider ? <Divider /> : null}
    </View>
  );
}

export function ValueRow({ title, value, divider }: { title: string; value: string; divider?: boolean }) {
  const theme = useTheme();
  return (
    <View>
      <View accessible accessibilityLabel={value ? `${title}, ${value}` : title} style={styles.row}>
        <Text style={[font.body, styles.fill, { color: theme.label }]}>{title}</Text>
        <Text style={[font.body, { color: theme.secondaryLabel }]}>{value}</Text>
      </View>
      {divider ? <Divider /> : null}
    </View>
  );
}

type PickerProps<T extends string> = RowBase & { options: { id: T; title: string }[]; selected: T; onSelect: (id: T) => void };

export function PickerRow<T extends string>({ title, icon, tint, divider, options, selected, onSelect }: PickerProps<T>) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const current = options.find((option) => option.id === selected)?.title ?? "";
  const items: MenuItem[] = options.map((option) => ({ label: option.title, checked: option.id === selected, onPress: () => onSelect(option.id) }));
  return (
    <View>
      <MenuTrigger items={items} trigger="tap" restoresAfterChoice align={{ trailing: true, inset: settingsLayout.rowInset }} place={{ width: Math.min(tabsLayout.menuWidth, width - space.huge * 2) }}>
        {({ onPress }) => (
          <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityValue={{ text: current }} onPress={onPress} style={({ pressed }) => [styles.row, pressed ? { backgroundColor: theme.rowHighlight } : null]}>
            <Label title={title} icon={icon} tint={tint} />
            <Text style={[font.body, styles.value, { color: theme.secondaryLabel }]} numberOfLines={1}>
              {current}
            </Text>
            <Symbol name="chevronUp" size={12} color={theme.tertiaryLabel} />
          </Pressable>
        )}
      </MenuTrigger>
      {divider ? <Divider /> : null}
    </View>
  );
}

export function EmptyState({ title, message, icon }: { title: string; message: string; icon: SymbolName }) {
  const theme = useTheme();
  return (
    <View style={styles.empty} accessible accessibilityRole="header" accessibilityLabel={message ? `${title}. ${message}` : title}>
      <Symbol name={icon} size={44} color={theme.tertiaryLabel} />
      <Text style={[font.title3, styles.bold, { color: theme.label }]}>{title}</Text>
      {message ? <Text style={[font.subheadline, styles.centered, { color: theme.secondaryLabel }]}>{message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  hostedActions: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: space.s },
  top: { flexDirection: "row", alignItems: "center", minHeight: settingsLayout.topBar, paddingHorizontal: space.s },
  topSide: { flex: 1, flexDirection: "row", alignItems: "center" },
  end: { justifyContent: "flex-end" },
  title: { maxWidth: settingsLayout.titleWidth, textAlign: "center" },
  back: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  barButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.s },
  bold: { fontWeight: "600" },
  content: { paddingTop: space.m, gap: space.xxl },
  fill: { flex: 1 },
  groupOuter: { paddingHorizontal: space.l },
  groupHeader: { paddingLeft: settingsLayout.rowInset, paddingBottom: space.s, fontWeight: "600" },
  group: { borderRadius: settingsLayout.groupRadius, overflow: "hidden" },
  groupFooter: { paddingHorizontal: settingsLayout.rowInset, paddingTop: space.s },
  tile: { alignItems: "center", justifyContent: "center" },
  label: { flexDirection: "row", alignItems: "center", gap: settingsLayout.labelGap, flexShrink: 1, flexGrow: 1 },
  labelText: { flexShrink: 1 },
  divider: { height: StyleSheet.hairlineWidth },
  row: { flexDirection: "row", alignItems: "center", gap: space.s, minHeight: settingsLayout.rowMinHeight, paddingHorizontal: settingsLayout.rowInset, paddingVertical: space.s },
  value: { flexShrink: 0, maxWidth: "55%", textAlign: "right" },
  empty: { alignItems: "center", gap: space.s, paddingTop: space.huge * 2, paddingHorizontal: space.xxl },
  centered: { textAlign: "center" },
});
