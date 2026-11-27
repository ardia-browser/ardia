import type { ComponentProps } from "react";
import { SplitToast as BrowserSplitToast } from "../../browser/src/components/split/SplitChrome";
import { useToasts } from "../../browser/src/state/app/toasts";
import { PageOverlayRegion } from "./PageOverlayRegion";

export * from "../../browser/src/components/split/SplitChrome";

export function SplitToast(props: ComponentProps<typeof BrowserSplitToast>) {
  const clickable = useToasts((s) => {
    const toast = s.toasts[props.windowId];
    return !!(toast?.action || toast?.secondary);
  });
  return (
    <PageOverlayRegion testID="ardia-toast" capturing={clickable}>
      <BrowserSplitToast {...props} />
    </PageOverlayRegion>
  );
}
