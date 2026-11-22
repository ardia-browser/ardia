import { requireNativeView } from "expo";
import { requireOptionalNativeModule } from "expo-modules-core";
import { createElement, type ComponentType, type ReactNode } from "react";
import { Platform } from "react-native";
import type { LookColors } from "./look";

export type ModifierConfig = { $type: string; [key: string]: unknown; eventListener?: (args: unknown) => void };

type ModifierHelpers = {
  createModifier: (type: string, params?: Record<string, unknown>) => ModifierConfig;
  createViewModifierEventListener: (modifiers: ModifierConfig[]) => object;
};

let helpers: ModifierHelpers | undefined;
const modifierHelpers = (): ModifierHelpers =>
  (helpers ??= Platform.OS === "android" ? require("@expo/ui/jetpack-compose/modifiers") : require("@expo/ui/swift-ui/modifiers"));

export type SettingsTintName =
  | "neutral" | "red" | "orange" | "yellow" | "blue" | "deepBlue" | "purple" | "green"
  | "sync" | "ads" | "trackers" | "cookies" | "search" | "archive" | "keyboard" | "swipe" | "nightShade"
  | "appLinks" | "bottomBar" | "defaultBrowser" | "clearData" | "export" | "onboarding"
  | "swatch";

export type ProfilePresetName = "plum" | "blue" | "purple" | "pink" | "red" | "orange" | "yellow" | "green" | "neutral";

export type SetupProgress = "done" | "current" | "upcoming";

export const SETTINGS_UI_MODULE = "ArdiaPhoneSettingsUI";

export const settingsUIAvailable = () => requireOptionalNativeModule(SETTINGS_UI_MODULE) !== null;

export type SettingsPieceProps = { testID?: string; modifiers?: ModifierConfig[]; children?: ReactNode };

const views = new Map<string, ComponentType<object>>();

function piece<P extends SettingsPieceProps>(name: string) {
  return function SettingsPiece(props: P) {
    if (!settingsUIAvailable()) return null;
    const native = views.get(name) ?? requireNativeView<object>(SETTINGS_UI_MODULE, name);
    views.set(name, native);
    const { modifiers, ...rest } = props;
    const listeners = modifiers?.length ? modifierHelpers().createViewModifierEventListener(modifiers) : undefined;
    return createElement(native, { ...rest, modifiers, ...listeners });
  };
}

export const SettingsIconTile = piece<SettingsPieceProps & { systemImage: string; tint: SettingsTintName; baseSide?: number }>("SettingsIconTileView");

export const SettingsRowLabel = piece<SettingsPieceProps & { title: string; systemImage: string; tint: SettingsTintName }>("SettingsRowLabelView");

export const SettingsHeroContent = piece<SettingsPieceProps & { title: string; subtitle: string; subtitleIsWarning?: boolean; systemImage: string; tint: SettingsTintName }>("SettingsHeroContentView");

export const SetupStepRow = piece<SettingsPieceProps & { number: number; title: string; detail: string; progress: SetupProgress }>("SetupStepRowView");

export const ColorSwatch = piece<SettingsPieceProps & { preset: ProfilePresetName; isSelected: boolean; colors?: string[]; ring?: string }>("ColorSwatchView");

export const CheckmarkLabel = piece<SettingsPieceProps & { title: string; isChecked: boolean }>("CheckmarkLabelView");

export const AppIconPreview = piece<SettingsPieceProps & { side?: number }>("AppIconPreviewView");

export type SettingsShortcutItem = { id: string; title: string };

const NativeShortcuts = piece<SettingsPieceProps & { shortcuts: SettingsShortcutItem[]; onShortcutPress: (event: { nativeEvent: { id: string } }) => void }>("SettingsShortcutsView");

export function SettingsShortcuts({ onPress, ...props }: SettingsPieceProps & { shortcuts: SettingsShortcutItem[]; onPress: (id: string) => void }) {
  return createElement(NativeShortcuts, { ...props, onShortcutPress: (event: { nativeEvent: { id: string } }) => onPress(event.nativeEvent.id) });
}

export type SpaceLook = { color?: string | null; icon?: string | null; themeColors?: string[]; themeDarkColors?: string[] | null };

export const SpaceTitle = piece<SettingsPieceProps & SpaceLook & { name: string; showsChevron: boolean }>("SpaceTitleView");

export const SpacePageDots = piece<SettingsPieceProps & { count: number; index: number }>("SpacePageDotsView");

const NativeGlassCircleButton = piece<SettingsPieceProps & { symbol: string; label: string; diameter?: number; onButtonPress: () => void }>("GlassCircleButtonView");

export function GlassCircleButton({ onPress, ...props }: SettingsPieceProps & { symbol: string; label: string; diameter?: number; onPress: () => void }) {
  return createElement(NativeGlassCircleButton, { ...props, onButtonPress: () => onPress() });
}

export type PinnedTileItem = { key: string; title: string; url: string; icon?: string | null; folder?: { key?: string; title: string; url: string }[] | null };

const NativePinnedTiles = piece<SettingsPieceProps & { tiles: PinnedTileItem[]; onTileOpen: (event: { nativeEvent: { url: string; title: string } }) => void }>("PinnedTilesView");

export function PinnedTiles({ onOpen, ...props }: SettingsPieceProps & { tiles: PinnedTileItem[]; onOpen: (tab: { url: string; title: string }) => void }) {
  return createElement(NativePinnedTiles, { ...props, onTileOpen: (event: { nativeEvent: { url: string; title: string } }) => onOpen(event.nativeEvent) });
}

const NativeFullScreenCover = piece<SettingsPieceProps & { isPresented: boolean; onIsPresentedChange: (event: { nativeEvent: { isPresented: boolean } }) => void }>("FullScreenCoverView");

export function FullScreenCover({ onIsPresentedChange, ...props }: SettingsPieceProps & { isPresented: boolean; onIsPresentedChange?: (isPresented: boolean) => void }) {
  return createElement(NativeFullScreenCover, { ...props, onIsPresentedChange: (event: { nativeEvent: { isPresented: boolean } }) => onIsPresentedChange?.(event.nativeEvent.isPresented) });
}

const NativeFilterTextEditor = piece<SettingsPieceProps & { text: string; onTextChange: (event: { nativeEvent: { text: string } }) => void }>("FilterTextEditorView");

export function FilterTextEditor({ onTextChange, ...props }: SettingsPieceProps & { text: string; onTextChange: (text: string) => void }) {
  return createElement(NativeFilterTextEditor, { ...props, onTextChange: (event: { nativeEvent: { text: string } }) => onTextChange(event.nativeEvent.text) });
}

type SpaceFunctions = {
  spaceMenuSymbol(name: string, icon: string | null): string;
  spaceSymbol(icon: string | null): string | null;
  spaceColor(name: string | null): { light: string; dark: string } | null;
};

const spaceFunctions = () => requireOptionalNativeModule<SpaceFunctions>(SETTINGS_UI_MODULE);

export const spaceMenuSymbol = (name: string, icon?: string | null): string | null => spaceFunctions()?.spaceMenuSymbol(name, icon ?? null) ?? null;

export const spaceSymbol = (icon?: string | null): string | null => spaceFunctions()?.spaceSymbol(icon ?? null) ?? null;

export const spaceColor = (name?: string | null): { light: string; dark: string } | null => spaceFunctions()?.spaceColor(name ?? null) ?? null;

const ardia = (name: string, params: Record<string, unknown> = {}): ModifierConfig | null => (settingsUIAvailable() ? modifierHelpers().createModifier(`ardia.${name}`, params) : null);

export const spaceBackdrop = (look: SpaceLook & { animated?: boolean }) =>
  ardia("spaceBackdrop", { color: look.color ?? null, icon: look.icon ?? null, themeColors: look.themeColors ?? [], themeDarkColors: look.themeDarkColors ?? null, animated: look.animated ?? true });

export const settingsChrome = () => ardia("settingsChrome");

export const settingsPage = (title: string) => ardia("settingsPage", { title });

export const chromeSurface = (params: { shape: "circle" | "capsule" | "rounded"; cornerRadius?: number; interactive?: boolean; tinted?: boolean }) => ardia("chromeSurface", params);

export const settingsSwitchStyle = () => ardia("settingsSwitchStyle");

export const pressableStyle = () => ardia("pressableStyle");

export const legibleInk = (tint: SettingsTintName | "formAccent") => ardia("legibleInk", { tint });

export const profileLook = (look: LookColors & { usesGlass?: boolean }) =>
  ardia("profileLook", { color: look.color ?? null, themeColors: look.themeColors ?? [], darkThemeColors: look.darkThemeColors ?? null, usesGlass: look.usesGlass ?? true });

export const navigationBarBackButtonHidden = (hidden: boolean) => ardia("navigationBarBackButtonHidden", { hidden });

export const minListRowHeight = (height: number) => ardia("minListRowHeight", { height });

export const contentMargins = (params: { edges: "top" | "bottom" | "all"; length: number }) => ardia("contentMargins", params);

export const modifierList = (...items: (ModifierConfig | null | undefined | false)[]): ModifierConfig[] => items.filter((item): item is ModifierConfig => !!item);

export const accessibilityFocusRequest = (request: number) => ardia("accessibilityFocusRequest", { request });

export const onWidthChange = (handler: (width: number) => void): ModifierConfig | null => {
  const modifier = ardia("widthChange");
  return modifier && { ...modifier, eventListener: (args: unknown) => handler((args as { width: number }).width) };
};
