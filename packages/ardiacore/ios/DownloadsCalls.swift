import ExpoModulesCore

func downloadsCallTable(cancel cancelHandler: @escaping CallHandler, pause pauseHandler: @escaping CallHandler, resume resumeHandler: @escaping CallHandler, keep keepHandler: @escaping CallHandler) -> CallTable {
  CallTable(domain: "downloads", handlers: [
    "cancel": cancelHandler,
    "pause": pauseHandler,
    "resume": resumeHandler,
    "keep": keepHandler,
    "settings": EngineCall.passing("ac_downloads_settings"),
    "setSettings": EngineCall.passing("ac_downloads_set_settings"),
  ])
}
