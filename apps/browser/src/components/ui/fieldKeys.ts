import { useMemo } from "react";

export type ExtraKey = { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean };

export type ExtraKeyProps = { extraKeys?: readonly ExtraKey[]; onExtraKey?: (pressed: ExtraKey) => boolean };

export function useKeyDownEvents(base: readonly ExtraKey[] | undefined, extra: readonly ExtraKey[] | undefined): ExtraKey[] | undefined {
  return useMemo(() => (extra?.length ? [...(base ?? []), ...extra] : base ? [...base] : undefined), [base, extra]);
}

export type TextFieldKeyHandlers = {
  onEscape?: () => void;
  onArrow?: (direction: "up" | "down") => void;
  onTab?: () => void;
  onFieldTab?: (back: boolean) => void;
};

const ESCAPE_KEY = [{ key: "Escape" }];
const COMPLETION_KEYS = [{ key: "Escape" }, { key: "ArrowUp" }, { key: "ArrowDown" }];
const COMPLETION_KEYS_WITH_TAB = [...COMPLETION_KEYS, { key: "Tab" }];
const FORM_KEYS = [{ key: "Escape" }, { key: "Tab" }, { key: "Tab", shiftKey: true }];

export const textFieldKeys = ({ onEscape, onArrow, onTab, onFieldTab }: TextFieldKeyHandlers): readonly ExtraKey[] | undefined =>
  onFieldTab ? FORM_KEYS : onTab ? COMPLETION_KEYS_WITH_TAB : onArrow ? COMPLETION_KEYS : onEscape ? ESCAPE_KEY : undefined;

export function runTextFieldKey(pressed: ExtraKey, { onEscape, onArrow, onTab, onFieldTab }: TextFieldKeyHandlers): boolean {
  if (pressed.key === "Escape") onEscape?.();
  else if (pressed.key === "ArrowUp" || pressed.key === "ArrowDown") onArrow?.(pressed.key === "ArrowUp" ? "up" : "down");
  else if (pressed.key === "Tab" && onFieldTab) onFieldTab(!!pressed.shiftKey);
  else if (pressed.key === "Tab") onTab?.();
  else return false;
  return true;
}

const SEARCH_KEYS = [{ key: "Escape" }];
const SEARCH_KEYS_WITH_ENTER = [{ key: "Escape" }, { key: "Enter" }, { key: "Enter", shiftKey: true }];
const SEARCH_KEYS_WITH_ARROWS = [...SEARCH_KEYS_WITH_ENTER, { key: "ArrowUp" }, { key: "ArrowDown" }];

export const searchFieldKeys = (arrows: boolean, enter: boolean): readonly ExtraKey[] => (arrows ? SEARCH_KEYS_WITH_ARROWS : enter ? SEARCH_KEYS_WITH_ENTER : SEARCH_KEYS);
