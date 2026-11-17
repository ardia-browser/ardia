import { create } from "zustand";

export type RootSize = { width: number; height: number };

export const useRootSize = create<RootSize>()(() => ({ width: 0, height: 0 }));

export function setRootSize(width: number, height: number) {
  const now = useRootSize.getState();
  if (now.width !== width || now.height !== height) useRootSize.setState({ width, height });
}

export const measuredOr = (root: RootSize, fallback: RootSize): RootSize => (root.width > 0 && root.height > 0 ? root : fallback);
