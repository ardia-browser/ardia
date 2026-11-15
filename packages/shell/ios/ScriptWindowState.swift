struct ScriptWindowState {
  let id: String
  let title: String
  let profileId: String
  let incognito: Bool
  let activeTabId: String?
  let tabs: [ScriptTabState]

  init(_ raw: [String: Any]) {
    id = raw["id"] as? String ?? ""
    title = raw["title"] as? String ?? ""
    profileId = raw["profileId"] as? String ?? ""
    incognito = raw["incognito"] as? Bool ?? false
    activeTabId = raw["activeTabId"] as? String
    tabs = (raw["tabs"] as? [[String: Any]] ?? []).map(ScriptTabState.init)
  }
}
