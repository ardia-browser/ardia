import { useCallback, useState } from "react";
import type { RowAction } from "../../state/browse/tabMenus";
import { haptics } from "../../state/app/haptics";
import { copy } from "../../lib/platformCopy";
import { ConfirmDialog, showActionSheet, type Confirmation } from "../ui";

export function useRowConfirm() {
  const [asking, setAsking] = useState<Confirmation | null>(null);
  const choose = useCallback((action: RowAction) => {
    if (!action.confirm) return action.run();
    const confirmation = {
      ...action.confirm,
      destructive: action.destructive,
      run: () => {
        haptics.warning();
        action.run();
      },
    };
    if (copy().confirmsAsActionSheet) showActionSheet(confirmation);
    else setAsking(confirmation);
  }, []);
  const guarded = useCallback((actions: readonly RowAction[]) => actions.map((action) => ({ ...action, run: () => choose(action) })), [choose]);
  const dialog = asking ? <ConfirmDialog confirmation={asking} onClose={() => setAsking(null)} /> : null;
  return { choose, guarded, dialog };
}

export const rowMenuItems = (actions: readonly RowAction[], choose: (action: RowAction) => void) =>
  actions.map((action) => ({ label: action.label, icon: action.icon, destructive: action.destructive, onPress: () => choose(action) }));
