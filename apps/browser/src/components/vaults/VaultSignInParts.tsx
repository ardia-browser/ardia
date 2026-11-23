import { Fragment, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import type { VaultSignInResult } from "../../state/vaults/actions";
import { signInRequest, type SignInGoal, type SignInRequest } from "../../state/vaults/signInRequest";
import { Button, Dialog, Group, PopUp, radius, space, Text, useTheme, VaultPasswordField, type Option } from "../ui";
import { font as typeScale, lineHeight } from "../ui/tokens";
import { BrandBadge, useCopiedFlash } from "./VaultParts";
import { Morph, useLeaving } from "./VaultMorph";
import { FormRow, PlainField, ROW, ROW_LINE, SecretPlaceholder } from "./VaultFormFields";

export { FieldError } from "./VaultFormFields";
import { VAULT_BADGE, VAULT_SIGN_IN } from "./tokens";

export type FieldHandle = { focus: () => void };

function useRowHandle(handle: RefObject<FieldHandle | null>, focus: () => void) {
  const leaving = useLeaving();
  useEffect(() => {
    if (leaving) return;
    handle.current = { focus };
    return () => void (handle.current = null);
  }, [leaving, handle]);
  return leaving;
}

const SCOPE_KEYS = [{ key: "Escape" }, { key: "Enter" }];

export function useSignInRequest(provider: string, goal: SignInGoal, keepsWaiting = false) {
  const current = useRef<SignInRequest | null>(null);
  useEffect(() => {
    const request = signInRequest(provider, goal);
    current.current = request;
    return () => request.close();
  }, [provider, goal]);
  useEffect(() => current.current?.keepWaiting(keepsWaiting), [keepsWaiting, provider, goal]);
  return (request: () => Promise<VaultSignInResult>): Promise<VaultSignInResult | null> =>
    current.current ? current.current.run(request) : Promise.resolve(null);
}

export function useFocusChain(count: number) {
  const refs = useRef<RefObject<FieldHandle | null>[]>([]);
  while (refs.current.length < count) refs.current.push({ current: null });
  const at = (index: number) => refs.current[index]!;
  const move = (from: number, back: boolean) => {
    const live = refs.current.map((r, i) => (r.current ? i : -1)).filter((i) => i >= 0);
    if (!live.length) return;
    const position = live.indexOf(from);
    const next = live[(position + (back ? -1 : 1) + live.length) % live.length]!;
    refs.current[next]!.current?.focus();
  };
  return { at, move };
}

export function SignInSheet({
  provider,
  title,
  subtitle,
  step,
  onCancel,
  onSubmit,
  leading,
  primary,
  submitsFromSheet,
  slide,
  children,
}: {
  provider: string;
  title: string;
  subtitle?: string;
  step: string;
  slide?: -1 | 0 | 1;
  onCancel: () => void;
  onSubmit: () => void;
  leading?: ReactNode;
  primary: ReactNode;
  submitsFromSheet?: boolean;
  children: ReactNode;
}) {
  const scope = useRef<View>(null);
  useEffect(() => {
    if (submitsFromSheet) scope.current?.focus();
  }, [submitsFromSheet, step]);
  return (
    <Dialog width="m" maxHeight="90%" onDismiss={onCancel}>
      <View
        ref={scope}
        focusable={!!submitsFromSheet}
        enableFocusRing={false}
        keyDownEvents={SCOPE_KEYS}
        onKeyDown={(e) => {
          if (e.nativeEvent.key === "Escape") onCancel();
          else if (e.nativeEvent.key === "Enter" && submitsFromSheet) onSubmit();
        }}
      >
        <SheetHeader icon={<BrandBadge provider={provider} size="xl" />} title={title} subtitle={subtitle} />
        <Morph id={step} slide={slide}>{children}</Morph>
        <View style={ACTIONS}>
          <Fragment key={`${step}-leading`}>{leading}</Fragment>
          <View style={ACTIONS_GAP} />
          <Button title="Cancel" onPress={onCancel} />
          <Fragment key={`${step}-primary`}>{primary}</Fragment>
        </View>
      </View>
    </Dialog>
  );
}

export function SheetHeader({ icon, title, subtitle }: { icon: ReactNode; title: string; subtitle?: string }) {
  return (
    <View style={HEADER} accessibilityRole="header">
      {icon}
      <Text size="title" weight="semibold" lines={2} style={TITLE}>
        {title}
      </Text>
      {subtitle ? (
        <Text size="small" tone="textSecondary" lines={2} style={SUBTITLE}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

export function HeaderTile({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <View style={[HEADER_TILE, { backgroundColor: theme.groupFill, borderColor: theme.groupBorder }]}>{children}</View>;
}

export function Form({ children, gap = true }: { children: ReactNode; gap?: boolean }) {
  return (
    <View style={gap ? FORM_GAP : undefined}>
      <Group>{children}</Group>
    </View>
  );
}

export function TextRow({
  label,
  value,
  onChange,
  placeholder,
  autoFocus,
  mono,
  error,
  onSubmit,
  onCancel,
  handle,
  index,
  onTab,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  mono?: boolean;
  error?: string;
  onSubmit: () => void;
  onCancel: () => void;
  handle: RefObject<FieldHandle | null>;
  index: number;
  onTab: (from: number, back: boolean) => void;
}) {
  const input = useRef<TextInput>(null);
  const leaving = useRowHandle(handle, () => input.current?.focus());
  const [focused, setFocused] = useState(false);
  return (
    <FormRow label={label} error={error} focused={focused && !leaving}>
      <PlainField
        inputRef={input}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        label={label}
        mono={mono}
        autoFocus={autoFocus && !leaving}
        onSubmit={onSubmit}
        onEscape={onCancel}
        onTab={(back) => onTab(index, back)}
        onFocusChange={setFocused}
      />
    </FormRow>
  );
}

export function SecretRow({
  label,
  entry,
  onLength,
  autoFocus,
  placeholder = "Required",
  revealed,
  error,
  onSubmit,
  onCancel,
  handle,
  index,
  onTab,
}: {
  label: string;
  entry: string;
  placeholder?: string;
  revealed?: boolean;
  onLength: (length: number) => void;
  autoFocus?: boolean;
  error?: string;
  onSubmit: () => void;
  onCancel: () => void;
  handle: RefObject<FieldHandle | null>;
  index: number;
  onTab: (from: number, back: boolean) => void;
}) {
  const field = useRef<FieldHandle>(null);
  const leaving = useRowHandle(handle, () => field.current?.focus());
  const [focused, setFocused] = useState(false);
  const [empty, setEmpty] = useState(true);
  return (
    <FormRow label={label} error={error} focused={focused && !leaving}>
      {empty ? <SecretPlaceholder text={placeholder} /> : null}
      <VaultPasswordField
        ref={field}
        entry={entry}
        revealed={revealed}
        bordered={false}
        label={label}
        onFocusChange={setFocused}
        autoFocus={autoFocus && !leaving}
        onEdit={(length) => {
          setEmpty(length === 0);
          if (!leaving) onLength(length);
        }}
        onSubmit={onSubmit}
        onEscape={onCancel}
        onTab={(back) => onTab(index, back)}
        style={SECRET}
      />
    </FormRow>
  );
}

export function PopUpRow<T extends string>({ label, value, options, onChange, error }: { label: string; value: T; options: Option<T>[]; onChange: (value: T) => void; error?: string }) {
  return (
    <FormRow label={label} error={error}>
      <View style={POPUP}>
        <PopUp value={value} options={options} onChange={onChange} minWidth={VAULT_SIGN_IN.popUpMin} />
      </View>
    </FormRow>
  );
}

const COPY_TITLES = ["Copy", "Copied"] as const;

export function CommandRow({ command, onCopy }: { command: string; onCopy: () => void }) {
  const [copied, flash] = useCopiedFlash();
  return (
    <View style={[ROW, ROW_LINE]}>
      <Text selectable lines={1} style={COMMAND}>
        {command}
      </Text>
      <Button
        title={copied ? "Copied" : "Copy"}
        icon={copied ? "checkmark" : "doc.on.doc"}
        label={copied ? "Copied" : "Copy Command"}
        reserve={COPY_TITLES}
        onPress={() => {
          onCopy();
          flash();
        }}
      />
    </View>
  );
}

export function errorFor(field: string, error: { field: string | null; text: string }) {
  return error.field === field ? error.text : undefined;
}

const HEADER = { alignItems: "center", paddingTop: space.xs } as const;
const TITLE = { marginTop: space.ml, textAlign: "center" } as const;
const HEADER_TILE = { width: VAULT_BADGE.xl.box, height: VAULT_BADGE.xl.box, borderRadius: radius.panel, borderWidth: StyleSheet.hairlineWidth * 2, alignItems: "center", justifyContent: "center" } as const;
const SUBTITLE = { marginTop: space.xs, textAlign: "center", lineHeight: lineHeight.small, maxWidth: VAULT_SIGN_IN.subtitleWidth } as const;
const FORM_GAP = { marginTop: space.xl } as const;
const POPUP = { alignItems: "flex-end" } as const;
const SECRET = { height: VAULT_SIGN_IN.secretHeight, flex: 1 } as const;
const COMMAND = { flex: 1, fontFamily: "Menlo", ...typeScale.small } as const;
const ACTIONS = { flexDirection: "row", alignItems: "center", gap: space.m, marginTop: space.xl } as const;
const ACTIONS_GAP = { flex: 1 } as const;
