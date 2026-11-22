import { create } from "zustand";
import { TRAY_BACK_TRAVEL, trayBack, type TrayBackHandlers } from "../../platform/back";

export const trayBackTravel = TRAY_BACK_TRAVEL;

export function followTrayBack(handlers: TrayBackHandlers): () => void {
  trayBack.setEnabled(true);
  const subscription = trayBack.listen(handlers);
  return () => {
    subscription.remove();
    trayBack.setEnabled(false);
  };
}

export const useTrayCovers = create<{ covers: number }>()(() => ({ covers: 0 }));

export function coverTray(): () => void {
  useTrayCovers.setState((state) => ({ covers: state.covers + 1 }));
  let covering = true;
  return () => {
    if (!covering) return;
    covering = false;
    useTrayCovers.setState((state) => ({ covers: Math.max(0, state.covers - 1) }));
  };
}
