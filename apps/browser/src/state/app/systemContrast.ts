import { AccessibilityInfo } from "react-native";
import { create } from "zustand";

export const useSystemIncreaseContrast = create<{ on: boolean }>()(() => ({ on: false }));

const setIncreaseContrast = (on: boolean) => {
  if (useSystemIncreaseContrast.getState().on !== on) useSystemIncreaseContrast.setState({ on });
};

let watching = false;

export function watchSystemContrast() {
  if (watching) return;
  watching = true;
  AccessibilityInfo.isHighContrastEnabled().then(setIncreaseContrast, () => setIncreaseContrast(false));
  AccessibilityInfo.addEventListener("highContrastChanged", setIncreaseContrast);
}

export const systemIncreaseContrast = () => useSystemIncreaseContrast.getState().on;
