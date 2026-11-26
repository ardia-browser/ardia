import { system } from "@ardia/phone-native";
import { Platform, StatusBar } from "react-native";

export function setSystemBarIcons(lightStatus: boolean, lightNavigation: boolean) {
  if (Platform.OS === "android" && system.setsSystemBarIcons()) {
    system.setSystemBarIcons(lightStatus, lightNavigation);
    return;
  }
  StatusBar.setBarStyle(lightStatus ? "light-content" : "dark-content", false);
}
