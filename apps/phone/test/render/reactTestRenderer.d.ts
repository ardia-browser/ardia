declare module "react-test-renderer" {
  import type { ReactElement } from "react";

  export type ReactTestInstance = {
    type: unknown;
    props: Record<string, any>;
    parent: ReactTestInstance | null;
    children: (ReactTestInstance | string)[];
    findAll(predicate: (node: ReactTestInstance) => boolean): ReactTestInstance[];
  };

  export type ReactTestRenderer = {
    root: ReactTestInstance;
    toJSON(): unknown;
    update(element: ReactElement): void;
    unmount(): void;
  };

  export function create(element: ReactElement): ReactTestRenderer;
  export function act(work: () => void): void;
  export function act(work: () => Promise<void>): Promise<void>;
}
