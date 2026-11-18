struct ScriptProfileState {
  let id: String
  let name: String

  init(_ raw: [String: Any]) {
    id = raw["id"] as? String ?? ""
    name = raw["name"] as? String ?? ""
  }
}
