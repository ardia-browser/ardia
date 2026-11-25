import type { Key, Renderable, VNode } from "./element";

export { Fragment, jsx, jsxDEV, jsxs } from "./element";

export declare namespace JSX {
  type Element = VNode;
  type ElementType = ((props: never) => Renderable) | string;
  interface ElementChildrenAttribute {
    children: {};
  }
  interface IntrinsicAttributes {
    key?: Key | null;
  }
  interface IntrinsicElements {}
}
