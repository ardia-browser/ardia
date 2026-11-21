import { dismissMenu, menuShown } from "./menus";
import { openAppMenu } from "./AppMenuButton";
import { createClusterMenu, visibleClusterMenuButton } from "./clusterMenu";

export const showAppMenu = createClusterMenu({
  target: typeof window === "undefined" ? null : window,
  open: openAppMenu,
  shown: menuShown,
  dismiss: dismissMenu,
  focused: () => (typeof document === "undefined" ? null : document.activeElement),
  visible: () => (typeof document === "undefined" ? null : visibleClusterMenuButton(document)),
});
