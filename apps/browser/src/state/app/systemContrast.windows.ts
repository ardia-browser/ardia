import * as ReactNative from "react-native";
import { create } from "zustand";

type ContrastTheme = {
  isHighContrast: boolean;
  addListener(eventName: "highContrastChanged", listener: (event: { isHighContrast: boolean }) => void): unknown;
};

const contrastTheme = (ReactNative as unknown as { AppTheme?: ContrastTheme }).AppTheme;

export const useSystemIncreaseContrast = create<{ on: boolean }>()(() => ({ on: false }));

const setIncreaseContrast = (on: boolean) => {
  if (useSystemIncreaseContrast.getState().on !== on) useSystemIncreaseContrast.setState({ on });
};

let watching = false;

export function watchSystemContrast() {
  if (watching || !contrastTheme) return;
  watching = true;
  setIncreaseContrast(!!contrastTheme.isHighContrast);
  contrastTheme.addListener("highContrastChanged", (event) => setIncreaseContrast(!!event.isHighContrast));
}

export const systemIncreaseContrast = () => useSystemIncreaseContrast.getState().on;
