import type { ComponentProps } from "react";
import { WindowBackdrop as BrowserWindowBackdrop } from "../../browser/src/components/ui";
import { NativeBackdropRoot } from "./shellAbove";

export * from "../../browser/src/components/ui";

export function WindowBackdrop(props: ComponentProps<typeof BrowserWindowBackdrop>) {
  return (
    <NativeBackdropRoot.Provider value={true}>
      <BrowserWindowBackdrop {...props} />
    </NativeBackdropRoot.Provider>
  );
}
