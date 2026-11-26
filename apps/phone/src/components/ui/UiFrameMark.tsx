import { StyleSheet } from "react-native";
import Animated from "react-native-reanimated";
import { FrameMark } from "@ardia/phone-native";

export const UiFrameMark = Animated.createAnimatedComponent(FrameMark);

export const uiFrameMarkStyle = StyleSheet.create({ mark: { position: "absolute", left: 0, top: 0, width: 0, height: 0 } }).mark;
