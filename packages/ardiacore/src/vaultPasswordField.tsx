import { requireNativeModule, requireNativeViewManager } from "expo-modules-core";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";

export type VaultPasswordFieldProps = ViewProps & {
  draft?: string;
  entry?: string;
  revealed?: boolean;
  placeholder?: string;
  bordered?: boolean;
  label?: string;
  autoFocus?: boolean;
  tabs?: boolean;
  onEdit?: (length: number) => void;
  onSubmit?: () => void;
  onEscape?: () => void;
  onTab?: (back: boolean) => void;
  onFocusChange?: (focused: boolean) => void;
};

export type VaultPasswordFieldHandle = { focus: () => void };

type NativeProps = Omit<VaultPasswordFieldProps, "onEdit" | "onSubmit" | "onEscape" | "onTab" | "onFocusChange"> & {
  onFocusChange?: (e: NativeSyntheticEvent<{ focused: boolean }>) => void;
  onEdit?: (e: NativeSyntheticEvent<{ length: number }>) => void;
  onSubmit?: () => void;
  onEscape?: () => void;
  onTab?: (e: NativeSyntheticEvent<{ back: boolean }>) => void;
};

type NativeHandle = { focus?: () => Promise<void> };

type NativeView = React.ComponentType<NativeProps & { ref?: React.Ref<NativeHandle> }>;
let Native: NativeView | undefined;
const native = (): NativeView => (Native ??= requireNativeViewManager<NativeProps>("ArdiaVaultPasswordField") as unknown as NativeView);

let entries = 0;
export const newSecretEntry = () => `entry-${Date.now().toString(36)}-${(entries += 1)}-${Math.random().toString(36).slice(2, 10)}`;

let FieldModule: { dropEntry?: (token: string) => void } | undefined;
export const dropSecretEntry = (token: string) => {
  FieldModule ??= requireNativeModule<{ dropEntry?: (token: string) => void }>("ArdiaVaultPasswordField");
  FieldModule.dropEntry?.(token);
};

export function useSecretEntry() {
  const [token] = useState(newSecretEntry);
  useEffect(() => () => dropSecretEntry(token), [token]);
  return token;
}

export function useSecretEntries() {
  const [held] = useState(() => new Map<string, string>());
  useEffect(() => () => held.forEach(dropSecretEntry), [held]);
  return useMemo(
    () => ({
      entryFor(id: string) {
        const known = held.get(id);
        if (known) return known;
        const fresh = newSecretEntry();
        held.set(id, fresh);
        return fresh;
      },
      dropAll() {
        held.forEach(dropSecretEntry);
        held.clear();
      },
    }),
    [held],
  );
}

export const VaultPasswordField = forwardRef<VaultPasswordFieldHandle, VaultPasswordFieldProps>(function VaultPasswordField({ onEdit, onTab, onFocusChange, ...props }, ref) {
  const View = native();
  const view = useRef<NativeHandle>(null);
  useImperativeHandle(ref, () => ({ focus: () => void view.current?.focus?.() }), []);
  return <View {...props} ref={view} onEdit={onEdit ? (e) => onEdit(e.nativeEvent.length) : undefined} onTab={onTab ? (e) => onTab(e.nativeEvent.back) : undefined} onFocusChange={onFocusChange ? (e) => onFocusChange(e.nativeEvent.focused) : undefined} />;
});
