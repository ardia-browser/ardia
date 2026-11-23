import ExpoModulesCore

func tabsCallTable(routeLinkTabs routeLinkTabsHandler: @escaping CallHandler, stripCommand stripCommandHandler: @escaping CallHandler, strips stripsHandler: @escaping CallHandler, reportCommits reportCommitsHandler: @escaping CallHandler, devBrowserId devBrowserIdHandler: @escaping CallHandler, devEvents devEventsHandler: @escaping CallHandler, devWindowNumber devWindowNumberHandler: @escaping CallHandler, devFocusPage devFocusPageHandler: @escaping CallHandler, devPagePhase devPagePhaseHandler: @escaping CallHandler, devClosePage devClosePageHandler: @escaping CallHandler, devPictureInPicture devPictureInPictureHandler: @escaping CallHandler, devPictureInPictureAction devPictureInPictureActionHandler: @escaping CallHandler, devPostPeekMouseUp devPostPeekMouseUpHandler: @escaping CallHandler, devScrollZoom devScrollZoomHandler: @escaping CallHandler) -> CallTable {
  CallTable(domain: "tabs", handlers: [
    "routeLinkTabs": routeLinkTabsHandler,
    "stripCommand": stripCommandHandler,
    "strips": stripsHandler,
    "lastTabPolicy": EngineCall.passing("ac_tabs_last_tab_policy"),
    "reportCommits": reportCommitsHandler,
    "devBrowserId": devBrowserIdHandler,
    "devEvents": devEventsHandler,
    "devWindowNumber": devWindowNumberHandler,
    "devFocusPage": devFocusPageHandler,
    "devPagePhase": devPagePhaseHandler,
    "devClosePage": devClosePageHandler,
    "devPictureInPicture": devPictureInPictureHandler,
    "devPictureInPictureAction": devPictureInPictureActionHandler,
    "devPostPeekMouseUp": devPostPeekMouseUpHandler,
    "devScrollZoom": devScrollZoomHandler,
  ])
}
