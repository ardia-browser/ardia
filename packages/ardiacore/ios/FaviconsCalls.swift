import ExpoModulesCore

func faviconsCallTable(fetch fetchHandler: @escaping CallHandler) -> CallTable {
  CallTable(domain: "favicons", handlers: [
    "get": EngineCall.passing("ac_favicons_get"),
    "set": EngineCall.passing("ac_favicons_set"),
    "fetch": fetchHandler,
  ])
}
