import Foundation
import os

actor ArdiaVaultIndex {
  static let shared = ArdiaVaultIndex()
  static let freshFor: TimeInterval = 120
  static let missRebuildGap: TimeInterval = 2

  private static let lastState = OSAllocatedUnfairLock(initialState: ArdiaVault.state(on: true))

  static var knownState: VaultProviderState { lastState.withLock { $0 } }

  private var listed: [VaultItem] = []
  private var positions: [String: Int] = [:]
  private var listedJSON: String?
  private var listedAt = Date.distantPast
  private var everListed = false
  private var stale = true
  private var reading: Task<Void, Never>?
  private var lastMissRebuild = Date.distantPast

  func refreshState(explicit: Bool = false) async -> VaultProviderState {
    if explicit { markStale() }
    let state = ArdiaVault.state(on: await ArdiaVaultStore.isOn())
    publish(state)
    return state
  }

  func signInResult() async -> VaultSignInResult {
    let state = await refreshState()
    return VaultSignInResult(ok: state.state == .unlocked, state: state)
  }

  private func publish(_ state: VaultProviderState) {
    let changed = Self.lastState.withLock { known in
      defer { known = state }
      return known != state
    }
    guard changed else { return }
    markStale()
    let payload = ArdiaConsentStamp.begin().onto(["provider": state.jsonObject()])
    DispatchQueue.main.async { ArdiaEvents.emit("vaults.changed", data: payload) }
  }

  private func announceItems() {
    let payload = ArdiaConsentStamp.begin().onto(["provider": ArdiaVault.id])
    DispatchQueue.main.async { ArdiaEvents.emit("vaults.itemsChanged", data: payload) }
  }

  func items() async -> [VaultItem] {
    guard everListed, !(listed.isEmpty && stale) else {
      await rebuild()
      return listed
    }
    if stale || Date().timeIntervalSince(listedAt) >= Self.freshFor { startRebuild() }
    return listed
  }

  func prewarm() async {
    if !everListed { await rebuild() }
  }

  private func markStale() {
    stale = true
    if everListed { startRebuild() }
  }

  private func startRebuild() {
    guard reading == nil else { return }
    reading = Task { await self.rebuildNow() }
  }

  private func rebuild() async {
    startRebuild()
    await reading?.value
  }

  private func rebuildNow() async {
    stale = false
    let profiles = await ArdiaVaultStore.offeredProfiles()
    if profiles.isEmpty { stale = true }
    var logins: [ArdiaVaultLogin] = []
    for profile in profiles { logins += await ArdiaVaultStore.logins(profile) }
    let codes = await ArdiaVaultBackup.shared.codes()
    let fresh = logins.map { ArdiaVault.item($0, hasTotp: codes[ArdiaVault.itemId($0)] != nil) }
    let changed = everListed && fresh != listed
    let loginsChanged = everListed && fresh.count != listed.count || changed && fresh.map(\.id) != listed.map(\.id)
    if !everListed || fresh != listed { adopt(fresh) }
    listedAt = Date()
    everListed = true
    reading = nil
    if changed { announceItems() }
    if loginsChanged { await ArdiaVaultBackup.shared.noteChange() }
  }

  func itemsJSON() async -> String {
    _ = await items()
    if let listedJSON { return listedJSON }
    let built = VaultJSON.data(listed.map { $0.jsonObject() }).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
    listedJSON = built
    return built
  }

  private func adopt(_ fresh: [VaultItem]) {
    listedJSON = nil
    listed = fresh
    positions = Dictionary(fresh.enumerated().map { ($0.element.id, $0.offset) }, uniquingKeysWith: { first, _ in first })
  }

  func noteSaved(profile: String, origin: String, username: String) async {
    let base = await ArdiaVaultStore.baseProfile(profile)
    let origin = ArdiaVault.originOfRealm(origin)
    guard everListed, VaultOriginMatch.isWebOrigin(origin), await ArdiaVaultStore.offers(base) else { return markStale() }
    let login = ArdiaVaultLogin(profile: base, origin: origin, username: username)
    let id = ArdiaVault.itemId(login)
    guard positions[id] == nil else { return }
    let item = ArdiaVault.item(login, hasTotp: await ArdiaVaultBackup.shared.codes()[id] != nil)
    guard positions[id] == nil else { return }
    positions[id] = listed.count
    listed.append(item)
    listedJSON = nil
    announceItems()
  }

  func noteRemoved(profile: String, origin: String, username: String) async {
    let base = await ArdiaVaultStore.baseProfile(profile)
    let id = ArdiaVault.itemId(ArdiaVaultLogin(profile: base, origin: ArdiaVault.originOfRealm(origin), username: username))
    guard everListed, let index = positions[id] else { return }
    listed.remove(at: index)
    adopt(listed)
    announceItems()
  }

  nonisolated static func noteChanged(profile: String, origin: String, username: String, renamed: String?, removed: Bool) {
    Task {
      if removed || renamed != nil { await shared.noteRemoved(profile: profile, origin: origin, username: username) }
      if !removed { await shared.noteSaved(profile: profile, origin: origin, username: renamed ?? username) }
    }
  }

  func listedItem(_ id: String) async -> VaultItem? {
    if !everListed { await rebuild() }
    if let index = positions[id] { return listed[index] }
    guard Date().timeIntervalSince(lastMissRebuild) >= Self.missRebuildGap else { return nil }
    lastMissRebuild = Date()
    stale = true
    await rebuild()
    return positions[id].map { listed[$0] }
  }

  func fillValues(id: String, fields: [String], origin: String, userChose: Bool, profile: String?) async
    -> Result<VaultFillValues, VaultFillError>
  {
    if ArdiaStandaloneCode.isId(id) { return await VaultArdiaCodes.fillStandalone(id: id, fields: fields, origin: origin, userChose: userChose) }
    guard VaultOriginMatch.isSecure(origin) else { return .failure(.insecure) }
    guard let login = ArdiaVault.login(ofItem: id), let profile, login.profile == profile else { return .failure(.notFound) }
    guard await ArdiaVaultStore.offers(profile) else { return .failure(.locked) }
    guard let item = await listedItem(id) else { return .failure(.notFound) }
    guard userChose || VaultOriginMatch.matches(item.urls, origin: origin) else { return .failure(.originMismatch) }
    var wanted: [VaultField] = []
    for name in fields {
      let field: VaultField? = name == "otp" ? .totp : VaultField(rawValue: name)
      if let field, !wanted.contains(field) { wanted.append(field) }
    }
    let touched = VaultOwnerCheck.takeFillGrant(provider: ArdiaVault.id, item: id, origin: origin)
    if wanted.contains(.password), !touched, !(await VaultBroker.shared.ownerAllows("fill your password")) { return .failure(.notAuthorized) }
    var values: [String: String] = [:]
    for field in wanted {
      switch field {
      case .username:
        if !item.username.isEmpty { values["username"] = item.username }
      case .password:
        guard let password = await ArdiaVaultStore.password(login), !password.isEmpty else { return .failure(.notFound) }
        values["password"] = password
      case .totp:
        guard let code = await totp(id: id) else {
          if wanted.count > 1 { continue }
          return .failure(.notFound)
        }
        values["otp"] = code.code
      }
    }
    return values.isEmpty ? .failure(.notFound) : .success(VaultFillValues(values: values, touched: touched))
  }

  func copy(id: String, field: VaultCopyField) async -> VaultCopyResult {
    guard let login = ArdiaVault.login(ofItem: id), await listedItem(id) != nil else { return .refused(.notFound) }
    var value = login.username
    if field == .password {
      guard await VaultBroker.shared.ownerAllows("copy your password") else { return .declined }
      value = await ArdiaVaultStore.password(login) ?? ""
    }
    guard !value.isEmpty else { return .refused(.notFound) }
    return await VaultClipboard.copy(value) ? .copied : .clipboardFailed
  }

  func totp(id: String) async -> VaultTotp? {
    if ArdiaStandaloneCode.isId(id) { return await VaultArdiaCodes.standaloneTotp(id: id) }
    return await ArdiaVaultBackup.shared.codes()[id].flatMap { VaultTotpSecret($0) }?.totp()
  }

  func codesChanged() async {
    let codes = await ArdiaVaultBackup.shared.codes()
    var changed = false
    for index in listed.indices {
      let has = codes[listed[index].id] != nil
      if listed[index].hasTotp != has {
        listed[index].hasTotp = has
        changed = true
      }
    }
    guard changed else { return }
    listedJSON = nil
    announceItems()
  }

  func save(origin: String, username: String, password: String, profile: String?) async -> Result<VaultItem, VaultFillError> {
    guard let profile, !password.isEmpty else { return .failure(.failed) }
    guard VaultOriginMatch.isSecure(origin), VaultOriginMatch.isWebOrigin(origin) else { return .failure(.insecure) }
    guard await ArdiaVaultStore.offers(profile) else { return .failure(.locked) }
    let login = ArdiaVaultLogin(profile: profile, origin: origin, username: username)
    guard await ArdiaVaultStore.save(login, password: password) else { return .failure(.failed) }
    await noteSaved(profile: profile, origin: origin, username: username)
    await ArdiaVaultBackup.shared.noteChange()
    return .success(ArdiaVault.item(login, hasTotp: await ArdiaVaultBackup.shared.codes()[ArdiaVault.itemId(login)] != nil))
  }

  func editCodes(_ edit: @Sendable (inout [String: String]) -> Void) async -> Bool {
    switch await ArdiaVaultBackup.shared.editCodes(edit) {
    case .unchanged: return true
    case .failed: return false
    case .saved:
      await codesChanged()
      return true
    }
  }
}
