import { requireNativeViewManager, requireOptionalNativeModule } from "expo-modules-core";
import { createElement, type ComponentType, type ReactNode, type Ref } from "react";
import { View, type NativeSyntheticEvent, type ViewProps } from "react-native";
import type { LookColors } from "./look";

export type MenuItem = {
  id: string;
  title: string;
  subtitle?: string;
  systemImage?: string;
  destructive?: boolean;
  disabled?: boolean;
  checked?: boolean;
  inline?: boolean;
  children?: MenuItem[];
};

export type MenuAppearance = LookColors & { dark?: boolean };

export type ContextMenuHandle = { show(pressX?: number, pressY?: number): Promise<void> };

export type ContextMenuProps = ViewProps & {
  ref?: Ref<ContextMenuHandle>;
  items: MenuItem[];
  onSelect: (id: string) => void;
  trigger?: "longPress" | "tap";
  fixedOrder?: boolean;
  onOpen?: () => void;
  onClose?: () => void;
  appearance?: MenuAppearance;
  children?: ReactNode;
};

export type ActionSheetAction = { id: string; title: string; destructive?: boolean; cancel?: boolean };

export type ActionSheetOptions = { title?: string; message?: string; actions: ActionSheetAction[]; appearance?: MenuAppearance };

type NativeMenus = {
  hasContextMenu?: boolean;
  hasActionSheet?: boolean;
  actionSheet?(options: ActionSheetOptions): Promise<string | null>;
};

type NativeProps = Omit<ContextMenuProps, "onSelect" | "onOpen" | "onClose"> & {
  onSelect: (event: NativeSyntheticEvent<{ id: string }>) => void;
  onOpen?: () => void;
  onClose?: () => void;
};

const native = requireOptionalNativeModule<NativeMenus>("ArdiaPhoneMenus");

let nativeView: ComponentType<NativeProps> | undefined;
const view = () => (nativeView ??= requireNativeViewManager<NativeProps>("ArdiaPhoneMenus"));

export const nativeMenusAvailable = (): { contextMenu: boolean; actionSheet: boolean } => ({
  contextMenu: native?.hasContextMenu === true,
  actionSheet: native?.hasActionSheet === true && typeof native.actionSheet === "function",
});

export function ContextMenuView({ ref, onSelect, onOpen, onClose, trigger = "longPress", ...rest }: ContextMenuProps) {
  if (!nativeMenusAvailable().contextMenu) return createElement(View, rest);
  return createElement(view(), {
    ...rest,
    ref,
    trigger,
    onSelect: (event: NativeSyntheticEvent<{ id: string }>) => onSelect(event.nativeEvent.id),
    onOpen: onOpen ? () => onOpen() : undefined,
    onClose: onClose ? () => onClose() : undefined,
  });
}

export async function actionSheet(options: ActionSheetOptions): Promise<string | null> {
  if (!nativeMenusAvailable().actionSheet) return null;
  return (await native!.actionSheet!(options)) ?? null;
}
