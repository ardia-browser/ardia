import ExpoModulesCore

func searchCallTable(engines enginesHandler: @escaping CallHandler, setEngineName setEngineNameHandler: @escaping CallHandler) -> CallTable {
  CallTable(domain: "search", handlers: [
    "engines": enginesHandler,
    "setEngineName": setEngineNameHandler,
    "suggest": EngineCall.passing("ac_search_suggest"),
    "stopSuggest": EngineCall.passing("ac_search_suggest_stop"),
  ])
}
