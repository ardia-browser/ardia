enum VaultCloudAccount {
  static func accepted(state: VaultState?, account: String?, server: String?, saved: String?) -> String? {
    if state == .signedOut || state == .notInstalled { return nil }
    if let account, !account.isEmpty { return "\(account)@\(server ?? "")" }
    guard let saved, !saved.isEmpty, !saved.hasPrefix("@") else { return nil }
    return saved
  }
}
