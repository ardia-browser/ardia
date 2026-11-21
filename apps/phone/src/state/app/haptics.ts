import { barPressHaptic, confirmHaptic, errorHaptic, pressHaptic, selectionHaptic, successHaptic, tabLandedHaptic, tapHaptic, tickHaptic, warningHaptic } from "../../platform/system";

const quietly = (haptic: () => Promise<void>) => () => void haptic().catch(() => undefined);

export const haptics = {
  tick: quietly(tickHaptic),
  selection: quietly(selectionHaptic),
  tap: quietly(tapHaptic),
  press: quietly(pressHaptic),
  success: quietly(successHaptic),
  warning: quietly(warningHaptic),
  error: quietly(errorHaptic),
  confirm: quietly(confirmHaptic),
  barPress: quietly(barPressHaptic),
  tabLanded: quietly(tabLandedHaptic),
};
