import { create } from "zustand";

export const useDuoSidebar = create<{ shown: boolean }>()(() => ({ shown: false }));

export const setDuoSidebarShown = (shown: boolean) => {
  if (useDuoSidebar.getState().shown !== shown) useDuoSidebar.setState({ shown });
};
