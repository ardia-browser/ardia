import { create } from "zustand";
import { highContrastOn, onHighContrast } from "../../platform/highContrast";

export const useSystemIncreaseContrast = create<{ on: boolean }>()(() => ({ on: false }));

const setIncreaseContrast = (on: boolean) => {
  if (useSystemIncreaseContrast.getState().on !== on) useSystemIncreaseContrast.setState({ on });
};

let watching = false;

export function watchSystemContrast() {
  if (watching) return;
  watching = true;
  onHighContrast(setIncreaseContrast);
  void highContrastOn().then(setIncreaseContrast);
}

export const systemIncreaseContrast = () => useSystemIncreaseContrast.getState().on;
