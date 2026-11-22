import { Platform, type AccessibilityActionEvent, type AccessibilityActionInfo } from "react-native";
import { t } from "../../lib/uiLanguage";


export type ScreenReaderAction = { name: string; label?: string; run: () => void };

type ActionProps = {
  accessibilityActions?: AccessibilityActionInfo[];
  onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
  onAccessibilityTap?: () => void;
};

const LONG_PRESS_NAME = t(`More Options`);

export function screenReaderActions(actions: readonly ScreenReaderAction[], os: string = Platform.OS): ActionProps {
  if (!actions.length) return {};
  if (os !== "ios") {
    return {
      accessibilityActions: actions.map((action) => (action.label ? { name: action.name, label: action.label } : { name: action.name })),
      onAccessibilityAction: (event) => actions.find((action) => action.name === event.nativeEvent.actionName)?.run(),
    };
  }
  const activate = actions.find((action) => action.name === "activate");
  const named = actions
    .filter((action) => action !== activate)
    .map((action) => ({ name: action.label ?? (action.name === "longpress" ? LONG_PRESS_NAME : action.name), run: action.run }));
  return {
    ...(named.length
      ? {
          accessibilityActions: named.map((action) => ({ name: action.name })),
          onAccessibilityAction: (event: AccessibilityActionEvent) => named.find((action) => action.name === event.nativeEvent.actionName)?.run(),
        }
      : {}),
    ...(activate ? { onAccessibilityTap: activate.run } : {}),
  };
}
