import { Platform, StyleSheet } from "react-native";
import { FLOATING_BAR_PLACE } from "../../lib/deckGeometry";
import { withAlpha } from "../../lib/color";
import { ANDROID_MENU_SIZES, IPHONE_MENU_SIZES } from "../../lib/menuPlace";
import { neutralFills } from "./paletteTokens";
import { targetMinimum } from "./targetTokens";
export const ink = { white: "#FFFFFF", black: "#000000", clear: "#00000000", knobShadow: "rgba(0,0,0,0.25)" } as const;

export const shape = { control: 12, field: 12, row: 12, card: 16, panel: 22 } as const;

export const smoothCorners = { borderCurve: "continuous" } as const;

export const controlSize = { bar: FLOATING_BAR_PLACE.control, hitTarget: targetMinimum } as const;

export const stroke = { chrome: 0.5, hairline: StyleSheet.hairlineWidth, field: 1 } as const;

export const press = { textOpacity: 0.35, iconOpacity: 0.35, filledOpacity: 0.8, disabledOpacity: 0.4 } as const;

const ANDROID_DARK_SURFACE = "#1E1B1D";

const rowPress = { light: "rgba(0,0,0,0.06)", dark: "rgba(255,255,255,0.1)" };

export const toggleLayout = { width: 51, height: 31, knob: 27, inset: 2 } as const;

export { PROFILE_COLORS, type ProfileColor, type ProfileColorSpec } from "./paletteTokens";

const lightRoles = {
  dark: false,
  label: "#000000",
  foregroundPrimary: "rgba(14,15,16,0.9)",
  foregroundSecondary: "rgba(0,0,0,0.5)",
  foregroundTertiary: "rgba(0,0,0,0.3)",
  fieldFill: "rgba(0,0,0,0.06)",
  fieldStroke: "rgba(0,0,0,0.06)",
  rowIcon: "rgba(0,0,0,0.42)",
  rowHighlight: rowPress.light,
  plusFill: "rgba(118,118,128,0.16)",
  chevronFill: "rgba(118,118,128,0.12)",
  controlEdge: "rgba(0,0,0,0.06)",
  disabled: "rgba(0,0,0,0.2)",
  accent: "#6395FC",
  formAccent: "#007AFF",
  switchOn: "#34C759",
  trayShadow: "#000000",
  trayDim: "rgba(0,0,0,0.16)",
  pageSurface: "#FFFFFF",
  tileFill: "rgba(118,118,128,0.2)",
  tileEdge: "rgba(0,0,0,0.14)",
  cardEdge: "rgba(0,0,0,0.08)",
  headerText: "rgba(14,15,16,0.88)",
  secondaryLabel: "rgba(60,60,67,0.6)",
  deckControl: "rgba(255,255,255,0.62)",
  destructive: "#FF3B30",
  panel: "#FFFFFF",
  divider: "rgba(0,0,0,0.09)",
  menuScrim: "rgba(0,0,0,0.12)",
  placeholderTints: ["#E8E6FB", "#FBE7EE", "#E3F0FB", "#E6F5EA", "#FDF0DD", "#EFE6F8"] as readonly string[],
  groupFill: "#FFFFFF",
  separator: "rgba(60,60,67,0.29)",
  tertiaryFill: "rgba(118,118,128,0.12)",
  tertiaryLabel: "rgba(60,60,67,0.3)",
  toastFill: "rgba(255,255,255,0.97)",
  toastLabel: "#000000",
  toastShadow: "rgba(0,0,0,0.18)",
  panelBorder: "rgba(0,0,0,0.1)",
  dialogScrim: "rgba(0,0,0,0.32)",
  appSurface: neutralFills.light.appSurface as string,
  groupedBackground: neutralFills.light.groupedBackground as string,
  groupedCell: neutralFills.light.groupedCell as string,
  rowPressed: rowPress.light,
  secondaryFill: "rgba(120,120,128,0.16)",
  switchOff: "rgba(120,120,128,0.16)",
};

export type ColorRoles = typeof lightRoles;

const darkRoles: ColorRoles = {
  dark: true,
  label: "#FFFFFF",
  foregroundPrimary: "rgba(255,255,255,0.8)",
  foregroundSecondary: "rgba(255,255,255,0.5)",
  foregroundTertiary: "rgba(255,255,255,0.3)",
  fieldFill: "rgba(255,255,255,0.12)",
  fieldStroke: "rgba(255,255,255,0.08)",
  rowIcon: "rgba(255,255,255,0.5)",
  rowHighlight: rowPress.dark,
  plusFill: "rgba(255,255,255,0.16)",
  chevronFill: "rgba(255,255,255,0.13)",
  controlEdge: "rgba(255,255,255,0.1)",
  disabled: "rgba(255,255,255,0.25)",
  accent: "#4A77D4",
  formAccent: "#0A84FF",
  switchOn: "#30D158",
  trayShadow: "#000000",
  trayDim: "rgba(0,0,0,0.42)",
  pageSurface: "#000000",
  tileFill: "rgba(255,255,255,0.2)",
  tileEdge: "rgba(255,255,255,0.28)",
  cardEdge: "rgba(255,255,255,0.12)",
  headerText: "rgba(255,255,255,0.92)",
  secondaryLabel: "rgba(235,235,245,0.6)",
  deckControl: "rgba(255,255,255,0.14)",
  destructive: "#FF453A",
  panel: "#1C1C1E",
  divider: "rgba(255,255,255,0.09)",
  menuScrim: "rgba(0,0,0,0.3)",
  placeholderTints: ["#262447", "#3F2532", "#1E3046", "#1F3527", "#3D3020", "#30243F"] as readonly string[],
  groupFill: "#1C1C1E",
  separator: "rgba(84,84,88,0.6)",
  tertiaryFill: "rgba(118,118,128,0.24)",
  tertiaryLabel: "rgba(235,235,245,0.3)",
  toastFill: "rgba(28,28,30,0.97)",
  toastLabel: "#FFFFFF",
  toastShadow: "rgba(0,0,0,0.5)",
  panelBorder: "rgba(255,255,255,0.1)",
  dialogScrim: "rgba(0,0,0,0.48)",
  appSurface: neutralFills.dark.appSurface,
  groupedBackground: neutralFills.dark.groupedBackground,
  groupedCell: neutralFills.dark.groupedCell,
  rowPressed: rowPress.dark,
  secondaryFill: "rgba(120,120,128,0.32)",
  switchOff: "rgba(120,120,128,0.32)",
};

export const colorRoles = { light: lightRoles, dark: darkRoles } as const;

export const menuLayout = {
  sheetRadius: 38,
  inset: 16,
  innerRadius: 22,
  capsuleHeight: 44,
  tileHeight: 68,
  rowHeight: 50,
  iconSlot: 26,
  zoomButton: { width: 40, height: 34 },
  zoomReset: 48,
  sheetTopGap: Platform.OS === "ios" ? 10 : 24,
  sheetGrabber: Platform.OS === "ios" ? { width: 36, height: 5, top: 6 } : null,
  halfSheetGrabber: { width: 32, height: 4, top: 10 },
} as const;

export const floatingSheetLayout = { inset: 8, bottomRadius: 50, halfShare: 0.5156, topGap: 0, grabber: { width: 60, height: 4, top: 6 } } as const;

export const pageMenuLayout = { actionGlyph: 24, barSpacing: 8, groupSpacing: 16, zoomHeight: 32, zoomButtonWidth: 40, zoomReset: 48, rowInset: 16, accessibilityBottom: 24 } as const;

export const pageMenuInk = {
  light: { sheet: "#FFFFFF", group: "#FFFFFF", rowPressed: "rgba(120,120,128,0.2)" },
  dark: { sheet: "#000000", group: "#171717", rowPressed: "rgba(120,120,128,0.36)" },
} as const;

export const toastLayout = { radius: shape.control, minHeight: 44, verticalPadding: 11, iconSize: 17, barClearance: 64, sideInset: 32, shadowRadius: 14, shadowY: 6 } as const;

export const pageInk = { findError: "#C93333" } as const;

export const readerInk = {
  light: { background: "#FFFFFF", ink: "#1C1C1E", secondary: "rgba(28,28,30,0.6)" },
  sepia: { background: "#F8F1E3", ink: "#4F321C", secondary: "rgba(79,50,28,0.6)" },
  dark: { background: "#121214", ink: "#E3E3E6", secondary: "rgba(227,227,230,0.6)" },
} as const;

export const readerLayout = { minLeadAspect: 0.75, maxWidth: 680, topBar: 52, chromeBand: 46, chromeSide: 16, chromeButton: 44, chromeCapsulePadding: 16, leadRadius: 12, lineHeight: 1.52, titleScale: 1.55, titleLine: 1.2, paragraphGap: 0.9, headerGap: 1.2 } as const;

export const dialogLayout = { width: 312, radius: shape.panel, fieldHeight: 48 } as const;

export const settingsLayout = {
  removeDot: 24,
  removeGlyph: 14,
  expoListTop: 12,
  groupRadius: shape.panel,
  rowMinHeight: 52,
  rowInset: 16,
  labelGap: 16,
  tile: 29,
  heroTile: 64,
  heroScrollThreshold: 150,
  syncTile: 56,
  syncTileLarge: 44,
  accessibilityFontScale: 1.5,
  topBar: 52,
  swatch: 26,
  swatchRing: 2,
  swatchGap: 3,
  primaryButton: { radius: shape.card, height: { ios: 190 / 3, android: 50 } },
  stepShift: 60,
  titleWidth: 240,
} as const;

export const themeEditorLayout = {
  pad: 232,
  padWedges: 90,
  knob: 30,
  knobHitSlop: 10,
  knobBorder: 2,
  knobBorderSelected: 3,
  knobHalo: 3,
  lightnessSteps: 24,
  lightnessHeight: 10,
  track: 4,
  thumb: 26,
  dial: 44,
  dialSnap: 4,
  dialNotch: 45,
  dialHand: 2,
  dialHub: 6,
  preview: 150,
  stepper: 32,
  accessibilityStep: 0.1,
  accessibilityTurn: 1 / 24,
  rainbowStops: 7,
} as const;

export const themeEditorInk = { knobOutline: "rgba(0,0,0,0.25)" } as const;

export const settingsTint = {
  neutral: "#86888D",
  sync: "#458AFF",
  ads: "#FF5A5F",
  trackers: "#FFC829",
  cookies: "#FF901A",
  search: "#007AFF",
  blue: "#458AFF",
  archive: "#B059EE",
  keyboard: "#FFC829",
  nightShade: "#5856D6",
  green: "#3EA82E",
  clearData: "#FF5A5F",
  export: "#0153FF",
  onboarding: "#FF901A",
  swipe: "#458AFF",
  appLinks: "#3EA82E",
  defaultBrowser: "#007AFF",
  bottomBar: "#30B0C7",
  orange: "#FF901A",
  purple: "#B059EE",
} as const;

export const faviconInk = { letter: "#FFFFFF", lightPlate: "rgba(255,255,255,0.92)", darkPlate: "rgba(0,0,0,0.78)" } as const;

export const menuShadow = { opacity: 0.18, radius: 24, offsetY: 8 } as const;

const iPhoneMenuLook = {
  width: 250,
  radius: 30.5,
  rim: 0.5,
  ...IPHONE_MENU_SIZES,
  labelInset: 29,
  labelInsetChecked: 43.7,
  labelInsetIcon: 65,
  trailingInset: 26.7,
  iconCentre: 40,
  iconSlot: 24,
  iconSize: 19,
  checkSide: "leading" as "leading" | "trailing",
  checkLeft: 22.3,
  checkSize: 11,
  chevronSize: 12,
  pressInset: 10,
  pressRadius: 21,
  dividerInset: 24,
  dividerLine: 1,
  label: { fontSize: 17, lineHeight: 20 } as { fontSize: number; lineHeight: number; letterSpacing?: number },
  labelLines: 3,
  iconSide: "leading" as "leading" | "trailing",
  disabledOpacity: 0.4,
  frost: "glass" as "thin" | "glass",
  frosted: true,
  shadow: "0px 10px 40px rgba(0,0,0,0.12)",
};

const androidMenuLook: typeof iPhoneMenuLook = {
  width: 250,
  radius: 16,
  rim: 0.5,
  ...ANDROID_MENU_SIZES,
  labelInset: 16,
  labelInsetChecked: 16,
  labelInsetIcon: 52,
  trailingInset: 16,
  iconCentre: 28,
  iconSlot: 24,
  iconSize: 20,
  checkSide: "trailing",
  checkLeft: 16,
  checkSize: 14,
  chevronSize: 12,
  pressInset: 0,
  pressRadius: 0,
  dividerInset: 0,
  dividerLine: 0,
  label: { fontSize: 16, lineHeight: 24, letterSpacing: 0.5 },
  labelLines: 1,
  iconSide: "leading",
  disabledOpacity: 0.38,
  frost: "thin",
  frosted: false,
  shadow: "0px 2px 6px 2px rgba(0,0,0,0.15), 0px 1px 2px 0px rgba(0,0,0,0.3)",
};

export const menuLook = Platform.OS === "android" ? androidMenuLook : iPhoneMenuLook;

const iPhoneMenuInk = {
  light: {
    fill: "rgba(255,255,255,0.57)",
    solid: "#F8F6F7",
    label: "#0A090A",
    icon: "#0A090A",
    destructive: "#FE373C",
    highlight: "rgba(0,0,0,0.11)",
    divider: "rgba(0,0,0,0.08)",
    rim: "rgba(0,0,0,0.37)",
    specular: "rgba(255,255,255,0.7)",
    heading: "rgba(60,60,67,0.6)",
    dim: "rgba(0,0,0,0.2)",
  },
  dark: {
    fill: "rgba(150,150,150,0.26)",
    solid: "#504C4D",
    label: "#F9F8F8",
    icon: "#F9F8F8",
    destructive: "#FF6567",
    highlight: "rgba(255,255,255,0.11)",
    divider: "rgba(255,255,255,0.08)",
    rim: "rgba(0,0,0,0.85)",
    specular: "rgba(255,255,255,0.11)",
    heading: "rgba(235,235,245,0.6)",
    dim: "rgba(0,0,0,0.48)",
  },
};

const androidMenuInk: typeof iPhoneMenuInk = {
  light: {
    fill: "#F3EDF0",
    solid: "#F3EDF0",
    label: "#1F1A1D",
    icon: "#4F4449",
    destructive: "#BA1A1A",
    highlight: "rgba(31,26,29,0.1)",
    divider: "#D3C2C8",
    rim: ink.clear,
    specular: ink.clear,
    heading: "#4F4449",
    dim: ink.clear,
  },
  dark: {
    fill: ANDROID_DARK_SURFACE,
    solid: ANDROID_DARK_SURFACE,
    label: "#EBE0E4",
    icon: "#D3C2C8",
    destructive: "#FFB4AB",
    highlight: "rgba(235,224,228,0.1)",
    divider: "#3D3539",
    rim: "rgba(255,255,255,0.12)",
    specular: ink.clear,
    heading: "#D3C2C8",
    dim: ink.clear,
  },
};

export const menuInk = Platform.OS === "android" ? androidMenuInk : iPhoneMenuInk;

export const actionSheetLook = {
  width: 240.3,
  radius: 31,
  rim: 0.33,
  side: 31,
  top: 19,
  messageGap: 5.7,
  buttonGap: 19,
  buttonSide: 16.3,
  buttonBottom: 17.6,
  buttonHeight: 43.5,
  buttonsBetween: 8,
  screenMargin: 16,
  title: { fontSize: 17, lineHeight: 22, fontWeight: "600" },
  message: { fontSize: 15, lineHeight: 20 },
  button: { fontSize: 17, lineHeight: 22 },
  frost: "thin",
  shadow: "0px 10px 40px rgba(0,0,0,0.1)",
} as const;

export const actionSheetInk = {
  light: { fill: "rgba(255,252,253,0.92)", solid: "#F9F9F9", rim: "#9E9E9E", title: "#000000", message: "#989898", button: "#DFDFDF", destructive: "#F22F32" },
  dark: { fill: "rgba(72,72,72,0.92)", solid: "#484848", rim: "#2A2A2A", title: "#FFFFFF", message: "#C8C8C8", button: "#555555", destructive: "#FFB8B9" },
} as const;

export const materialDialogLook = {
  maxWidth: 560,
  radius: 28,
  padding: 24,
  messageGap: 16,
  buttonsGap: 24,
  buttonHeight: 40,
  buttonSide: 12,
  buttonsBetween: 8,
  screenMargin: 24,
  title: { fontSize: 24, lineHeight: 32 },
  message: { fontSize: 14, lineHeight: 20, letterSpacing: 0.25 },
  button: { fontSize: 14, lineHeight: 20, fontWeight: "500", letterSpacing: 0.1 },
  shadow: "0px 4px 8px 3px rgba(0,0,0,0.15), 0px 1px 3px 0px rgba(0,0,0,0.3)",
} as const;

export const materialDialogInk = {
  light: { surface: "#EDE7EA", title: "#1F1A1D", message: "#4F4449", dismiss: "#4F4449", action: "#894A67", destructive: "#BA1A1A", ripple: "rgba(137,74,103,0.12)", scrim: "rgba(0,0,0,0.32)" },
  dark: { surface: ANDROID_DARK_SURFACE, title: "#EBE0E4", message: "#D3C2C8", dismiss: "#D3C2C8", action: "#FFB0D0", destructive: "#FFB4AB", ripple: "rgba(255,176,208,0.12)", scrim: "rgba(0,0,0,0.32)" },
} as const;

export const trayShadow = { opacity: 0.14, radius: 24, offsetY: -4, elevation: 12 } as const;

export const scanInk = {
  glass: "rgba(255,255,255,0.2)",
  frame: "rgba(255,255,255,0.9)",
  unavailableIcon: "rgba(255,255,255,0.85)",
  note: "rgba(255,255,255,0.18)",
  soft: "rgba(255,255,255,0.75)",
} as const;

export const scanLayout = { frame: 250, frameStroke: 3, frameArmShare: 0.18, noteRadius: 12, cancelInset: 8, unavailableIcon: 48 } as const;

export const voiceInk = {
  label: "#FFFFFF",
  soft: "rgba(255,255,255,0.8)",
  quiet: "rgba(255,255,255,0.7)",
  bar: "rgba(255,255,255,0.85)",
  glass: "rgba(255,255,255,0.18)",
  transcript: "rgba(0,0,0,0.18)",
} as const;

export const voiceLayout = {
  appIcon: 104,
  pill: 50,
  cancel: 44,
  icon: 17,
  bar: 4,
  barGap: 4,
  barMin: 6,
  barRange: 38,
  waveHeight: 48,
  transcriptRadius: 22,
  levelMotion: 120,
} as const;

export const failureLayout = { icon: 36, textWidth: 320, button: 40 } as const;

export const archiveCardLayout = { radius: 16, tile: 28, maxWidth: 520, aboveBarCenter: 28, tint: "#B059EE" } as const;

export const onboardingArt = { appIcon: 60, linkCardWidth: 210, linkCardRadius: shape.card, stripHeight: 64, arrowLift: 26, arrowGlyph: 22, wordsVertical: 10, sheetRadius: 38 } as const;

export const floatingBarLayout = {
  control: FLOATING_BAR_PLACE.control,
  gap: FLOATING_BAR_PLACE.gap,
  bottomGap: FLOATING_BAR_PLACE.bottomGap,
  glyph: 19,
  menuGlyph: 17,
  menuSymbol: 23.3,
  privateSymbol: 28,
  addressLead: 13,
  addressSpacing: 6,
  siteIcon: 16,
  hostText: 15,
  maxTextScale: 1.35,
} as const;

export const floatingPanelLayout = {
  inset: 8,
  aboveKeyboard: 8,
  departLift: 120,
  departMs: 200,
} as const;

export const startLayout = {
  switcherRatio: 0.44,
  tilesGap: 45,
  pageDotsAboveBar: 60,
  barCircle: controlSize.bar,
  barPlus: { width: 77, height: controlSize.bar },
  barGap: 8,
  circleGlyph: 19.2,
  plusGlyph: 22.4,
  tilesPerRow: 4,
  tileSide: 20,
  tileGap: 8,
  tileHeight: 52,
  tileRadius: shape.row,
  tileIcon: 20,
  folderIconShare: 0.95,
  symbolIconShare: 0.9,
  folderInkOpacity: 0.55,
  spaceBadge: 20,
  badgeSymbolShare: 0.85,
  badgeSymbolWidth: 1.25,
  badgeEmojiShare: 0.8,
  titleSpacing: 8,
  chevron: 12,
  pageDot: 7,
  pageDotSpacing: 21,
  invitationPadding: 20,
  logoPressOpacity: 0.85,
} as const;

export const deckChromeLayout = {
  headerCircle: 44,
  headerCenter: 26,
  headerSide: 12,
  headerGap: 8,
  menuGap: 8,
  pillHeight: 38,
  pillPadding: 14,
  pillSpacing: 8,
  pillSpecs: 20,
  barCircle: controlSize.bar,
  barGap: 8,
  searchLead: 13,
  searchTrail: 16,
  searchTrailFilled: 8,
  searchSpacing: 8,
  searchGlyph: 16.8,
  incognitoEyes: 30,
  clearHit: 32,
  archiveCenter: 78.5,
  archiveHeight: 43,
  archiveMaxWidth: 560,
  archiveLead: 16,
  archiveTrail: 8,
  archiveSpacing: 4,
  archiveText: 14,
  archiveTextMinScale: 0.8,
  archivePickerSpacing: 3,
  archivePickerHeight: 36,
  archiveChevron: 13.2,
  archiveDismiss: 36,
  archiveDismissGlyph: 15.6,
} as const;

export const deckChromeInk = { pill: "#FFFFFF" } as const;

export const startInk = {
  veil: "rgba(255,255,255,0.34)",
  light: { pageDot: "rgba(0,0,0,0.32)", badgeInk: "#000000" },
  dark: { pageDot: "rgba(255,255,255,0.32)", badgeInk: "#FFFFFF" },
} as const;

export const chromeLayout = { edge: stroke.chrome, shadowRadius: 10, shadowY: 2, barSideInset: 24, barCastsShadow: Platform.OS === "ios" } as const;

export const chromeInk = {
  light: { surface: "#FFFFFF", edge: "rgba(0,0,0,0.12)", shadow: "rgba(0,0,0,0.12)", foreground: "rgba(14,15,16,0.9)", secondary: "rgba(0,0,0,0.5)", notSecure: lightRoles.destructive },
  dark: { surface: Platform.OS === "android" ? ANDROID_DARK_SURFACE : "#000000", edge: "rgba(255,255,255,0.12)", shadow: "rgba(0,0,0,0.4)", foreground: "rgba(255,255,255,0.8)", secondary: "rgba(255,255,255,0.5)", notSecure: darkRoles.destructive },
} as const;

export const syncSketch = {
  macWidth: 250,
  macHeight: 168,
  macTrailing: 46,
  macBottom: 40,
  macRadius: 12,
  macShadow: "0px 8px 36px rgba(0, 0, 0, 0.18)",
  sidebarWidth: 84,
  sidebarPadding: 10,
  sidebarGap: 7,
  light: 7,
  lightGap: 4,
  tabSwatch: 9,
  tabSwatchRadius: 2.5,
  tabGap: 5,
  tabBar: 5,
  qr: 74,
  qrGap: 8,
  lineWide: 90,
  lineNarrow: 64,
  phoneWidth: 92,
  phoneHeight: 186,
  phoneRadius: 22,
  phoneScreenInset: 4,
  phoneScreenRadius: 18,
  phoneShadow: "0px 8px 28px rgba(0, 0, 0, 0.25)",
  phoneBody: "#141414",
  phoneScreen: "#383838",
  notchWidth: 28,
  notchHeight: 8,
  notchTop: 10,
  finder: 58,
  finderArmShare: 0.28,
  finderStroke: 3,
  finderQr: 40,
  finderQrOpacity: 0.85,
  check: 30,
  trafficLights: ["#FF5F57", "#FEBC2E", "#28C840"],
  tabs: [
    { look: "blue", width: 44 },
    { look: "pink", width: 36 },
    { look: "orange", width: 48 },
    { look: "green", width: 30 },
    { look: "purple", width: 40 },
  ],
} as const;

export const sheetInk = { scrim: "rgba(0,0,0,0.25)", fill: { light: neutralFills.light.groupedBackground, dark: neutralFills.dark.groupedBackground } } as const;

export const sheetLayout = { topGap: 10, iPhoneTopGap: 0, radius: 32, backgroundRadius: 24 } as const;

export const syncInk = { banner: "#FF9500" } as const;

export const expoSpacesLayout = {
  sheetRadius: 38,
  headerCircle: 44,
  headerGap: 8,
  headerLeading: 24,
  page: 16,
  small: 12,
  tight: 8,
  section: 32,
  bannerGap: 10,
  bannerPadding: 12,
  bannerRadius: shape.row,
  rowInset: 20,
  rowHeight: 48,
  showAllHeight: 44,
  icon: 24,
  iconMax: 40,
  dotsPadding: 22,
  dotsHeight: 44,
} as const;

export const spacesLayout = {
  switchWidth: 52,
  switchHeight: 36,
  switchUnselectedOpacity: 0.35,
  headerCircle: 32,
  bannerGap: 10,
  bannerPadding: 12,
  bannerRadius: shape.row,
  headerGap: 6,
  headerBottom: 4,
  tileGap: 6,
  stackGap: 10,
  tileFaceRadius: 11,
  dot: 9,
  buttonTop: 6,
  stepBadge: 26,
  stepBadgeEdge: 1.5,
  stepTileRadius: 7,
  stepDividerInset: 56,
} as const;

export const tabsInk = {
  incognitoCard: "#1C1D22",
  incognitoCardRaised: "#2A2B31",
  incognitoOnLight: "rgba(28,29,34,0.6)",
  incognitoBackdrop: ["#1A1A1E", "#0E0E10"] as const,
  incognitoSheet: "#151517",
  cardShadow: "rgba(0,0,0,0.18)",
  tileShadow: "rgba(0,0,0,0.2)",
  onDark: "rgba(255,255,255,0.85)",
  onDarkSoft: "rgba(255,255,255,0.55)",
  onDarkChip: "rgba(255,255,255,0.6)",
  pagerBlack: "#000000",
  pagerShadow: ["rgba(0,0,0,0)", "rgba(0,0,0,0.08)", "rgba(0,0,0,0.26)"] as const,
  barShadeOnDark: "rgba(255,255,255,0.06)",
  barShadeOnLight: "rgba(0,0,0,0.025)",
} as const;

export const tabsLayout = {
  pagerEdgeShadow: 36,
  cardRadius: 13,
  displayCornerRadius: 55,
  faviconSize: 16,
  specsChip: 20,
  specsIcon: 14,
  specsCompact: 14,
  specsFace: 44,
  headerSpacing: 6,
  headerGap: 8,
  headerHeight: 20,
  barCircle: 35,
  barPlus: { width: 78, height: 40 },
  barSideInset: 16,
  tabStackTile: { width: 20, height: 26 },
  tabStackRadius: 5,
  tabStackButton: 47,
  barTouchClearance: 28,
  chipHeight: 32,
  faviconRadius: 4,
  menuWidth: 250,
  cardMenuHeight: 190,
  emptyWidth: 300,
  archiveTop: 52,
  archiveButton: 44,
  archiveMoreGlyph: 20,
  receivedBadgeRadius: 6,
  receivedBadgeInset: 10,
  receivedBadgeGlyph: 12,
  archiveField: 40,
  archiveTile: 28,
} as const;

export const space = { none: 0, hair: 1, tight: 2, xs: 4, s: 8, m: 12, l: 16, xl: 20, xxl: 24, huge: 32 } as const;

export const shadowRadius = { tile: 1.5, knob: 2, card: 16, lifted: 24 } as const;

export const radius = { row: shape.row, field: shape.field, card: shape.card, sheet: 40 } as const;

export const capsule = (height: number) => height / 2;

export const controlRadius = (side: number) => Math.min(shape.control, Math.round(side * 0.3));

type ShadowRole = { y: number; blur: number; light: string; dark: string };

function cssShadowOf({ y, blur, light, dark: night }: ShadowRole, dark: boolean) {
  return `0px ${y}px ${blur}px ${dark ? night : light}`;
}

const appIconElevation = { y: 4, blur: 20, light: "rgba(0,0,0,0.12)", dark: "rgba(0,0,0,0.12)" } as const;

export const appIconLayout = {
  maxScale: 1.4,
  corner: 0.225,
  fill: "#F8F3E1",
  shadow: cssShadowOf(appIconElevation, false),
  about: 72,
  welcome: 104,
  welcomeFrame: 5,
  welcomeShadow: "0px 12px 48px rgba(0, 0, 0, 0.18)",
} as const;

export const font = {
  hero: { fontSize: 40, lineHeight: 46 },
  largeTitle: { fontSize: 34, lineHeight: 41 },
  title: { fontSize: 28, lineHeight: 34 },
  title2: { fontSize: 22, lineHeight: 28 },
  title3: { fontSize: 20, lineHeight: 25 },
  body: { fontSize: 17, lineHeight: 22 },
  callout: { fontSize: 16, lineHeight: 21 },
  subheadline: { fontSize: 15, lineHeight: 20 },
  footnote: { fontSize: 13, lineHeight: 18 },
  caption: { fontSize: 12, lineHeight: 16 },
  caption2: { fontSize: 11, lineHeight: 13 },
} as const;

export const browseLayout = {
  barCollapseTravel: 30,
  barSwipeUp: 22,
  searchFieldHeight: 47.5,
  fieldLeading: 18,
  fieldTrailing: 10,
  suggestionPitch: 58.5,
  suggestionIconSlot: 22,
  rowLeading: 12,
  rowTrailing: 7,
  refineWidth: 44,
  logoWidth: 132,
  logoHeight: 108,
  plusCapsule: { width: 78, height: 40 },
  chevronCircle: 35,
  chevronGlyph: 16,
  findButton: 40,
  findGlyph: 18,
  barCenterFromBottom: 44,
  barSideInset: 20,
  hitTarget: controlSize.hitTarget,
  barHeight: 75,
  pageOverlap: 26,
  progressHeight: 2.5,
  hostPillHeight: 40,
  accessory: { width: 32, height: 40 },
  traySurfaceInset: 8,
} as const;

export const logoInk = {
  sun: ["#FFCB45", "#F5A812"],
  backHill: ["#8DAF63", "#5E7D3E"],
  frontHill: ["#17604B", "#063528"],
  outline: "#FFFFFF",
} as const;

export const elevation = {
  control: { y: chromeLayout.shadowY, blur: chromeLayout.shadowRadius * 2, light: chromeInk.light.shadow, dark: chromeInk.dark.shadow },
  card: { y: 3, blur: 20, light: "rgba(0,0,0,0.11)", dark: "rgba(0,0,0,0.4)" },
  floating: { y: 4, blur: 36, light: "rgba(0,0,0,0.1)", dark: "rgba(0,0,0,0.3)" },
  stack: { y: 6, blur: 28, light: tabsInk.cardShadow, dark: tabsInk.cardShadow, android: 14 },
  appIcon: appIconElevation,
} as const;

export type ElevationLevel = keyof typeof elevation;

export const shadowCss = (level: ElevationLevel, dark: boolean) => cssShadowOf(elevation[level], dark);

export const nativeShadowRadius = (level: ElevationLevel) => elevation[level].blur / 2;

export const swipeDeleteLayout = { slop: 12, revealWidth: 88, glyph: 20 } as const;

export const accentGlow = { y: 2, blur: 12, alpha: 0.35 } as const;

export const accentGlowCss = (accent: string) => {
  const glow = withAlpha(accent, accentGlow.alpha);
  return cssShadowOf({ y: accentGlow.y, blur: accentGlow.blur, light: glow, dark: glow }, false);
};

const dynamicColor = (light: string, dark: string) => ({ dynamic: { light, dark } });

export const nativeClassicChrome = {
  fill: dynamicColor(chromeInk.light.surface, chromeInk.dark.surface),
  edgeWidth: stroke.chrome,
  edge: dynamicColor(chromeInk.light.edge, chromeInk.dark.edge),
  shadowRadius: nativeShadowRadius("control"),
  shadowY: elevation.control.y,
  shadow: dynamicColor(elevation.control.light, elevation.control.dark),
} as const;

export const overlayInk = { fill: ink.white, onFill: ink.black, glass: "rgba(255,255,255,0.18)", solidGlass: "#3A3A3C", label: ink.white, edge: "rgba(255,255,255,0.55)" } as const;

export type ActionSize = "hero" | "regular" | "compact";

export const actionLayout = {
  height: { hero: Platform.OS === "ios" ? settingsLayout.primaryButton.height.ios : settingsLayout.primaryButton.height.android, regular: 50, compact: controlSize.hitTarget },
  radius: { hero: settingsLayout.primaryButton.radius, regular: shape.control, compact: shape.control },
  sidePadding: { hero: space.xl, regular: space.xl, compact: space.l },
  verticalPadding: space.m,
  label: { hero: font.body, regular: font.body, compact: font.subheadline },
  labelWeight: "600",
  nativeLabelWeight: "semibold",
  icon: { hero: 19, regular: 19, compact: 17 },
  iconGap: space.s,
  edge: 1,
} as const;

export const faviconLayout = { cornerShare: 0.26, plateInset: 0.14, letterShare: 0.56, letterLine: 1.15, globeShare: 0.6 } as const;

export const emptyStateLayout = { glyph: 40, maxWidth: tabsLayout.emptyWidth, gap: space.s, glyphGap: space.m, actionGap: space.l, pad: space.xxl } as const;

export const glyphSlot = { field: 20, icon: 22 } as const;

export const barGlyphLayout = { plus: { pointSize: 18, weight: "medium", side: startLayout.plusGlyph }, circle: { pointSize: 16, weight: "medium", side: startLayout.circleGlyph } } as const;

export const primaryActionRoles = {
  hero: { height: actionLayout.height.hero, radius: actionLayout.radius.hero, fill: "spaceAccent", ink: "onSpaceAccent", nativeControlSize: "extraLarge", wraps: true },
  full: { height: actionLayout.height.regular, radius: actionLayout.radius.regular, fill: "spaceAccent", ink: "onSpaceAccent", nativeControlSize: "large", wraps: true },
  compact: { height: actionLayout.height.compact, radius: actionLayout.radius.compact, fill: "spaceAccent", ink: "onSpaceAccent", nativeControlSize: "regular", wraps: true },
} as const;

export type PrimaryActionRole = keyof typeof primaryActionRoles;

export const actionRoleOf = { hero: "hero", regular: "full", compact: "compact" } as const satisfies Record<ActionSize, PrimaryActionRole>;
