import { requireNativeModule } from "expo-modules-core";
import type { ShellModules } from "./generated/native";

export type ShellNativeModules = ShellModules;

export const nativeModule = <Name extends keyof ShellModules>(name: Name) => requireNativeModule<ShellModules[Name]>(name);
