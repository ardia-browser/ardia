import { nativeModule, type OpenSurface, type SurfaceEvent, type SurfaceItem } from "@ardia/shell";

export type { OpenSurface, SurfaceEvent, SurfaceItem };

const Menus = () => nativeModule("ArdiaMenus");

export const openSurfaces = () => Menus().openSurfaces();
export const capturePageMenus = (captures: boolean) => Promise.resolve().then(() => Menus().capturePageMenus(captures));
export const dismissSurface = (id: string) => Menus().dismissSurface(id);
export const menuBar = () => Menus().menuBar();
export const performMenuBarItem = (ref: string, windowId: string) => Menus().performMenuBarItem(ref, windowId);
export const onSurface = (listener: (e: SurfaceEvent) => void) => Menus().addListener("onSurface", listener);
