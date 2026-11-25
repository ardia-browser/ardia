import ExpoModulesCore

func sitesCallTable(settings settingsHandler: @escaping CallHandler, setSetting setSettingHandler: @escaping CallHandler, origins originsHandler: @escaping CallHandler, reset resetHandler: @escaping CallHandler, clearData clearDataHandler: @escaping CallHandler, zoomLevels zoomLevelsHandler: @escaping CallHandler, setZoom setZoomHandler: @escaping CallHandler, preloadPages preloadPagesHandler: @escaping CallHandler, setPreloadPages setPreloadPagesHandler: @escaping CallHandler) -> CallTable {
  CallTable(domain: "sites", handlers: [
    "settings": settingsHandler,
    "setSetting": setSettingHandler,
    "origins": originsHandler,
    "reset": resetHandler,
    "clearData": clearDataHandler,
    "zoomLevels": zoomLevelsHandler,
    "readStorage": EngineCall.passing("ac_local_storage_read"),
    "writeStorage": EngineCall.passing("ac_local_storage_write"),
    "registrableDomains": EngineCall.passing("ac_registrable_domains"),
    "setZoom": setZoomHandler,
    "preloadPages": preloadPagesHandler,
    "setPreloadPages": setPreloadPagesHandler,
  ])
}
