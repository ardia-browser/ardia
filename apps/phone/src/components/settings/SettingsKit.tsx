import { createContext, useCallback, useContext, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type RefObject } from "react";
import { ActivityIndicator, type GestureResponderEvent, Pressable, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View, type ScrollViewInstance, type StyleProp, type TextStyle, type ViewInstance } from "react-native";
import Animated, { FadeIn, FadeOut, LayoutAnimationConfig, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { isSettingsOpening, rememberSettingsScroll, settingsScroll, useSettingsNav } from "../../state/settings/nav";
import { MenuTrigger } from "../ui/MenuTrigger";
import { MaterialBarButton, MaterialButtonRow, MaterialEmptyState, MaterialGroup, MaterialIconTile, MaterialMediumTitle, MaterialNavRow, MaterialPickerRow, MaterialSettingsAppBar, MaterialToggleRow, MaterialValueRow, materialMediumTitleHeight, materialSettingsListStyles } from "./MaterialSettingsKit";
import { duration, LookBackdrop, settingsMotion, useSheetFrame, font, ink, settingsLayout, space, Symbol, tabsLayout, rolesFor, ToggleRow as SharedToggleRow, Tappable, smoothCorners, slotAround, controlSize, useDesign, useTheme, type MenuItem, type SymbolName } from "../ui";
import { useMaterialTheme } from "../ui/materialTheme";
import { revealInList, type SettingsReveal } from "./settingsReveal";

export const SettingsHostedContext = createContext(false);
export const SettingsFormColorsContext = createContext<ReturnType<typeof rolesFor> | null>(null);

type PageProps = { title: string; onBack?: () => void; onClose?: () => void; leading?: ReactNode; trailing?: ReactNode; children: ReactNode; scroll?: boolean; onRefresh?: () => Promise<unknown>; heroTitle?: boolean; mediumAppBar?: boolean; overlay?: ReactNode; dismissesKeyboard?: boolean; revealRef?: RefObject<SettingsReveal | null> };

export function SettingsPage({ title, onBack, onClose, leading, trailing, children, scroll = true, onRefresh, heroTitle = false, mediumAppBar = false, overlay, dismissesKeyboard = false, revealRef }: PageProps) {
  const design = useDesign();
  const material = design === "material";
  const theme = useTheme();
  const form = useContext(SettingsFormColorsContext);
  const { scheme } = useMaterialTheme();
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const mediumTitleHeight = materialMediumTitleHeight(fontScale);
  const [generation] = useState(() => useSettingsNav.getState().generation);
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
  const list = useRef<ScrollViewInstance>(null);
  const viewport = useRef(0);
  const lastY = useRef(startOffset.y);
  const reveal = useCallback<SettingsReveal>((target) => revealInList({ list: list.current, scrollY: lastY.current, viewport: viewport.current }, target), []);
  useImperativeHandle(revealRef, () => reveal, [reveal]);
  const [offset, setOffset] = useState(startOffset.y);
  useEffect(() => setOffset(lastY.current), [mediumTitleHeight]);
  const collapsed = offset >= mediumTitleHeight;
  const [scrolled, setScrolled] = useState(startOffset.y > 0);
  const [heroAway, setHeroAway] = useState(false);
  const titleShown = !heroTitle || heroAway;
  const titleOpacity = useSharedValue(titleShown ? 1 : 0);
  useEffect(() => {
    titleOpacity.value = withSpring(titleShown ? 1 : 0, settingsMotion.titleFade);
  }, [titleShown, titleOpacity]);
  const titleStyle = useAnimatedStyle(() => ({ opacity: titleOpacity.value }));
  const hosted = useContext(SettingsHostedContext);
  return (
    <View testID={material ? "materialSettingsPage" : undefined} style={[StyleSheet.absoluteFill, material ? { backgroundColor: scheme.surfaceContainer } : form ? { backgroundColor: form.groupedBackground } : null]}>
      {material || form ? null : <LookBackdrop />}
      {material ? (
        <MaterialSettingsAppBar
          title={title}
          onBack={onBack}
          onClose={onClose}
          leading={leading}
          trailing={trailing}
          mediumAppBar={mediumAppBar}
          collapsed={collapsed}
          scrolled={scrolled}
          topInset={frame && !frame.fullScreen ? 0 : insets.top}
          leftInset={insets.left}
          rightInset={insets.right}
        />
      ) : hosted ? (
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
              <Tappable kind="icon" label="Back" onPress={onBack} style={styles.back}>
                <Symbol name="chevronLeft" size={22} color={form?.label ?? theme.formAccent} />
              </Tappable>
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
          ref={list}
          bounces={refresh !== undefined}
          overScrollMode={refresh ? "auto" : "never"}
          style={material ? [materialSettingsListStyles.list, { marginBottom: insets.bottom }] : { marginBottom: insets.bottom }}
          contentContainerStyle={
            material
              ? [materialSettingsListStyles.content, mediumAppBar ? materialSettingsListStyles.mediumContent : null, { paddingLeft: insets.left, paddingRight: insets.right }]
              : [styles.content, { paddingBottom: space.huge }]
          }
          contentOffset={startOffset}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={dismissesKeyboard ? "on-drag" : "none"}
          refreshControl={
            refresh ? (
              <RefreshControl
                refreshing={refreshing}
                onRefresh={refresh}
                colors={material ? [scheme.primary] : undefined}
                progressBackgroundColor={material ? scheme.surfaceContainerHigh : undefined}
              />
            ) : undefined
          }
          {...sheetList}
          onLayout={(event) => {
            sheetList?.onLayout(event);
            viewport.current = event.nativeEvent.layout.height;
          }}
          scrollEventThrottle={16}
          onScroll={(event) => {
            if (isSettingsOpening(generation)) sheetList?.onScroll(event);
            const y = event.nativeEvent.contentOffset.y;
            lastY.current = y;
            rememberSettingsScroll(title, y, generation);
            if (y > 0 !== scrolled) setScrolled(y > 0);
            if (mediumAppBar && (y >= mediumTitleHeight) !== collapsed) setOffset(y);
            if (heroTitle) setHeroAway(y > settingsLayout.heroScrollThreshold);
          }}
        >
          {material && mediumAppBar ? <MaterialMediumTitle title={title} height={mediumTitleHeight} collapsed={collapsed} /> : null}
          <LayoutAnimationConfig key={design} skipEntering skipExiting>
            <View testID="settingsPageContent" collapsable={false} style={material ? null : styles.sections}>
              {children}
            </View>
          </LayoutAnimationConfig>
        </ScrollView>
      ) : (
        <View style={[styles.fill, { paddingBottom: insets.bottom }]}>
          <LayoutAnimationConfig key={design} skipEntering skipExiting>
            <View testID="settingsPageContent" collapsable={false} style={styles.fill}>
              {children}
            </View>
          </LayoutAnimationConfig>
        </View>
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

function ClassicBarButton({ title, onPress, emphasized, enabled = true }: { title: string; onPress: () => void; emphasized?: boolean; enabled?: boolean }) {
  const theme = useTheme();
  const accent = useContext(SettingsFormColorsContext)?.formAccent ?? theme.formAccent;
  return (
    <Tappable kind="text" label={title} disabled={!enabled} onPress={onPress} style={styles.barButton}>
      <Text style={[font.body, emphasized ? styles.bold : null, { color: enabled ? accent : theme.tertiaryLabel }]}>{title}</Text>
    </Tappable>
  );
}

function ClassicGroup({ header, footer, children }: { header?: string; footer?: string | null; children: ReactNode }) {
  const theme = useTheme();
  const fill = useContext(SettingsFormColorsContext)?.groupedCell ?? theme.groupFill;
  return (
    <View style={styles.groupOuter}>
      {header ? (
        <Text accessibilityRole="header" style={[font.footnote, styles.groupHeader, { color: theme.secondaryLabel }]}>
          {header}
        </Text>
      ) : null}
      <View style={[styles.group, { backgroundColor: fill }]}>{children}</View>
      {footer ? <Text style={[font.footnote, styles.groupFooter, { color: theme.secondaryLabel }]}>{footer}</Text> : null}
    </View>
  );
}

function ClassicIconTile({ icon, tint, side = settingsLayout.tile }: { icon: SymbolName; tint: string; side?: number }) {
  return (
    <View style={[styles.tile, { width: side, height: side, borderRadius: side * 0.26, backgroundColor: tint }]}>
      <Symbol name={icon} size={side * 0.62} color={ink.white} />
    </View>
  );
}

function Label({ title, icon, tint, color, detail }: { title: string; icon?: SymbolName; tint?: string; color?: string; detail?: string }) {
  const theme = useTheme();
  return (
    <View style={styles.label}>
      {icon && tint ? <IconTile icon={icon} tint={tint} /> : null}
      {detail ? (
        <View style={styles.labelLines}>
          <Text style={[font.body, styles.labelText, { color: color ?? theme.label }]}>{title}</Text>
          <Text style={[font.footnote, styles.labelText, { color: theme.secondaryLabel }]}>{detail}</Text>
        </View>
      ) : (
        <Text style={[font.body, styles.labelText, { color: color ?? theme.label }]}>{title}</Text>
      )}
    </View>
  );
}

function ClassicDivider({ inset = settingsLayout.rowInset }: { inset?: number }) {
  const theme = useTheme();
  return <View style={[styles.divider, { marginLeft: inset, backgroundColor: theme.separator }]} />;
}

type RowBase = { title: string; icon?: SymbolName; tint?: string; divider?: boolean };

function ClassicNavRow({ title, icon, tint, value, detail, chevron = true, divider, onPress }: RowBase & { value?: string; detail?: string; chevron?: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={detail ? `${title}, ${detail}` : title}
        accessibilityValue={value ? { text: value } : undefined}
        onPress={onPress} style={({ pressed }) => [styles.row, pressed ? { backgroundColor: theme.rowHighlight } : null]}>
        <Label title={title} icon={icon} tint={tint} detail={detail} />
        {value ? (
          <Text style={[font.body, styles.value, { color: theme.secondaryLabel }]} numberOfLines={1}>
            {value}
          </Text>
        ) : null}
        {chevron ? <Symbol name="chevronRight" size={14} color={theme.tertiaryLabel} /> : null}
      </Pressable>
      {divider ? <Divider /> : null}
    </View>
  );
}

function ClassicToggleRow({ title, icon, tint, divider, value, onChange, detail, buttonRef }: RowBase & { value: boolean; onChange: (value: boolean) => void; detail?: string; buttonRef?: RefObject<ViewInstance | null> }) {
  return (
    <View>
      <SharedToggleRow buttonRef={buttonRef} label={title} detail={detail} detailInset={icon ? settingsLayout.tile + settingsLayout.labelGap : 0} value={value} onChange={onChange} style={styles.row}>
        <Label title={title} icon={icon} tint={tint} />
      </SharedToggleRow>
      {divider ? <Divider /> : null}
    </View>
  );
}

function ClassicButtonRow({ title, onPress, destructive, enabled = true, busy, divider }: { title: string; onPress: (event?: GestureResponderEvent) => void; destructive?: boolean; enabled?: boolean; busy?: boolean; divider?: boolean }) {
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

function ClassicValueRow({ title, value, divider }: { title: string; value: string; divider?: boolean }) {
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

function ClassicPickerRow<T extends string>({ title, icon, tint, divider, options, selected, onSelect }: PickerProps<T>) {
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

function ClassicEmptyState({ title, message, icon }: { title: string; message: string; icon: SymbolName }) {
  const theme = useTheme();
  return (
    <View style={styles.empty} accessible accessibilityRole="header" accessibilityLabel={message ? `${title}. ${message}` : title}>
      <Symbol name={icon} size={44} color={theme.tertiaryLabel} />
      <Text style={[font.title3, styles.bold, { color: theme.label }]}>{title}</Text>
      {message ? <Text style={[font.subheadline, styles.centered, { color: theme.secondaryLabel }]}>{message}</Text> : null}
    </View>
  );
}

export function BarButton(props: Parameters<typeof ClassicBarButton>[0]) {
  return useDesign() === "material" ? <MaterialBarButton {...props} /> : <ClassicBarButton {...props} />;
}

export function Group(props: Parameters<typeof ClassicGroup>[0]) {
  return useDesign() === "material" ? <MaterialGroup {...props} /> : <ClassicGroup {...props} />;
}

export function IconTile(props: Parameters<typeof ClassicIconTile>[0]) {
  return useDesign() === "material" ? <MaterialIconTile {...props} /> : <ClassicIconTile {...props} />;
}

export function Divider(props: Parameters<typeof ClassicDivider>[0]) {
  return useDesign() === "material" ? null : <ClassicDivider {...props} />;
}

export function NavRow(props: Parameters<typeof ClassicNavRow>[0]) {
  return useDesign() === "material" ? <MaterialNavRow {...props} /> : <ClassicNavRow {...props} />;
}

export function ToggleRow(props: Parameters<typeof ClassicToggleRow>[0]) {
  return useDesign() === "material" ? <MaterialToggleRow {...props} /> : <ClassicToggleRow {...props} />;
}

export function ButtonRow(props: Parameters<typeof ClassicButtonRow>[0]) {
  return useDesign() === "material" ? <MaterialButtonRow {...props} /> : <ClassicButtonRow {...props} />;
}

export function ValueRow(props: Parameters<typeof ClassicValueRow>[0]) {
  return useDesign() === "material" ? <MaterialValueRow {...props} /> : <ClassicValueRow {...props} />;
}

export function EmptyState(props: Parameters<typeof ClassicEmptyState>[0]) {
  return useDesign() === "material" ? <MaterialEmptyState {...props} /> : <ClassicEmptyState {...props} />;
}

export function PickerRow<T extends string>(props: PickerProps<T>) {
  return useDesign() === "material" ? <MaterialPickerRow {...props} /> : <ClassicPickerRow {...props} />;
}

const styles = StyleSheet.create({
  hostedActions: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: space.s },
  top: { flexDirection: "row", alignItems: "center", minHeight: settingsLayout.topBar, paddingHorizontal: space.s },
  topSide: { flex: 1, flexDirection: "row", alignItems: "center" },
  end: { justifyContent: "flex-end" },
  title: { maxWidth: settingsLayout.titleWidth, textAlign: "center" },
  back: slotAround(controlSize.hitTarget),
  barButton: { minHeight: controlSize.hitTarget, justifyContent: "center", paddingHorizontal: space.s },
  bold: { fontWeight: "600" },
  content: { paddingTop: space.m },
  sections: { gap: space.xxl },
  fill: { flex: 1 },
  groupOuter: { paddingHorizontal: space.l },
  groupHeader: { paddingLeft: settingsLayout.rowInset, paddingBottom: space.s, fontWeight: "600" },
  group: { borderRadius: settingsLayout.groupRadius, ...smoothCorners, overflow: "hidden" },
  groupFooter: { paddingHorizontal: settingsLayout.rowInset, paddingTop: space.s },
  tile: { alignItems: "center", justifyContent: "center", ...smoothCorners },
  label: { flexDirection: "row", alignItems: "center", gap: settingsLayout.labelGap, flexShrink: 1, flexGrow: 1 },
  labelText: { flexShrink: 1 },
  labelLines: { flexShrink: 1, gap: space.tight },
  divider: { height: StyleSheet.hairlineWidth },
  row: { flexDirection: "row", alignItems: "center", gap: space.s, minHeight: settingsLayout.rowMinHeight, paddingHorizontal: settingsLayout.rowInset, paddingVertical: space.s },
  value: { flexShrink: 0, maxWidth: "55%", textAlign: "right" },
  empty: { alignItems: "center", gap: space.s, paddingTop: space.huge * 2, paddingHorizontal: space.xxl },
  centered: { textAlign: "center" },
});
