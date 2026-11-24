import type { PluginNodeType } from "./protocol";

export type Key = string | number;

export const ELEMENT = Symbol.for("ardia.plugin.element");

export type Renderable = VNode | string | number | bigint | boolean | null | undefined | readonly Renderable[];

export type Component<P = Record<string, unknown>> = (props: P) => Renderable;

export type HostComponent<P> = Component<P> & { readonly hostType: PluginNodeType };

export type VNode = {
  readonly $$typeof: typeof ELEMENT;
  readonly type: PluginNodeType | Component<never>;
  readonly key: Key | null;
  readonly props: Record<string, unknown>;
};

export type PropsWithChildren<P = unknown> = P & { children?: Renderable };

export type Context<T> = {
  readonly id: symbol;
  readonly defaultValue: T;
  readonly Provider: Component<{ value: T; children?: Renderable }> & { readonly providerOf: symbol };
  readonly Consumer: Component<{ children: (value: T) => Renderable }> & { readonly consumerOf: symbol };
  displayName?: string;
};

export function isVNode(value: unknown): value is VNode {
  return typeof value === "object" && value !== null && (value as { $$typeof?: unknown }).$$typeof === ELEMENT;
}

function element(type: VNode["type"], props: Record<string, unknown> | null | undefined, key: Key | null | undefined): VNode {
  const given = props ?? {};
  let ownKey: Key | null = key ?? null;
  let rest = given;
  if ("key" in given) {
    const { key: propKey, ...others } = given as { key?: Key };
    if (ownKey === null && propKey !== undefined && propKey !== null) ownKey = propKey;
    rest = others;
  }
  return { $$typeof: ELEMENT, type, key: ownKey, props: rest };
}

export function jsx(type: VNode["type"], props: Record<string, unknown> | null, key?: Key): VNode {
  return element(type, props, key);
}

export const jsxs = jsx;

export function jsxDEV(type: VNode["type"], props: Record<string, unknown> | null, key?: Key): VNode {
  return element(type, props, key);
}

export function createElement(type: VNode["type"], config?: Record<string, unknown> | null, ...children: Renderable[]): VNode {
  const props: Record<string, unknown> = { ...(config ?? {}) };
  if (children.length === 1) props.children = children[0];
  else if (children.length > 1) props.children = children;
  return element(type, props, undefined);
}

export function Fragment(props: { children?: Renderable }): Renderable {
  return props.children;
}

export function hostComponent<P>(type: PluginNodeType): HostComponent<P> {
  const render = (props: P) => element(type, props as Record<string, unknown>, undefined);
  return Object.assign(render, { hostType: type });
}

export function hostTypeOf(type: unknown): PluginNodeType | null {
  if (typeof type === "string") return type as PluginNodeType;
  const host = typeof type === "function" ? (type as { hostType?: unknown }).hostType : undefined;
  return typeof host === "string" ? (host as PluginNodeType) : null;
}

export function providerOf(type: unknown): symbol | null {
  const id = typeof type === "function" ? (type as { providerOf?: unknown }).providerOf : undefined;
  return typeof id === "symbol" ? id : null;
}

export function consumerOf(type: unknown): symbol | null {
  const id = typeof type === "function" ? (type as { consumerOf?: unknown }).consumerOf : undefined;
  return typeof id === "symbol" ? id : null;
}

export function createContext<T>(defaultValue: T): Context<T> {
  const id = Symbol("ardia.plugin.context");
  const Provider = Object.assign((props: { value: T; children?: Renderable }): Renderable => props.children, { providerOf: id });
  const Consumer = Object.assign((props: { children: (value: T) => Renderable }): Renderable => props.children(defaultValue), { consumerOf: id });
  return { id, defaultValue, Provider, Consumer };
}

export function isValidElement(value: unknown): value is VNode {
  return isVNode(value);
}

export function cloneElement(target: VNode, props?: Record<string, unknown>, ...children: Renderable[]): VNode {
  const merged: Record<string, unknown> = { ...target.props, ...(props ?? {}) };
  if (children.length === 1) merged.children = children[0];
  else if (children.length > 1) merged.children = children;
  return element(target.type, merged, (props?.key as Key | undefined) ?? target.key);
}
