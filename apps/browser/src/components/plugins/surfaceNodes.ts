import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, ScrollView } from "react-native";
import { isPluginPath } from "../../lib/pluginChecks";
import type { PluginNode } from "../../lib/pluginProtocol";
import type { ColorRole, Space, TypeSize } from "../ui";

type HandlerRef = { __handler: string };
export type Child = PluginNode | string;

export const isHandlerRef = (value: unknown): value is HandlerRef =>
  typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { __handler?: unknown }).__handler === "string";

export const isNode = (value: unknown): value is PluginNode =>
  typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { type?: unknown }).type === "string" && Array.isArray((value as { children?: unknown }).children);

export const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : undefined);
export const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
export const bool = (value: unknown): boolean => value === true;
export const strings = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap((v) => str(v) ?? []) : []);
export const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)) : [];

export function textOf(children: readonly Child[]): string {
  return children.map((c) => (typeof c === "string" ? c : textOf(c.children))).join("");
}

export const nodeKey = (child: Child, index: number) => (typeof child === "string" ? `t${index}` : child.key !== undefined ? `k${String(child.key)}` : `${child.type}${index}`);

const SPACES: readonly Space[] = ["none", "xxs", "xs", "s", "m", "l", "xl"];
export const spaceOf = (value: unknown): Space | undefined => (SPACES as readonly unknown[]).includes(value) ? (value as Space) : undefined;

const SIZES: Record<string, TypeSize> = { caption: "caption", small: "small", body: "body", heading: "title", title: "large" };
export const sizeOf = (value: unknown): TypeSize => SIZES[str(value) ?? ""] ?? "body";

const TEXT_TONES: Record<string, ColorRole> = {
  default: "textPrimary",
  neutral: "textPrimary",
  secondary: "textSecondary",
  tertiary: "textTertiary",
  accent: "accent",
  success: "success",
  warning: "warning",
  destructive: "destructive",
  danger: "destructive",
};
export const toneOf = (value: unknown, fallback: ColorRole = "textPrimary"): ColorRole => TEXT_TONES[str(value) ?? ""] ?? fallback;

const FILL_TONES: Record<string, ColorRole> = { accent: "accent", success: "success", warning: "warning", destructive: "destructive", danger: "destructive" };
export const fillToneOf = (value: unknown): ColorRole | null => FILL_TONES[str(value) ?? ""] ?? null;

export function flattenNodes(children: readonly Child[], keep: (node: PluginNode) => boolean): PluginNode[] {
  const out: PluginNode[] = [];
  for (const child of children) {
    if (typeof child === "string") continue;
    if (keep(child)) out.push(child);
    else if (child.type === "Fragment" || child.type === "ActionPanel" || child.type === "ActionPanelSection") out.push(...flattenNodes(child.children, keep));
  }
  return out;
}

export const actionsIn = (panel: unknown): PluginNode[] => (isNode(panel) ? (panel.type === "Action" ? [panel] : flattenNodes(panel.children, (n) => n.type === "Action")) : []);

export type SurfaceFireOptions = { gesture?: boolean };

export type SurfaceDispatch = {
  plugin: string;
  surfaceId: string;
  windowId: string;
  kind: string;
  fire: (ref: unknown, args?: unknown[], options?: SurfaceFireOptions) => boolean;
  render: (child: Child, index: number) => ReactNode;
};

export const SurfaceContext = createContext<SurfaceDispatch>({ plugin: "", surfaceId: "", windowId: "", kind: "", fire: () => false, render: () => null });
export const useSurface = () => useContext(SurfaceContext);

export function fuzzyScore(query: string, haystack: readonly (string | undefined)[]): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  let best = 0;
  for (const raw of haystack) {
    if (!raw) continue;
    const text = raw.toLowerCase();
    const at = text.indexOf(q);
    if (at === 0) best = Math.max(best, 100);
    else if (at > 0) best = Math.max(best, 80 - Math.min(at, 40));
    else {
      let qi = 0;
      for (let i = 0; i < text.length && qi < q.length; i++) if (text[i] === q[qi]) qi++;
      if (qi === q.length) best = Math.max(best, 20);
    }
  }
  return best;
}

export function fuzzyFilter<T>(items: readonly T[], query: string, fields: (item: T) => readonly (string | undefined)[]): T[] {
  if (!query.trim()) return [...items];
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(query, fields(item)) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.item);
}

export function pluginFileUrl(plugin: string, file: string | undefined): string | null {
  if (!file || !isPluginPath(file)) return null;
  return `ardia-plugin://${plugin}/${file.split("/").map(encodeURIComponent).join("/")}`;
}

export const isWebUrl = (url: unknown): url is string => typeof url === "string" && /^https?:\/\//i.test(url) && url.length <= 4096;

type RowFrame = { y: number; height: number };

export function useRevealRow(revealKey: string | null) {
  const ref = useRef<ScrollView>(null);
  const viewport = useRef({ y: 0, height: 0 });
  const rows = useRef(new Map<string, RowFrame>());
  useEffect(() => {
    if (revealKey === null) return;
    const row = rows.current.get(revealKey);
    const view = viewport.current;
    if (!row || !view.height) return;
    const target = row.y < view.y ? row.y : row.y + row.height > view.y + view.height ? row.y + row.height - view.height : null;
    if (target === null) return;
    view.y = target;
    ref.current?.scrollTo({ y: target, animated: false });
  }, [revealKey]);
  const scrollProps = {
    ref,
    scrollEventThrottle: 16,
    onLayout: (e: LayoutChangeEvent) => {
      viewport.current.height = e.nativeEvent.layout.height;
    },
    onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      viewport.current.y = e.nativeEvent.contentOffset.y;
    },
  };
  const rowLayout = (key: string) => (e: LayoutChangeEvent) => {
    const { y, height } = e.nativeEvent.layout;
    rows.current.set(key, { y, height });
  };
  return { scrollProps, rowLayout };
}
