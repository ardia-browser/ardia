import type { View } from "react-native";

const reactNativeWindowsView: { default: typeof View } = require("react-native/Libraries/Components/View/View");

export const RawView = reactNativeWindowsView.default;
