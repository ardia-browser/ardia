export type EditAction = "undo" | "redo" | "cut" | "copy" | "paste" | "pasteAndMatchStyle" | "selectAll";
export type EditItem = { id: string; action: EditAction; title: string; key: string; modifiers: readonly ("command" | "shift")[] };
export type EditField = Pick<HTMLInputElement, "focus" | "isConnected" | "selectionStart" | "selectionEnd" | "type" | "value" | "readOnly" | "disabled">;
export type EditTarget = { kind: "page" } | { kind: "field"; field: EditField } | null;
export type EditMenu = { disabled: ReadonlySet<string> };

export const EDIT_ITEMS: readonly EditItem[] = [
  { id: "std:undo:", action: "undo", title: "Undo", key: "z", modifiers: ["command"] },
  { id: "std:redo:", action: "redo", title: "Redo", key: "z", modifiers: ["command", "shift"] },
  { id: "std:cut:", action: "cut", title: "Cut", key: "x", modifiers: ["command"] },
  { id: "std:copy:", action: "copy", title: "Copy", key: "c", modifiers: ["command"] },
  { id: "std:paste:", action: "paste", title: "Paste", key: "v", modifiers: ["command"] },
  { id: "std:pasteAndMatchStyle:", action: "pasteAndMatchStyle", title: "Paste and Match Style", key: "v", modifiers: ["command", "shift"] },
  { id: "std:selectAll:", action: "selectAll", title: "Select All", key: "a", modifiers: ["command"] },
];

const byId = new Map(EDIT_ITEMS.map((item) => [item.id, item]));
export const editItem = (id: string) => byId.get(id);
export const editActionOf = (id: string): EditAction | undefined => byId.get(id)?.action;

const TEXT_FIELD = "textarea, input:not([type]), input[type=text], input[type=search], input[type=url], input[type=email], input[type=password], input[type=tel], input[type=number]";
const MENU_SURFACE = "[data-ardia-app-menu], .ardia-menu";

type Matching = Pick<Element, "matches" | "closest">;

export function createEditTargets() {
  let field: EditField | null = null;
  return {
    pageFocused: () => void (field = null),
    focusIn(element: (Matching & Partial<EditField>) | null) {
      if (element?.closest(MENU_SURFACE)) return;
      field = element?.matches(TEXT_FIELD) ? element as unknown as EditField : null;
    },
    current: (): NonNullable<EditTarget> => (field?.isConnected ? { kind: "field", field } : { kind: "page" }),
  };
}

const selected = (field: EditField) => {
  try {
    return field.selectionStart !== null && field.selectionEnd !== null && field.selectionEnd > field.selectionStart;
  } catch {
    return false;
  }
};

export function editMenu(target: EditTarget, pageEdits: boolean): EditMenu | null {
  if (!target) return null;
  if (target.kind === "page") return pageEdits ? { disabled: new Set() } : null;
  const { field } = target;
  if (field.disabled) return null;
  const disabled = new Set<string>();
  const off = (...actions: EditAction[]) => { for (const item of EDIT_ITEMS) if (actions.includes(item.action)) disabled.add(item.id); };
  if (!selected(field) || field.type === "password") off("cut", "copy");
  if (field.readOnly) off("undo", "redo", "cut", "paste", "pasteAndMatchStyle");
  if (!field.value) off("selectAll");
  return { disabled };
}

export type FieldEditPort = {
  exec(command: string, value?: string): boolean;
  readClipboard(): Promise<string>;
};

export async function editField(field: EditField, action: EditAction, port: FieldEditPort): Promise<boolean> {
  if (!field.isConnected) return false;
  field.focus();
  if (action !== "paste" && action !== "pasteAndMatchStyle") return port.exec(action);
  if (port.exec("paste")) return true;
  const text = await port.readClipboard();
  if (!text || !field.isConnected) return false;
  field.focus();
  return port.exec("insertText", text);
}

export const documentEditPort = (): FieldEditPort => ({
  exec: (command, value) => {
    try {
      return document.execCommand(command, false, value);
    } catch {
      return false;
    }
  },
  readClipboard: () => navigator.clipboard.readText(),
});
