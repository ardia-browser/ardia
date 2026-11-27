import type { BasePalette } from "../../../lib/themeFile";
import type { ReactNode } from "react";
import type { Animated } from "react-native";
import type { ProfileTheme } from "../../../state/browser/types";
import type { Geo } from "./geometry";
import type { Look } from "./look";

export type SceneOpts = { top: boolean; addressInSidebar: boolean; siteColor: boolean; frame: number; systemDark: boolean; accent: string; palette: BasePalette | null; custom: ProfileTheme | null };
export type SceneProps = { g: Geo; look: Look; p: Animated.Value; opts: SceneOpts };
export type Scene = (props: SceneProps) => ReactNode;
