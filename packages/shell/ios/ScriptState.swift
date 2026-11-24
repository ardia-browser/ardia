struct ScriptState {
  var windows: [ScriptWindowState] = []
  var profiles: [ScriptProfileState] = []

  init() {}

  init(_ raw: [String: Any]) {
    windows = (raw["windows"] as? [[String: Any]] ?? []).map(ScriptWindowState.init)
    profiles = (raw["profiles"] as? [[String: Any]] ?? []).map(ScriptProfileState.init)
  }
}
