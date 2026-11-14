import { requireNativeModule } from "expo-modules-core";

const Pages = requireNativeModule<{ mayCloseWindow(windowId: string, tabIds: string[]): Promise<boolean> }>("ArdiaLinuxPages");

export const mayCloseWindowPages = async (windowId: string, tabIds: string[]): Promise<boolean> => (await Pages.mayCloseWindow(windowId, tabIds)) !== false;
