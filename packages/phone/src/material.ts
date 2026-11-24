import { requireOptionalNativeModule } from "expo-modules-core";

type Subscription = { remove(): void };

export const MATERIAL_ROLES = [
  "primary",
  "onPrimary",
  "primaryContainer",
  "onPrimaryContainer",
  "inversePrimary",
  "secondary",
  "onSecondary",
  "secondaryContainer",
  "onSecondaryContainer",
  "tertiary",
  "onTertiary",
  "tertiaryContainer",
  "onTertiaryContainer",
  "background",
  "onBackground",
  "surface",
  "onSurface",
  "surfaceVariant",
  "onSurfaceVariant",
  "surfaceTint",
  "surfaceBright",
  "surfaceDim",
  "surfaceContainer",
  "surfaceContainerHigh",
  "surfaceContainerHighest",
  "surfaceContainerLow",
  "surfaceContainerLowest",
  "inverseSurface",
  "inverseOnSurface",
  "error",
  "onError",
  "errorContainer",
  "onErrorContainer",
  "outline",
  "outlineVariant",
  "scrim",
] as const;

export type MaterialRole = (typeof MATERIAL_ROLES)[number];

export type NativeMaterialScheme = Readonly<Record<MaterialRole, string>>;

export type NativeMaterialSchemes = { light: NativeMaterialScheme; dark: NativeMaterialScheme };

export type MaterialSchemeChange = { reason: "wallpaper" | "night" };

type MaterialNative = {
  dynamic?: boolean;
  schemes(): NativeMaterialSchemes | null;
  addListener(event: "onSchemeChange", listener: (event: MaterialSchemeChange) => void): Subscription;
};

const native = requireOptionalNativeModule<MaterialNative>("ArdiaPhoneMaterial");

export const materialColors = {
  isDynamic: (): boolean => native?.dynamic === true,
  schemes: (): NativeMaterialSchemes | null => native?.schemes() ?? null,
  onChange: (listener: (change: MaterialSchemeChange) => void): Subscription => native?.addListener("onSchemeChange", listener) ?? { remove() {} },
};
