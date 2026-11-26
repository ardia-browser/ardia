import { Platform } from "react-native";

let cuts = Platform.OS === "android";

export const tabSwitchCuts = () => cuts;

export function cutTabSwitches(on: boolean) {
  cuts = on;
}
