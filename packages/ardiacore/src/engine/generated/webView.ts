export type WebViewCalls = {
  "webView.setDisplayMediaPicker": [{ enabled: boolean }, null];
  "webView.setPeekModifier": [{ modifier: "alt" | "shift" | "off" }, null];
  "webView.setSplitLinkModifier": [{ modifier: "alt" | "altShift" }, null];
  "webView.setPeekOtherSiteTabs": [{ tabIds: string[] }, null];
  "webView.setSelectionPopover": [{ enabled: boolean }, null];
  "webView.setBlockAutoplayEverywhere": [{ enabled: boolean }, null];
  "webView.setCommandScrollZoom": [{ enabled: boolean }, null];
  "webView.setLittleArdiaOpensNewTabLinks": [{ enabled: boolean }, null];
  "webView.setPopupsOpenAsTabs": [{ enabled: boolean }, null];
  "webView.setAutoPictureInPicture": [{ enabled: boolean }, null];
  "webView.setVideoUpscaling": [{ enabled: boolean }, null];
  "webView.setVideoUpscalingTestConditions": [{ lowPower?: boolean; thermalPressure?: boolean; capturing?: boolean }, null];
  "webView.videoUpscalingState": [{}, { enabled: boolean; lowPower: boolean; thermalPressure: boolean; appActive: boolean; tabs: { tabId: number; allowed: boolean; capturing: boolean }[] } | null];
  "webView.takeContentDrift": [{}, { layouts: number; fits: number; maxPoints: number }];
  "webView.takePageMetrics": [{}, Record<string, number>];
  "webView.takeFirstPaintHolds": [{}, { held: number; painted: number; loaded: number; pressed: number; timedOut: number; heldMs: number }];
};

export type WebViewEvents = {};
