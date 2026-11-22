import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { BackHandler, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions, type StyleProp, type ViewStyle, type ViewInstance } from "react-native";
import { lookIsNative } from "@ardia/phone-native";
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { withAlpha } from "../../lib/color";
import { insetRect, MENU_MARGIN, menuAt, menuHeight, menuOnTrigger, menuShrink, type MenuAlign, type MenuLimits, type Point, type Rect } from "../../lib/menuPlace";
import { useReduceMotion } from "./contrast";
import { focusForScreenReader } from "./coverFocus";
import { useDesign } from "./design";
import { LookFrost, SURFACES_FROST } from "./LookViews";
import { MATERIAL_STATE } from "./materialRoles";
import { MATERIAL_MENU_GROUP_GAP, materialMenuFill, materialMenuGroups, materialMenuHeight, materialMenuWidth, useMaterialBack } from "./MaterialSurfaces";
import { useMaterialTheme } from "./materialTheme";
import { materialMotion, materialMove, materialShape, materialSize, materialType } from "./materialTokens";
import { menuMotion, reducedMotionMs } from "./motion";
import { measureAnchor, Portal, useOverlayFrame, usePortalLeaving, usePortalLeft } from "./Overlay";
import { Symbol } from "./Symbol";
import type { SymbolName } from "./symbolPaths";
import { useTheme } from "./theme";
import { drawnMenuInk as menuInk, drawnMenuLook as menuLook } from "./menuTokens";
import { font, ink, smoothCorners } from "./tokens";

export type MenuAction = { label: string; icon?: SymbolName; systemImage?: string; destructive?: boolean; checked?: boolean; disabled?: boolean; onPress: () => void };

export type MenuSubmenu = { label: string; icon?: SymbolName; systemImage?: string; disabled?: boolean; children: MenuItem[] };

export type MenuItem = MenuAction | MenuSubmenu | "divider" | { heading: string };

export const isSubmenu = (item: MenuAction | MenuSubmenu): item is MenuSubmenu => "children" in item;

export const submenuPage = (submenu: MenuSubmenu): MenuItem[] => [{ heading: submenu.label }, ...submenu.children];

let drawnMenuOpened: (privately: boolean) => void = () => undefined;

export const onDrawnMenuOpened = (handler: (privately: boolean) => void) => {
  drawnMenuOpened = handler;
};

export const countDrawnMenuOpened = (privately = false) => drawnMenuOpened(privately);

export type MenuPlacer = (height: number, keepBelow?: boolean, pageWidth?: number) => { place: ViewStyle; origin: string; maxHeight?: number; shrink?: { x: number; y: number } };

const MenuFrostContext = createContext<string | null>(SURFACES_FROST);

export const MenuFrostProvider = MenuFrostContext.Provider;

export const useMenuFrost = () => useContext(MenuFrostContext);

const MenuFloorContext = createContext<number | null>(null);

export const MenuFloorProvider = MenuFloorContext.Provider;

export const useMenuFloor = () => useContext(MenuFloorContext);

const PRESS = menuLook.pressInset;

const MATERIAL = !menuLook.frosted;

const CHECK_TRAILING = menuLook.checkSide === "trailing";

const SCRIM_ACCESSIBILITY = Platform.OS === "android" ? ({ accessible: false, importantForAccessibility: "no" } as const) : ({ accessibilityLabel: "Dismiss" } as const);
const CHECK_SHIFT = CHECK_TRAILING ? 0 : menuLook.labelInsetChecked - menuLook.labelInset;

type Props = { items: MenuItem[]; place?: ViewStyle; placer?: MenuPlacer; onDismiss: (chosen?: boolean) => void; dimmed?: boolean; origin?: string; frost?: string | null; shown?: boolean; privately?: boolean };

export function Menu(props: Props) {
  return useDesign() === "material" ? <MaterialMenu {...props} /> : <ClassicMenu {...props} />;
}

function MaterialMenu({ items, place, placer, onDismiss, origin = "top", shown = true, privately = false }: Props) {
  const { scheme, dark } = useMaterialTheme(privately);
  const fill = materialMenuFill(scheme, dark);
  const ripple = { color: withAlpha(scheme.onSurface, MATERIAL_STATE.pressed), borderless: false, foreground: true };
  const reduceMotion = useReduceMotion();
  const [pages, setPages] = useState<MenuSubmenu[]>([]);
  const page = pages[pages.length - 1] ?? null;
  const openPage = (submenu: MenuSubmenu) => setPages((now) => [...now, submenu]);
  const backPage = () => setPages((now) => now.slice(0, -1));
  const leaving = usePortalLeaving();
  const left = usePortalLeft();
  const rows = page ? page.children : items;
  const width = materialMenuWidth(rows);
  const [content, setContent] = useState<number | null>(null);
  const revealed = shown && (placer === undefined || content !== null);
  const side = useRef<boolean | undefined>(undefined);
  const spot = placer ? placer(content ?? materialMenuHeight(rows, page !== null), side.current, width) : { place: place ?? {}, origin, maxHeight: undefined, shrink: undefined };
  if (revealed && placer && side.current === undefined) side.current = spot.origin.includes("top");
  const firstRow = useRef<ViewInstance>(null);
  const chosen = useRef(false);
  const window = useWindowDimensions();
  const openedWidth = useRef(window.width);
  useEffect(() => {
    if (openedWidth.current !== window.width) onDismiss();
  }, [window.width]);
  useEffect(() => {
    countDrawnMenuOpened(privately);
  }, []);
  useEffect(() => {
    if (!revealed || leaving) return;
    return focusForScreenReader(() => firstRow.current);
  }, [revealed, page, leaving]);
  useMaterialBack(!leaving, { onCommit: () => (page ? backPage() : onDismiss()) });
  const opened = useSharedValue(reduceMotion ? 1 : 0);
  useEffect(() => {
    if (!revealed || leaving || reduceMotion) return;
    opened.value = materialMove(1, materialMotion.menuEnter.easing, materialMotion.menuEnter.durationMs);
  }, [revealed]);
  useEffect(() => {
    if (!leaving) return;
    const exitMs = reduceMotion ? reducedMotionMs(materialMotion.menuExit.durationMs) : materialMotion.menuExit.durationMs;
    if (exitMs === 0) {
      opened.value = 0;
      left();
      return;
    }
    opened.value = materialMove(0, materialMotion.menuExit.easing, exitMs, (finished) => {
      "worklet";
      if (finished) runOnJS(left)();
    });
  }, [leaving]);
  const enter = useAnimatedStyle(() => ({
    opacity: leaving ? opened.value : Math.min(1, opened.value * 3),
    transform: [{ scaleY: 0.8 + 0.2 * opened.value }],
  }));
  const choose = (action: () => void) => {
    if (chosen.current) return;
    chosen.current = true;
    onDismiss(true);
    action();
  };
  const firstEnabled = page ? -1 : rows.findIndex((item) => typeof item === "object" && !("heading" in item) && !item.disabled);
  const groups = materialMenuGroups(rows);
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={revealed && !leaving ? "auto" : "none"} collapsable={false} accessibilityElementsHidden={!revealed || leaving} importantForAccessibility={revealed && !leaving ? "auto" : "no-hide-descendants"}>
      <Pressable testID="drawnMenuScrim" {...SCRIM_ACCESSIBILITY} style={[StyleSheet.absoluteFill, { backgroundColor: ink.clear }]} onPress={() => onDismiss()} />
      <Animated.View
        testID="materialMenu"
        accessibilityRole="menu"
        accessibilityViewIsModal
        style={[materialStyles.menu, { transformOrigin: spot.origin }, spot.place, { width }, spot.maxHeight === undefined ? null : { maxHeight: spot.maxHeight }, revealed ? null : styles.unseen, enter]}
      >
        <ScrollView testID="drawnMenuRows" keyboardShouldPersistTaps="handled" style={styles.scroll} contentContainerStyle={materialStyles.groups} bounces={false} overScrollMode="never" onContentSizeChange={(_width, height) => setContent(height)}>
          {groups.map((group, groupIndex) => (
            <View key={groupIndex} testID="materialMenuGroup" style={[materialStyles.menuGroup, { backgroundColor: fill }]}>
              {page && groupIndex === 0 ? (
                <Pressable ref={firstRow} accessibilityRole="button" accessibilityLabel={`Back, ${page.label}`} android_ripple={ripple} onPress={backPage} style={materialStyles.menuItem}>
                  <Symbol name="chevronLeft" size={materialSize.icon} color={scheme.onSurfaceVariant} />
                  <Text numberOfLines={1} style={[materialType.titleSmall, materialStyles.menuLabel, { color: scheme.onSurface }]}>
                    {page.label}
                  </Text>
                </Pressable>
              ) : null}
              {group.map(({ entry, index }) => {
                if ("heading" in entry)
                  return (
                    <Text key={`h${index}`} accessibilityRole="header" style={[materialType.titleSmall, materialStyles.menuHeading, { color: scheme.onSurfaceVariant }]}>
                      {entry.heading}
                    </Text>
                  );
                if (isSubmenu(entry)) {
                  const color = entry.disabled ? withAlpha(scheme.onSurface, MATERIAL_STATE.disabledContent) : scheme.onSurface;
                  const iconColor = entry.disabled ? color : scheme.onSurfaceVariant;
                  return (
                    <Pressable
                      key={`${index}:${entry.label}`}
                      ref={index === firstEnabled ? firstRow : undefined}
                      accessibilityRole="menuitem"
                      accessibilityLabel={entry.label}
                      accessibilityState={{ disabled: entry.disabled, expanded: false }}
                      disabled={entry.disabled}
                      android_ripple={ripple}
                      onPress={() => openPage(entry)}
                      style={materialStyles.menuItem}
                    >
                      {entry.icon ? <Symbol name={entry.icon} size={materialSize.icon} color={iconColor} /> : null}
                      <Text numberOfLines={1} style={[materialType.labelLarge, materialStyles.menuLabel, { color }]}>
                        {entry.label}
                      </Text>
                      <Symbol name="chevronRight" size={materialSize.icon} color={iconColor} />
                    </Pressable>
                  );
                }
                const color = entry.disabled ? withAlpha(scheme.onSurface, MATERIAL_STATE.disabledContent) : entry.destructive ? scheme.error : scheme.onSurface;
                const iconColor = entry.disabled ? color : entry.destructive ? scheme.error : scheme.onSurfaceVariant;
                return (
                  <Pressable
                    key={`${index}:${entry.label}`}
                    ref={index === firstEnabled ? firstRow : undefined}
                    accessibilityRole="menuitem"
                    accessibilityLabel={entry.label}
                    accessibilityState={{ checked: entry.checked, disabled: entry.disabled }}
                    disabled={entry.disabled}
                    android_ripple={ripple}
                    onPress={() => choose(entry.onPress)}
                    style={materialStyles.menuItem}
                  >
                    {entry.icon ? <Symbol name={entry.icon} size={materialSize.icon} color={iconColor} /> : null}
                    <Text numberOfLines={1} style={[materialType.labelLarge, materialStyles.menuLabel, { color }]}>
                      {entry.label}
                    </Text>
                    {entry.checked ? <Symbol name="checkmark" size={materialSize.icon} color={scheme.primary} /> : null}
                  </Pressable>
                );
              })}
            </View>
          ))}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

function ClassicMenu({ items, place, placer, onDismiss, dimmed = false, origin = "top", frost, shown = true, privately = false }: Props) {
  const theme = useTheme();
  const paint = theme.dark ? menuInk.dark : menuInk.light;
  const reduceMotion = useReduceMotion();
  const frostAround = useMenuFrost();
  const source = frost === undefined ? frostAround : frost;
  const [pages, setPages] = useState<MenuSubmenu[]>([]);
  const page = pages[pages.length - 1] ?? null;
  const openPage = (submenu: MenuSubmenu) => setPages((now) => [...now, submenu]);
  const backPage = () => setPages((now) => now.slice(0, -1));
  const leaving = usePortalLeaving();
  const left = usePortalLeft();
  const rows = page ? page.children : items;
  const [content, setContent] = useState<number | null>(null);
  const revealed = shown && (placer === undefined || content !== null);
  const side = useRef<boolean | undefined>(undefined);
  const spot = placer ? placer(content ?? menuHeight(rows, menuLook) + (page ? menuLook.row : 0), side.current) : { place: place ?? {}, origin, maxHeight: undefined, shrink: undefined };
  const shrinkX = spot.shrink?.x ?? menuMotion.fromScale;
  const shrinkY = spot.shrink?.y ?? menuMotion.fromScale;
  const fromScale = menuMotion.fromScale;
  if (revealed && placer && side.current === undefined) side.current = spot.origin.includes("top");
  const firstRow = useRef<ViewInstance>(null);
  const chosen = useRef(false);
  const window = useWindowDimensions();
  const openedWidth = useRef(window.width);
  useEffect(() => {
    if (openedWidth.current !== window.width) onDismiss();
  }, [window.width]);
  useEffect(() => {
    countDrawnMenuOpened(privately);
  }, []);
  useEffect(() => {
    if (!revealed || leaving) return;
    return focusForScreenReader(() => firstRow.current);
  }, [revealed, page, leaving]);
  useEffect(() => {
    if (leaving) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      if (page) backPage();
      else onDismiss();
      return true;
    });
    return () => back.remove();
  }, [onDismiss, page, leaving]);
  const opened = useSharedValue(reduceMotion ? 1 : 0);
  const closed = useSharedValue(0);
  const glass = useSharedValue(1);
  const shownContent = useSharedValue(1);
  const dim = useSharedValue(reduceMotion ? 1 : 0);
  useEffect(() => {
    if (!revealed || leaving || reduceMotion) return;
    opened.value = withSpring(1, menuMotion.open);
    dim.value = withTiming(1, { duration: menuMotion.heldOpen });
  }, [revealed]);
  useEffect(() => {
    if (!leaving) return;
    const closing = dimmed ? menuMotion.heldClose : menuMotion.close;
    if (reduceMotion) {
      glass.value = withTiming(0, { duration: menuMotion.contentFade }, (finished) => finished && runOnJS(left)());
      shownContent.value = withTiming(0, { duration: menuMotion.contentFade });
      dim.value = withTiming(0, { duration: menuMotion.contentFade });
      return;
    }
    closed.value = withTiming(1, { duration: closing, easing: Easing.linear });
    glass.value = dimmed ? withTiming(0, { duration: closing, easing: Easing.in(Easing.cubic) }, (finished) => finished && runOnJS(left)()) : withDelay(closing - menuMotion.glassFade, withTiming(0, { duration: menuMotion.glassFade }, (finished) => finished && runOnJS(left)()));
    shownContent.value = withTiming(0, { duration: dimmed ? closing : menuMotion.contentFade });
    dim.value = withTiming(0, { duration: menuMotion.heldClose });
  }, [leaving]);
  const grow = useAnimatedStyle(() => {
    const open = fromScale + (1 - fromScale) * opened.value;
    return { transform: [{ scaleX: open * (1 + (shrinkX - 1) * closed.value) }, { scaleY: open * (1 + (shrinkY - 1) * closed.value) }] };
  });
  const dimStyle = useAnimatedStyle(() => ({ opacity: dim.value }));
  const fade = useAnimatedStyle(() => ({ opacity: glass.value }));
  const rowsFade = useAnimatedStyle(() => ({ opacity: shownContent.value }));
  const choose = (action: () => void) => {
    if (chosen.current) return;
    chosen.current = true;
    onDismiss(true);
    action();
  };
  const firstEnabled = page ? -1 : rows.findIndex((item) => typeof item === "object" && !("heading" in item) && !item.disabled);
  const checks = rows.some((item) => typeof item === "object" && !("heading" in item) && !isSubmenu(item) && item.checked === true);
  const leading = menuLook.iconSide === "leading";
  const shift = checks ? CHECK_SHIFT : 0;
  const iconsShown = !MATERIAL || page !== null || rows.every((item) => typeof item !== "object" || "heading" in item || item.icon !== undefined);
  const iconGutter = (MATERIAL && page !== null) || (!MATERIAL && iconsShown && rows.some((item) => typeof item === "object" && !("heading" in item) && item.icon !== undefined));
  const labelLeft = (icon: boolean) => ((icon || iconGutter) && leading ? menuLook.labelInsetIcon : menuLook.labelInset) + shift - PRESS;
  const iconLeft = menuLook.iconCentre + shift - PRESS - menuLook.iconSlot / 2;
  const pressed = (on: boolean, disabled?: boolean) => [styles.row, on && !MATERIAL ? { backgroundColor: paint.highlight } : null, disabled ? styles.disabled : null];
  const ripple = MATERIAL ? { android_ripple: { color: paint.highlight } } : null;
  const label = (text: string, color: string, bold = false) => (
    <Text numberOfLines={menuLook.labelLines} style={[menuLook.label, styles.label, bold ? styles.bold : null, { color }]}>
      {text}
    </Text>
  );
  const drawn = rows.map((item, index) => {
    if (item === "divider")
      return (
        <View key={`d${index}`} testID="drawnMenuGap" style={styles.divider}>
          {menuLook.dividerLine > 0 ? <View testID="drawnMenuRule" style={[styles.dividerLine, { backgroundColor: paint.divider }]} /> : null}
        </View>
      );
    if ("heading" in item)
      return (
        <Text key={`h${index}`} accessibilityRole="header" style={[font.footnote, styles.heading, { paddingLeft: labelLeft(false) + PRESS, color: paint.heading }]}>
          {item.heading}
        </Text>
      );
    const icon = leading && iconsShown && item.icon ? item.icon : null;
    if (isSubmenu(item))
      return (
        <Pressable
          key={`${index}:${item.label}`}
          ref={index === firstEnabled ? firstRow : undefined}
          accessibilityRole="menuitem"
          accessibilityLabel={item.label}
          accessibilityState={{ disabled: item.disabled, expanded: false }}
          disabled={item.disabled}
          onPress={() => openPage(item)}
          {...ripple}
          style={({ pressed: on }) => [...pressed(on, item.disabled), { paddingLeft: labelLeft(icon !== null), paddingRight: styles.chevronRoom.paddingRight }]}
        >
          {icon ? <MenuIcon name={icon} color={paint.icon} left={iconLeft} /> : null}
          {label(item.label, paint.label)}
          <View style={styles.chevron}>
            <Symbol name="chevronRight" size={menuLook.chevronSize} color={paint.label} />
          </View>
        </Pressable>
      );
    const color = item.destructive ? paint.destructive : paint.label;
    return (
      <Pressable
        key={`${index}:${item.label}`}
        ref={index === firstEnabled ? firstRow : undefined}
        accessibilityRole="menuitem"
        accessibilityLabel={item.label}
        accessibilityState={{ checked: item.checked, disabled: item.disabled }}
        disabled={item.disabled}
        onPress={() => choose(item.onPress)}
        {...ripple}
        style={({ pressed: on }) => [...pressed(on, item.disabled), { paddingLeft: labelLeft(icon !== null) }, CHECK_TRAILING && checks ? styles.checkRoom : null]}
      >
        {item.checked ? (
          <View style={CHECK_TRAILING ? styles.checkTrailing : styles.check}>
            <Symbol name="checkmark" size={menuLook.checkSize} color={color} />
          </View>
        ) : null}
        {icon ? <MenuIcon name={icon} color={item.destructive ? color : paint.icon} left={iconLeft} /> : null}
        {label(item.label, color)}
        {!leading && item.icon ? <Symbol name={item.icon} size={menuLook.iconSize} color={color} /> : null}
      </Pressable>
    );
  });
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={revealed && !leaving ? "auto" : "none"} collapsable={false} accessibilityElementsHidden={!revealed || leaving} importantForAccessibility={revealed && !leaving ? "auto" : "no-hide-descendants"}>
      {dimmed && !MATERIAL ? <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: paint.dim }, dimStyle]} /> : null}
      <Pressable testID="drawnMenuScrim" {...SCRIM_ACCESSIBILITY} style={[StyleSheet.absoluteFill, { backgroundColor: ink.clear }]} onPress={() => onDismiss()} />
      <Animated.View pointerEvents="box-none" style={[StyleSheet.absoluteFill, fade]}>
      <Animated.View
        testID="drawnMenu"
        accessibilityRole="menu"
        accessibilityViewIsModal
        style={[styles.panel, { boxShadow: menuLook.shadow, borderColor: paint.rim, transformOrigin: spot.origin }, spot.place, spot.maxHeight === undefined ? null : { maxHeight: spot.maxHeight }, revealed ? null : styles.unseen, grow]}
      >
        <MenuMaterial source={source} fill={paint.fill} solid={paint.solid} radius={menuLook.radius} style={[styles.material, spot.maxHeight === undefined ? null : { maxHeight: spot.maxHeight - 2 * menuLook.rim }]}>
          {MATERIAL ? null : <View pointerEvents="none" style={[styles.specular, { backgroundColor: paint.specular }]} />}
          <ScrollView testID="drawnMenuRows" keyboardShouldPersistTaps="handled" style={styles.scroll} contentContainerStyle={styles.rows} bounces={false} overScrollMode="never" onContentSizeChange={(_width, height) => setContent(height + 2 * menuLook.rim)}>
          <Animated.View style={rowsFade}>
          {page ? (
            <Pressable ref={firstRow} accessibilityRole="button" accessibilityLabel={`Back, ${page.label}`} onPress={backPage} {...ripple} style={({ pressed: on }) => [...pressed(on), { paddingLeft: labelLeft(true) }]}>
              <MenuIcon name="chevronLeft" color={paint.icon} left={iconLeft} />
              {label(page.label, paint.label, true)}
            </Pressable>
          ) : null}
          {drawn}
          </Animated.View>
          </ScrollView>
        </MenuMaterial>
      </Animated.View>
      </Animated.View>
    </View>
  );
}

export function MenuMaterial({ source, fill, solid, radius, style, children }: { source: string | null; fill: string; solid: string; radius: number; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  if (!source || !lookIsNative() || MATERIAL) return <View style={[style, { backgroundColor: solid, borderRadius: radius }]}>{children}</View>;
  return (
    <LookFrost source={source} variant={menuLook.frost} cornerRadius={radius} fill={ink.clear} style={style}>
      <View testID="menuMaterialFill" pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: fill }]} />
      {children}
    </LookFrost>
  );
}

function MenuIcon({ name, color, left }: { name: SymbolName; color: string; left: number }) {
  return (
    <View style={[styles.iconSlot, { left }]}>
      <Symbol name={name} size={menuLook.iconSize} color={color} />
    </View>
  );
}

type Insets = { top: number; bottom: number; left: number; right: number };

export function pointPlacer(at: Point, screen: { width: number; height: number }, insets: Insets, width: number, limits?: MenuLimits): MenuPlacer {
  const host = { x: 0, y: 0, width: screen.width, height: screen.height };
  return (height, keepBelow, pageWidth = width) => {
    const spot = menuAt(at, host, insetRect(host, insets), pageWidth, height, MENU_MARGIN, keepBelow, limits);
    return { place: { left: spot.left, top: spot.top, width: pageWidth }, origin: spot.origin, maxHeight: spot.height };
  };
}

function triggerPlacer(row: Rect, host: Rect, insets: Insets, width: number, align?: MenuAlign, clearAnchor = false): MenuPlacer {
  return (height, keepBelow, pageWidth = width) => {
    const spot = menuOnTrigger(row, host, host.width > 0 ? insetRect(host, insets) : host, pageWidth, height, MENU_MARGIN, keepBelow, align, clearAnchor);
    return { place: { left: spot.left, top: spot.top, width: pageWidth }, origin: spot.origin, maxHeight: spot.height, shrink: menuShrink(row, pageWidth, spot.height) };
  };
}

function fixedPlacer(place: ViewStyle, host: Rect, insets: Insets, width: number): MenuPlacer {
  return (height, _keepBelow, pageWidth = width) => {
    if (typeof place.top !== "number") return { place: { ...place, width: pageWidth }, origin: place.bottom !== undefined ? "bottom" : "top" };
    const room = host.width > 0 ? insetRect(host, insets) : host;
    const roomTop = room.y + MENU_MARGIN;
    const roomBottom = room.y + room.height - MENU_MARGIN;
    const fitted = Math.min(height, roomBottom - roomTop);
    const top = Math.max(roomTop, Math.min(place.top, roomBottom - fitted)) - host.y;
    const left = typeof place.left === "number" ? Math.max(room.x + MENU_MARGIN, Math.min(place.left, room.x + room.width - MENU_MARGIN - pageWidth)) - host.x : place.left;
    return { place: { ...place, width: pageWidth, top, left }, origin: "top", maxHeight: fitted };
  };
}

const EXIT_SLACK_MS = 32;

export const menuExitMs = (dimmed?: boolean) => (dimmed ? menuMotion.heldClose : menuMotion.close) + EXIT_SLACK_MS;

const widthOf = (place: ViewStyle) => (typeof place.width === "number" ? place.width : menuLook.width);

type FloatingProps = Omit<Props, "shown" | "origin" | "placer" | "place"> & { place?: ViewStyle; anchor?: RefObject<ViewInstance | null>; at?: Point | null; align?: MenuAlign; floor?: number | null };

export function FloatingMenu({ items, place = {}, onDismiss, anchor, at, align, floor, dimmed, frost, privately }: FloatingProps) {
  const material = useDesign() === "material";
  const hostFrame = useOverlayFrame();
  const insets = useSafeAreaInsets();
  const screen = useWindowDimensions();
  const frostAround = useMenuFrost();
  const width = material ? materialMenuWidth(items) : widthOf(place);
  const [measured, setMeasured] = useState<{ host: Rect; row: Rect | null } | null>(null);
  useEffect(() => {
    if (at && !anchor) return;
    let live = true;
    void Promise.all([hostFrame(), anchor ? measureAnchor(anchor) : Promise.resolve(null)]).then(([host, row]) => {
      if (live) setMeasured({ host, row: row && row.height > 0 ? row : null });
    });
    return () => {
      live = false;
    };
  }, []);
  const heldWithoutPoint = dimmed && !at && measured?.row ? { x: measured.row.x, y: measured.row.y + measured.row.height } : null;
  const point = at ?? heldWithoutPoint;
  const placer = point ? (anchor && !measured ? undefined : pointPlacer(point, screen, insets, width, { control: measured?.row, floor })) : measured ? (measured.row ? triggerPlacer(measured.row, measured.host, insets, width, align, material) : fixedPlacer(place, measured.host, insets, width)) : undefined;
  return (
    <Portal exitMs={menuExitMs(dimmed)}>
      <Menu items={items} place={{ ...place, width }} placer={placer} shown={placer !== undefined} dimmed={dimmed} privately={privately} frost={frost === undefined ? frostAround : frost} onDismiss={onDismiss} />
    </Portal>
  );
}

const materialStyles = StyleSheet.create({
  menu: { position: "absolute", minWidth: 112, maxWidth: 280 },
  groups: { gap: MATERIAL_MENU_GROUP_GAP },
  menuGroup: { borderRadius: materialShape.large, paddingVertical: 4, elevation: 3, overflow: "hidden" },
  menuItem: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: materialSize.touchTarget, paddingHorizontal: 12 },
  menuLabel: { flex: 1 },
  menuHeading: { paddingHorizontal: 12, paddingVertical: 8 },
});

const styles = StyleSheet.create({
  panel: { position: "absolute", minWidth: menuLook.width, borderRadius: menuLook.radius, borderWidth: menuLook.rim, ...smoothCorners },
  unseen: { opacity: 0 },
  material: { overflow: "hidden", ...smoothCorners },
  scroll: { flexGrow: 0 },
  rows: { paddingVertical: menuLook.padding / 2 },
  specular: { position: "absolute", top: 0, left: 0, right: 0, height: 1 },
  row: { flexDirection: "row", alignItems: "center", marginHorizontal: PRESS, minHeight: menuLook.row, paddingVertical: (menuLook.row - menuLook.label.lineHeight) / 2, paddingRight: menuLook.labelInset - PRESS, borderRadius: menuLook.pressRadius, ...smoothCorners },
  chevronRoom: { paddingRight: menuLook.trailingInset - PRESS + menuLook.chevronSize + 8 },
  chevron: { position: "absolute", right: menuLook.trailingInset - PRESS, top: 0, bottom: 0, justifyContent: "center" },
  label: { flex: 1 },
  bold: { fontWeight: "600" },
  heading: { minHeight: menuLook.heading, paddingTop: 8, paddingRight: menuLook.labelInset },
  divider: { height: menuLook.divider, justifyContent: "center" },
  dividerLine: { height: menuLook.dividerLine, marginHorizontal: menuLook.dividerInset },
  check: { position: "absolute", left: menuLook.checkLeft - PRESS, top: 0, bottom: 0, justifyContent: "center" },
  checkTrailing: { position: "absolute", right: menuLook.trailingInset - PRESS, top: 0, bottom: 0, justifyContent: "center" },
  checkRoom: { paddingRight: menuLook.trailingInset - PRESS + menuLook.checkSize + 12 },
  iconSlot: { position: "absolute", width: menuLook.iconSlot, top: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
  disabled: { opacity: menuLook.disabledOpacity },
});
