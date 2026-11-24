import { PageOverlayRegion } from "./PageOverlayRegion";
import { TopStripPeek as BrowserTopStripPeek } from "../../browser/src/components/tabstrip/TopTabStrip";

export * from "../../browser/src/components/tabstrip/TopTabStrip";

export function TopStripPeek(props: React.ComponentProps<typeof BrowserTopStripPeek>) {
  return (
    <PageOverlayRegion testID="ardia-top-strip-peek">
      <BrowserTopStripPeek {...props} />
    </PageOverlayRegion>
  );
}
