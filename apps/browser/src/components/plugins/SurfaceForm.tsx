import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { PluginNode } from "../../lib/pluginProtocol";
import { ActivitySpinner, Box, Button, PopUp, Text, TextField, Toggle } from "../ui";
import { ActionButtons } from "./SurfaceActions";
import { Children, SurfaceScroll } from "./SurfaceBasics";
import { SURFACE } from "./tokens";
import { bool, isHandlerRef, records, str, useSurface } from "./surfaceNodes";
import { ShortcutScopeContext, useDeeperShortcutScope, useSurfaceKeys } from "./surfaceShortcuts";
import { controlledValueOf, fieldNodes, formValues, initialOf, optionValue, shownSelectValue, type FormValue } from "./surfaceFormValues";
import { t } from "../../lib/uiLanguage";


type FormState = { values: Record<string, FormValue>; set: (id: string, value: FormValue) => void; submit: () => void } | null;

const FormContext = createContext<FormState>(null);

export function FormNode({ node }: { node: PluginNode }) {
  const { fire } = useSurface();
  const p = node.props;
  const fields = useMemo(() => fieldNodes(node), [node]);
  const [edits, setEdits] = useState<Record<string, FormValue>>({});
  const values = useMemo(() => formValues(fields, edits), [fields, edits]);
  const loading = bool(p.isLoading);
  const latest = useRef({ values, loading, onSubmit: p.onSubmit });
  latest.current = { values, loading, onSubmit: p.onSubmit };
  const submit = () => {
    const now = latest.current;
    if (now.loading || !isHandlerRef(now.onSubmit)) return;
    fire(now.onSubmit, [now.values]);
  };
  const state = useMemo<FormState>(() => ({ values, set: (id, value) => setEdits((e) => ({ ...e, [id]: value })), submit }), [values]);
  const deeper = useDeeperShortcutScope();
  return (
    <FormContext.Provider value={state}>
      <SurfaceScroll>
        <Box gap="l" pad="m">
          <ShortcutScopeContext.Provider value={deeper}>
            <Children node={node} />
          </ShortcutScopeContext.Provider>
          <Box row gap="s" style={FOOTER}>
            {loading ? <ActivitySpinner style={SPINNER} /> : null}
            <ActionButtons panel={p.actions} primaryFirst={false} />
            {isHandlerRef(p.onSubmit) ? <Button title={str(p.submitTitle) ?? t(`Submit`)} kind="primary" disabled={loading} onPress={submit} /> : null}
          </Box>
        </Box>
      </SurfaceScroll>
    </FormContext.Provider>
  );
}

function useField(node: PluginNode) {
  const form = useContext(FormContext);
  const { fire } = useSurface();
  const id = str(node.props.id) ?? "";
  const [own, setOwn] = useState<FormValue>(() => initialOf(node));
  const [typed, setTyped] = useState<{ value: FormValue; node: PluginNode } | null>(null);
  const controlled = controlledValueOf(node);
  const pending = typed && typed.node === node ? typed.value : undefined;
  const value = controlled !== undefined ? (pending ?? controlled) : form && id ? (form.values[id] ?? initialOf(node)) : own;
  const set = (next: FormValue) => {
    if (controlled !== undefined) setTyped({ value: next, node });
    else if (form && id) form.set(id, next);
    else setOwn(next);
    if (isHandlerRef(node.props.onChange)) fire(node.props.onChange, [next]);
  };
  return { value, set, submit: form?.submit };
}

function FieldFrame({ node, children }: { node: PluginNode; children: ReactNode }) {
  const title = str(node.props.title);
  const info = str(node.props.info);
  const error = str(node.props.error);
  return (
    <Box gap="xs">
      {title ? <Text size="small" weight="medium" tone="textSecondary">{title}</Text> : null}
      {children}
      {error ? <Text size="caption" tone="destructive">{error}</Text> : info ? <Text size="caption" tone="textTertiary">{info}</Text> : null}
    </Box>
  );
}

export function TextFieldNode({ node }: { node: PluginNode }) {
  const { value, set, submit } = useField(node);
  const keys = useSurfaceKeys();
  const disabled = bool(node.props.disabled);
  return (
    <FieldFrame node={node}>
      <TextField
        value={typeof value === "string" ? value : ""}
        onChangeText={(text) => !disabled && set(text)}
        placeholder={str(node.props.placeholder)}
        autoFocus={bool(node.props.autoFocus)}
        secure={node.type === "PasswordField"}
        multiline={node.type === "TextField" && bool(node.props.multiline)}
        invalid={!!str(node.props.error)}
        disabled={disabled}
        onSubmit={disabled ? undefined : submit}
        extraKeys={keys.keys}
        onExtraKey={keys.press}
      />
    </FieldFrame>
  );
}

export function ToggleNode({ node }: { node: PluginNode }) {
  const { value, set } = useField(node);
  const label = str(node.props.label) ?? str(node.props.title) ?? "";
  return (
    <Box row gap="m" style={TOGGLE_ROW}>
      <Box gap="xxs" style={FLEX}>
        <Text>{label}</Text>
        {str(node.props.info) ? <Text size="caption" tone="textTertiary">{str(node.props.info)}</Text> : null}
      </Box>
      <Toggle value={value === true} disabled={bool(node.props.disabled)} accessibilityLabel={label} onChange={set} />
    </Box>
  );
}

export function SelectNode({ node }: { node: PluginNode }) {
  const { value, set } = useField(node);
  const options = records(node.props.options).flatMap((o) => {
    const v = optionValue(o.value);
    return v === undefined ? [] : [{ value: v, title: str(o.title) ?? v }];
  });
  if (!options.length) return null;
  return (
    <FieldFrame node={node}>
      <PopUp value={shownSelectValue(node, value)} options={options} disabled={bool(node.props.disabled)} accessibilityLabel={str(node.props.title)} onChange={set} />
    </FieldFrame>
  );
}

const FLEX = { flex: 1 } as const;
const FOOTER = { justifyContent: "flex-end", alignItems: "center" } as const;
const TOGGLE_ROW = { alignItems: "center" } as const;
const SPINNER = { width: SURFACE.spinner, height: SURFACE.spinner } as const;
