import ExpoModulesCore

func webViewCallTable(setDisplayMediaPicker setDisplayMediaPickerHandler: @escaping CallHandler, setPeekModifier setPeekModifierHandler: @escaping CallHandler, setSplitLinkModifier setSplitLinkModifierHandler: @escaping CallHandler, setPeekOtherSiteTabs setPeekOtherSiteTabsHandler: @escaping CallHandler, setSelectionPopover setSelectionPopoverHandler: @escaping CallHandler, setBlockAutoplayEverywhere setBlockAutoplayEverywhereHandler: @escaping CallHandler, setCommandScrollZoom setCommandScrollZoomHandler: @escaping CallHandler, setLittleArdiaOpensNewTabLinks setLittleArdiaOpensNewTabLinksHandler: @escaping CallHandler, setPopupsOpenAsTabs setPopupsOpenAsTabsHandler: @escaping CallHandler, setAutoPictureInPicture setAutoPictureInPictureHandler: @escaping CallHandler, setVideoUpscaling setVideoUpscalingHandler: @escaping CallHandler, setVideoUpscalingTestConditions setVideoUpscalingTestConditionsHandler: @escaping CallHandler, videoUpscalingState videoUpscalingStateHandler: @escaping CallHandler, takeContentDrift takeContentDriftHandler: @escaping CallHandler, takePageMetrics takePageMetricsHandler: @escaping CallHandler, takeFirstPaintHolds takeFirstPaintHoldsHandler: @escaping CallHandler) -> CallTable {
  CallTable(domain: "webView", handlers: [
    "setDisplayMediaPicker": setDisplayMediaPickerHandler,
    "setPeekModifier": setPeekModifierHandler,
    "setSplitLinkModifier": setSplitLinkModifierHandler,
    "setPeekOtherSiteTabs": setPeekOtherSiteTabsHandler,
    "setSelectionPopover": setSelectionPopoverHandler,
    "setBlockAutoplayEverywhere": setBlockAutoplayEverywhereHandler,
    "setCommandScrollZoom": setCommandScrollZoomHandler,
    "setLittleArdiaOpensNewTabLinks": setLittleArdiaOpensNewTabLinksHandler,
    "setPopupsOpenAsTabs": setPopupsOpenAsTabsHandler,
    "setAutoPictureInPicture": setAutoPictureInPictureHandler,
    "setVideoUpscaling": setVideoUpscalingHandler,
    "setVideoUpscalingTestConditions": setVideoUpscalingTestConditionsHandler,
    "videoUpscalingState": videoUpscalingStateHandler,
    "takeContentDrift": takeContentDriftHandler,
    "takePageMetrics": takePageMetricsHandler,
    "takeFirstPaintHolds": takeFirstPaintHoldsHandler,
  ])
}
