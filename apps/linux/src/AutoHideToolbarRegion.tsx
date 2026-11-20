import { PageOverlayRegion } from "./PageOverlayRegion";
import { AutoHideToolbar as BrowserAutoHideToolbar } from "../../browser/src/components/toolbar/AutoHideToolbar";

export * from "../../browser/src/components/toolbar/AutoHideToolbar";

export function AutoHideToolbar(props: React.ComponentProps<typeof BrowserAutoHideToolbar>) {
  return (
    <PageOverlayRegion testID="ardia-auto-hide-toolbar" capturing={props.mode !== "collapsed"}>
      <BrowserAutoHideToolbar {...props} />
    </PageOverlayRegion>
  );
}
