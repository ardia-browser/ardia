export type NewTabBarStage = "page" | "committed" | "focused" | "rest" | "typed" | "gone";

export type MarkNewTabBar = (stage: NewTabBarStage, tabId: string) => void;

export type MarkNewTabPane = (tabId: string, state: string) => void;

export const markNewTabBar: MarkNewTabBar = () => {};

export const markNewTabPane: MarkNewTabPane = () => {};
