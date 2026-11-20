import { materialColors } from "@ardia/phone-native";
import { create } from "zustand";
import type { MaterialSchemePair } from "../../lib/material/schemes";

export const useDynamicScheme = create<{ pair: MaterialSchemePair | null }>()(() => ({ pair: null }));

export const setDynamicScheme = (pair: MaterialSchemePair | null) => useDynamicScheme.setState({ pair });

const readDynamicScheme = (): MaterialSchemePair | null => {
  try {
    return materialColors.schemes();
  } catch {
    return null;
  }
};

let following: { remove: () => void } | null = null;

export function followDynamicScheme() {
  if (following) return;
  setDynamicScheme(readDynamicScheme());
  following = materialColors.onChange(() => setDynamicScheme(readDynamicScheme()));
}
