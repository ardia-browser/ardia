import ExpoModulesCore

func faviconsCallTable(peek peekHandler: @escaping CallHandler, fetch fetchHandler: @escaping CallHandler) -> CallTable {
  CallTable(domain: "favicons", handlers: [
    "get": EngineCall.passing("ac_favicons_get"),
    "peek": peekHandler,
    "set": EngineCall.passing("ac_favicons_set"),
    "fetch": fetchHandler,
  ])
}
