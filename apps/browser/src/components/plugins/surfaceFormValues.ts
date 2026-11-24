import type { PluginNode } from "../../lib/pluginProtocol";
import { records, str } from "./surfaceNodes";

export type FormValue = string | boolean;

const FIELD_TYPES = new Set(["TextField", "PasswordField", "Toggle", "Select"]);

export function fieldNodes(node: PluginNode, out: PluginNode[] = []): PluginNode[] {
  for (const child of node.children) {
    if (typeof child === "string") continue;
    if (FIELD_TYPES.has(child.type)) out.push(child);
    else fieldNodes(child, out);
  }
  return out;
}

export const optionValue = (value: unknown): string | undefined => (typeof value === "string" ? value : str(value));

const selectValues = (field: PluginNode): string[] => records(field.props.options).flatMap((o) => optionValue(o.value) ?? []);

export const shownSelectValue = (field: PluginNode, value: FormValue): string => {
  const allowed = selectValues(field);
  return typeof value === "string" && allowed.includes(value) ? value : (allowed[0] ?? "");
};

export const initialOf = (field: PluginNode): FormValue => {
  const { value, defaultValue } = field.props;
  if (field.type === "Toggle") return typeof value === "boolean" ? value : defaultValue === true;
  if (typeof value === "string") return value;
  if (typeof defaultValue === "string") return defaultValue;
  if (field.type === "Select") return selectValues(field)[0] ?? "";
  return "";
};

export const controlledValueOf = (field: PluginNode): FormValue | undefined => {
  const { value } = field.props;
  if (field.type === "Toggle") return typeof value === "boolean" ? value : undefined;
  return typeof value === "string" ? value : undefined;
};

export function formValues(fields: readonly PluginNode[], edits: Readonly<Record<string, FormValue>>): Record<string, FormValue> {
  const out: Record<string, FormValue> = {};
  for (const field of fields) {
    const id = str(field.props.id);
    if (!id) continue;
    const value = controlledValueOf(field) ?? (Object.hasOwn(edits, id) ? edits[id]! : initialOf(field));
    out[id] = field.type === "Select" ? shownSelectValue(field, value) : value;
  }
  return out;
}
