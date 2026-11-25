struct ScriptTabState {
  let id: String
  let title: String
  let url: String
  let loading: Bool
  let pinned: Bool

  init(_ raw: [String: Any]) {
    id = raw["id"] as? String ?? ""
    title = raw["title"] as? String ?? ""
    url = raw["url"] as? String ?? ""
    loading = raw["loading"] as? Bool ?? false
    pinned = raw["pinned"] as? Bool ?? false
  }
}
