import { useSafeAreaInsets } from "react-native-safe-area-context";
import { bottomBarLayout, type BottomBarLayout } from "../../lib/bottomBarSpan";
import { useScreenLayout } from "../../state/app/screenLayout";

export function useBottomBarLayout(width: number, side: number): BottomBarLayout {
  const insets = useSafeAreaInsets();
  const hinge = useScreenLayout((s) => s.hinge);
  return bottomBarLayout(width, insets, hinge, side);
}
