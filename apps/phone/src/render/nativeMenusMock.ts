import { createElement, useImperativeHandle, type ReactNode, type Ref } from "react";
import { t } from "../lib/uiLanguage";


export type SheetAnswer = string | null;

export const mockNative = { contextMenu: false, actionSheet: false, answer: null as SheetAnswer, sheets: [] as unknown[], shown: 0, shownAt: [] as (number | undefined)[][] };

export function resetNativeMenus(available = false) {
  mockNative.contextMenu = available;
  mockNative.actionSheet = available;
  mockNative.answer = null;
  mockNative.sheets.length = 0;
  mockNative.shown = 0;
  mockNative.shownAt.length = 0;
}

export function nativeMenusModule(actual: { settingsUI: object }) {
  return {
    ...actual,
    nativeMenusAvailable: () => ({ contextMenu: mockNative.contextMenu, actionSheet: mockNative.actionSheet }),
    ContextMenuView: function ContextMenuView({ children, ref, ...props }: { children?: ReactNode; ref?: Ref<{ show(pressX?: number, pressY?: number): Promise<void> }> }) {
      useImperativeHandle(ref, () => ({ show: async (pressX?: number, pressY?: number) => void (mockNative.shown += 1, mockNative.shownAt.push([pressX, pressY])) }), []);
      return createElement(t(`ContextMenuView`), props, children);
    },
    actionSheet: (options: unknown) => {
      mockNative.sheets.push(options);
      return Promise.resolve(mockNative.answer);
    },
    settingsUI: { ...actual.settingsUI, spaceMenuSymbol: (name: string, icon: string | null) => icon ?? `${name.slice(0, 1).toLowerCase()}.square.fill` },
  };
}

export type NativeItem = { id: string; title: string; systemImage?: string; destructive?: boolean; disabled?: boolean; checked?: boolean; inline?: boolean; children?: NativeItem[] };

export const titles = (items: NativeItem[]): unknown[] => items.map((item) => (item.children ? { [item.title]: titles(item.children) } : item.title));

export function idOf(items: NativeItem[], title: string): string {
  for (const item of items) {
    if (item.title === title && !item.children) return item.id;
    if (item.children) {
      const found = idOf(item.children, title);
      if (found) return found;
    }
  }
  return "";
}

export function itemOf(items: NativeItem[], title: string): NativeItem | undefined {
  for (const item of items) {
    if (item.title === title) return item;
    const found = item.children ? itemOf(item.children, title) : undefined;
    if (found) return found;
  }
  return undefined;
}
