import { materialColors } from "@ardia/phone-native";
import { create } from "zustand";
import { readableSchemePair, unreadableInks } from "../../lib/material/schemePick";
import type { MaterialSchemePair } from "../../lib/material/schemes";

export const useDynamicScheme = create<{ pair: MaterialSchemePair | null; inksFixed: number }>()(() => ({ pair: null, inksFixed: 0 }));

export const setDynamicScheme = (given: MaterialSchemePair | null) =>
  useDynamicScheme.setState({ pair: readableSchemePair(given), inksFixed: given ? unreadableInks(given.light).length + unreadableInks(given.dark).length : 0 });

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
