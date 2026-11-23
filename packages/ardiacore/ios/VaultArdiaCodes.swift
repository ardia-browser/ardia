import Foundation

struct VaultRemoveTotpResult: Sendable {
  var removed = false
  var error: VaultAddTotpError?

  func jsonObject() -> [String: Any] {
    var object: [String: Any] = ["removed": removed]
    if let error { object["error"] = error.rawValue }
    return object
  }
}

enum VaultArdiaCodes {
  static func add(id: String, uri: String) async -> VaultAddTotpResult {
    guard let stored = VaultTotpURI.setupURI(uri) else { return .failure(.invalid) }
    guard let listed = await ArdiaVaultIndex.shared.listedItem(id) else { return .failure(.notFound) }
    guard await VaultOwnerCheck.confirm("add a verification code") else { return .failure(.declined) }
    guard await ArdiaVaultIndex.shared.editCodes({ $0[id] = stored }) else { return .failure(.failed, "Ardia couldn't keep the code.") }
    var item = listed
    item.hasTotp = true
    item.totpPeriod = VaultTotp.period(fromURI: stored)
    NSLog("[vaults] ardia kept a verification code")
    return VaultAddTotpResult(item: item)
  }

  static func remove(id: String) async -> VaultRemoveTotpResult {
    guard ArdiaVault.login(ofItem: id) != nil else { return VaultRemoveTotpResult(error: .notFound) }
    guard await VaultOwnerCheck.confirm("remove a verification code") else { return VaultRemoveTotpResult(error: .declined) }
    guard await ArdiaVaultIndex.shared.editCodes({ $0[id] = nil }) else { return VaultRemoveTotpResult(error: .failed) }
    NSLog("[vaults] ardia removed a verification code")
    return VaultRemoveTotpResult(removed: true)
  }

  static func loginChanged(profile: String, origin: String, username: String, to renamed: String?) async -> Bool {
    let base = await ArdiaVaultStore.baseProfile(profile)
    let from = ArdiaVault.itemId(ArdiaVaultLogin(profile: base, origin: origin, username: username))
    let to = renamed.map { ArdiaVault.itemId(ArdiaVaultLogin(profile: base, origin: origin, username: $0)) }
    guard from != to else { return true }
    return await ArdiaVaultIndex.shared.editCodes { codes in
      guard let uri = codes.removeValue(forKey: from) else { return }
      if let to, codes[to] == nil { codes[to] = uri }
    }
  }

  static func importCodes(profile: String, path: String) async -> (imported: Int, standalone: Int) {
    let rows = await Task.detached(priority: .userInitiated) { () -> [VaultCodeImport.Row] in
      let url = URL(fileURLWithPath: path)
      guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= VaultCodeImport.longestFile,
        let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1)
      else { return [] }
      return VaultCodeImport.rows(text)
    }.value
    guard !rows.isEmpty else { return (0, 0) }
    let base = await ArdiaVaultStore.baseProfile(profile)
    _ = await ArdiaVaultIndex.shared.refreshState(explicit: true)
    var listed: [String: String] = [:]
    for item in await ArdiaVaultIndex.shared.items() {
      guard let login = ArdiaVault.login(ofItem: item.id), login.profile == base else { continue }
      listed[loginKey(login.origin, login.username)] = item.id
    }
    var matched = Set<Int>()
    var wanted: [(String, String)] = []
    for (index, row) in rows.enumerated() where !row.origin.isEmpty {
      guard let id = listed[loginKey(row.origin, row.username)] else { continue }
      matched.insert(index)
      wanted.append((id, row.uri))
    }
    let loginCodes = await ArdiaVaultBackup.shared.codes()
    let standalone = VaultCodeImport.standalone(rows, matched: matched, existing: Array(await ArdiaVaultBackup.shared.standaloneCodes().values),
                                                loginCodes: Array(loginCodes.values), now: Date().timeIntervalSince1970)
    let plan = VaultCodeImport.plan(wanted, existing: loginCodes)
    var kept = plan.fresh
    if !plan.replacing.isEmpty, await VaultOwnerCheck.confirm("replace verification codes") { kept += plan.replacing }
    var count = 0
    var alone = 0
    if !kept.isEmpty {
      let chosen = kept
      if await ArdiaVaultIndex.shared.editCodes({ codes in for (id, uri) in chosen { codes[id] = uri } }) { count += chosen.count }
    }
    if !standalone.isEmpty {
      let made = standalone
      let edit = await ArdiaVaultBackup.shared.editStandalone { codes in for code in made { codes[ArdiaStandaloneCode.newId()] = code } }
      if edit == .saved {
        count += made.count
        alone = made.count
      }
    }
    NSLog("[vaults] ardia imported %ld verification codes of %ld", count, rows.count)
    return (count, alone)
  }

  private static func loginKey(_ origin: String, _ username: String) -> String {
    "\(ArdiaVault.originOfRealm(origin).lowercased())\n\(username)"
  }

  static func copy(id: String) async -> VaultCopyResult {
    guard let code = await ArdiaVaultIndex.shared.totp(id: id) else { return .refused(.notFound) }
    return await VaultClipboard.copy(code.code) ? .copied : .clipboardFailed
  }

  static func standaloneList() async -> [[String: Any]] {
    await ArdiaVaultBackup.shared.standaloneCodes().map { id, code in code.metadata(id: id, period: VaultTotp.period(fromURI: code.uri)) }
  }

  static func addStandalone(token: String, label: String, issuer: String?, website: String?) async -> [String: Any] {
    guard let offer = VaultTotpSetup.offer(token) else { return ["added": false, "error": VaultAddTotpError.expired.rawValue] }
    guard let code = ArdiaStandaloneCode.made(uri: offer.uri, label: label, issuer: issuer, website: website, at: Date().timeIntervalSince1970) else {
      return ["added": false, "error": VaultAddTotpError.invalid.rawValue]
    }
    let secret = VaultTotpSecret(code.uri)
    if let held = await ArdiaVaultBackup.shared.standaloneCodes().first(where: { VaultTotpSecret($0.value.uri) == secret }) {
      return ["added": false, "error": "exists", "id": held.key]
    }
    guard await VaultOwnerCheck.confirm("add a verification code") else { return ["added": false, "error": VaultAddTotpError.declined.rawValue] }
    let id = ArdiaStandaloneCode.newId()
    guard await ArdiaVaultBackup.shared.editStandalone({ $0[id] = code }) == .saved else { return ["added": false, "error": VaultAddTotpError.failed.rawValue] }
    VaultTotpSetup.forget(token)
    NSLog("[vaults] ardia kept a standalone verification code")
    return ["added": true, "code": code.metadata(id: id, period: VaultTotp.period(fromURI: code.uri))]
  }

  static func editStandalone(id: String, label: String, website: String?) async -> [String: Any] {
    guard ArdiaStandaloneCode.isId(id), let held = await ArdiaVaultBackup.shared.standaloneCodes()[id] else { return ["saved": false, "error": "notFound"] }
    guard let edited = ArdiaStandaloneCode.made(uri: held.uri, label: label, issuer: held.issuer, website: website, at: held.createdAt ?? 0) else {
      return ["saved": false, "error": "invalid"]
    }
    var kept = edited
    kept.createdAt = held.createdAt
    let next = kept
    guard await ArdiaVaultBackup.shared.editStandalone({ $0[id] = next }) != .failed else { return ["saved": false, "error": "failed"] }
    return ["saved": true, "code": next.metadata(id: id, period: VaultTotp.period(fromURI: next.uri))]
  }

  static func deleteStandalone(id: String) async -> [String: Any] {
    guard ArdiaStandaloneCode.isId(id), await ArdiaVaultBackup.shared.standaloneCodes()[id] != nil else { return ["deleted": false, "error": "notFound"] }
    guard await VaultOwnerCheck.confirm("delete a verification code") else { return ["deleted": false, "error": "declined"] }
    guard await ArdiaVaultBackup.shared.editStandalone({ $0[id] = nil }) == .saved else { return ["deleted": false, "error": "failed"] }
    NSLog("[vaults] ardia deleted a standalone verification code")
    return ["deleted": true]
  }

  static func standaloneTotp(id: String) async -> VaultTotp? {
    await ArdiaVaultBackup.shared.standaloneCodes()[id].flatMap { VaultTotpSecret($0.uri) }?.totp()
  }

  static func fillStandalone(id: String, fields: [String], origin: String, userChose: Bool) async -> Result<VaultFillValues, VaultFillError> {
    guard VaultOriginMatch.isSecure(origin) else { return .failure(.insecure) }
    guard fields.allSatisfy({ $0 == "otp" || $0 == "totp" }), !fields.isEmpty else { return .failure(.notFound) }
    guard let code = await ArdiaVaultBackup.shared.standaloneCodes()[id] else { return .failure(.notFound) }
    guard code.matches(origin: origin, userChose: userChose) else { return .failure(.originMismatch) }
    guard let totp = VaultTotpSecret(code.uri)?.totp() else { return .failure(.notFound) }
    return .success(VaultFillValues(values: ["otp": totp.code], touched: false))
  }
}
