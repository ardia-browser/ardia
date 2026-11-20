import Foundation

enum ArdiaBackupState: String, Sendable {
  case off
  case never
  case backedUp
  case waitingForKeychain
  case waitingForICloud
  case failed
  case needsUpdate
  case deleted
}

enum ArdiaBackupProblem: String, Sendable {
  case unreadable
  case iCloud
}

struct ArdiaBackupStatus: Sendable {
  var state: ArdiaBackupState
  var backedUpAt: Double?
  var problem: ArdiaBackupProblem?
  var restorable: Int?
  var updatable: Int?

  func jsonObject() -> [String: Any] {
    var object: [String: Any] = ["state": state.rawValue, "backedUpAt": backedUpAt.map { $0 * 1000 as Any } ?? NSNull()]
    if let problem { object["problem"] = problem.rawValue }
    if let restorable { object["restorable"] = restorable }
    if let updatable { object["updatable"] = updatable }
    return object
  }
}

struct ArdiaRestoreResult: Sendable {
  var restored = 0
  var failed = 0
  var declined = false

  func jsonObject() -> [String: Any] { ["restored": restored, "failed": failed, "declined": declined] }
}

actor ArdiaVaultBackup {
  static let shared = ArdiaVaultBackup()
  static let quietPeriod: Duration = .seconds(3)
  static let dailyInterval: TimeInterval = 86_400

  private var secrets = ArdiaSecretCache<VaultPasskey>()
  private var scheduled: Task<Void, Never>?
  private var running = false
  private var runAgain = false
  private var lastOutcome: ArdiaBackupState?
  private var lastProblem: ArdiaBackupProblem?

  private var name: String { ArdiaVault.id }

  nonisolated static func noteChangeSoon() {
    Task { await shared.noteChange() }
  }

  func codes() -> [String: String] {
    secrets.codes { load().codes.values }
  }

  enum CodeEdit: Sendable {
    case unchanged
    case saved
    case failed
  }

  func editCodes(_ change: @Sendable (inout [String: String]) -> Void) -> CodeEdit {
    let now = Date().timeIntervalSince1970
    var wanted: [String: String]?
    Self.edit(name, now: now) { file, _ in
      let before = file.codes.values
      var after = before
      change(&after)
      guard after != before else { return false }
      for key in Set(before.keys).union(after.keys) where before[key] != after[key] {
        file.codes.set(key, after[key], at: now, device: file.device ?? "")
      }
      wanted = after
      return true
    }
    guard let wanted else { return .unchanged }
    let stored = load().codes.values
    secrets.keep(codes: stored)
    guard stored == wanted else { return .failed }
    VaultCloud.shared.noteLocalChange(name)
    return .saved
  }

  func standaloneCodes() -> [String: ArdiaStandaloneCode] {
    secrets.standalone { load().standaloneCodes }
  }

  func editStandalone(_ change: @Sendable (inout [String: ArdiaStandaloneCode]) -> Void) -> CodeEdit {
    let now = Date().timeIntervalSince1970
    var wanted: [String: ArdiaStandaloneCode]?
    Self.edit(name, now: now) { file, _ in
      var raw = file.standalone.values
      let before = raw
      guard ArdiaStandaloneCode.apply(change, to: &raw) else { return false }
      for key in Set(before.keys).union(raw.keys) where before[key] != raw[key] {
        file.standalone.set(key, raw[key], at: now, device: file.device ?? "")
      }
      wanted = file.standaloneCodes
      return true
    }
    guard let wanted else { return .unchanged }
    let stored = load().standaloneCodes
    secrets.keep(standalone: stored)
    guard stored == wanted else { return .failed }
    VaultCloud.shared.noteLocalChange(name)
    Self.announceStandalone()
    return .saved
  }

  func passkeys() -> [String: VaultPasskey] {
    secrets.passkeys { VaultPasskey.decodedAll(load().passkeys.values) }
  }

  func editPasskeys(_ change: @Sendable (inout [String: VaultPasskey]) -> Void) -> CodeEdit {
    let now = Date().timeIntervalSince1970
    var wanted: [String: VaultPasskey]?
    Self.edit(name, now: now) { file, _ in
      let before = VaultPasskey.decodedAll(file.passkeys.values)
      var after = before
      change(&after)
      guard after != before else { return false }
      for id in Set(before.keys).union(after.keys) where before[id] != after[id] && VaultPasskey.isId(id) {
        if let passkey = after[id] {
          guard let value = passkey.encoded() else { continue }
          file.passkeys.set(id, value, at: now, device: file.device ?? "")
        } else {
          file.passkeys.set(id, nil, at: now, device: file.device ?? "")
        }
      }
      wanted = VaultPasskey.decodedAll(file.passkeys.values)
      return true
    }
    guard let wanted else { return .unchanged }
    let stored = VaultPasskey.decodedAll(load().passkeys.values)
    secrets.keep(passkeys: stored)
    guard stored == wanted else { return .failed }
    VaultCloud.shared.noteLocalChange(name)
    Self.announcePasskeys()
    return .saved
  }

  nonisolated static func announcePasskeys() {
    let data = ArdiaConsentStamp.begin().onto([:])
    DispatchQueue.main.async { ArdiaEvents.emit("vaults.passkeysChanged", data: data) }
  }

  nonisolated static func announceStandalone() {
    let data = ArdiaConsentStamp.begin().onto([:])
    DispatchQueue.main.async { ArdiaEvents.emit("vaults.codesChanged", data: data) }
  }

  func prewarm() {
    _ = codes()
  }

  func dropSecrets() {
    secrets.drop()
  }

  func noteChange() {
    guard VaultCloud.shared.isOn else { return }
    scheduled?.cancel()
    scheduled = Task {
      try? await Task.sleep(for: Self.quietPeriod)
      guard !Task.isCancelled else { return }
      await self.backUp()
    }
  }

  func backUpIfDue() async {
    guard VaultCloud.shared.isOn, scheduled == nil, !running else { return }
    let last = load().backedUpAt ?? 0
    guard Date().timeIntervalSince1970 - last >= Self.dailyInterval else { return }
    await backUp()
  }

  func cloudSettingChanged(on: Bool) async {
    guard !on else { return await backUp() }
    scheduled?.cancel()
    scheduled = nil
    lastOutcome = nil
    Self.edit(name, now: Date().timeIntervalSince1970) { file, stored in
      guard stored.plain != nil, !file.logins.entries.isEmpty || file.seen != nil || file.backedUpAt != nil else { return false }
      file.logins = VaultLedger()
      file.seen = nil
      file.backedUpAt = nil
      return true
    }
  }

  func cloudChanged(fromHere: Bool) async {
    let (outcome, changedHere) = await reconcileNoting()
    record(outcome, problem: nil, backedUp: false)
    let file = load()
    let unheld = (standalone: secrets.standalone == nil, passkeys: secrets.passkeys == nil)
    let changes = secrets.refresh(from: file, passkeys: VaultPasskey.decodedAll)
    if changes.standalone || unheld.standalone && changedHere { Self.announceStandalone() }
    if changes.passkeys || unheld.passkeys && changedHere { Self.announcePasskeys() }
    if changes.codes { await ArdiaVaultIndex.shared.codesChanged() }
  }

  func backUp() async {
    scheduled = nil
    guard VaultCloud.shared.isOn else { return }
    guard !VaultAutoLock.shared.isScreenLocked else { return }
    if running {
      runAgain = true
      return
    }
    running = true
    defer { running = false }
    repeat {
      runAgain = false
      await backUpOnce()
    } while runAgain
  }

  private func backUpOnce() async {
    let profiles = await Self.backedUpProfiles()
    let read = await Self.readLogins(profiles)
    let now = Date().timeIntervalSince1970
    if !read.profiles.isEmpty {
      Self.edit(name, now: now) { file, stored in
        let changed = ArdiaVaultBackupPlan.noteLocal(&file, read: read.profiles, local: read.logins, now: now, device: file.device ?? "")
        return changed || stored.isMissing
      }
    }
    let outcome = await reconcile()
    let unreadable = read.failed && read.profiles.isEmpty
    record(outcome, problem: unreadable ? .unreadable : nil, backedUp: outcome == .done && !read.profiles.isEmpty)
  }

  func status(profiles: [String]?) async -> ArdiaBackupStatus {
    if VaultCloud.shared.isOn, lastOutcome == nil, scheduled == nil, !running {
      lastOutcome = .never
      Task { await self.backUpIfDue() }
    }
    var status = currentStatus()
    guard let profiles, status.state != .off else { return status }
    guard status.state != .deleted else { return status }
    let file = load()
    guard !file.logins.entries.isEmpty else {
      status.restorable = 0
      status.updatable = 0
      return status
    }
    let present = await Self.listLogins(Set(profiles + [""]))
    guard present.profiles.contains("") else { return status }
    status.restorable = ArdiaVaultBackupPlan.restorePlan(file, profiles: present.profiles, present: present.keys).count
    status.updatable = ArdiaVaultBackupPlan.updatableCount(file, present: present.keys)
    return status
  }

  func restore(profiles: [String]) async -> ArdiaRestoreResult {
    guard await VaultOwnerCheck.confirm("restore your passwords from iCloud") else { return ArdiaRestoreResult(declined: true) }
    _ = await reconcile()
    let present = await Self.readLogins(Set(profiles + [""]))
    guard present.profiles.contains("") else { return ArdiaRestoreResult(failed: 1) }
    let plan = ArdiaVaultBackupPlan.restorePlan(load(), profiles: present.profiles, present: Set(present.logins.keys))
    var result = ArdiaRestoreResult()
    var restored: [ArdiaRestoreItem] = []
    for item in plan {
      if await ArdiaVaultStore.save(item.target, password: item.password) {
        restored.append(item)
        result.restored += 1
      } else {
        result.failed += 1
      }
    }
    let now = Date().timeIntervalSince1970
    if !restored.isEmpty {
      let file = Self.edit(name, now: now) { file, _ in
        for item in restored { ArdiaVaultBackupPlan.noteRestored(&file, item, now: now, device: file.device ?? "") }
        return true
      }
      secrets.keep(codes: file.codes.values)
      VaultCloud.shared.noteLocalChange(name)
      await ArdiaVaultIndex.shared.codesChanged()
    }
    emit(nil)
    return result
  }

  func updateChanged(profiles: [String]) async -> ArdiaRestoreResult {
    guard await VaultOwnerCheck.confirm("update your passwords from iCloud") else { return ArdiaRestoreResult(declined: true) }
    _ = await reconcile()
    let present = await Self.readLogins(Set(profiles + [""]))
    let plan = ArdiaVaultBackupPlan.updatePlan(load(), present: present.logins)
    var result = ArdiaRestoreResult()
    var updated: [ArdiaRestoreItem] = []
    for item in plan {
      if await ArdiaVaultStore.update(item.target, password: item.password) {
        updated.append(item)
        result.restored += 1
      } else {
        result.failed += 1
      }
    }
    if !updated.isEmpty {
      Self.edit(name, now: Date().timeIntervalSince1970) { file, _ in
        for item in updated { ArdiaVaultBackupPlan.noteUpdated(&file, item) }
        return true
      }
    }
    emit(nil)
    return result
  }

  func deleteEverywhere() async -> [String: Any] {
    guard VaultCloud.shared.isOn else { return ["deleted": false, "declined": false] }
    guard await VaultOwnerCheck.confirm("delete your passwords from iCloud") else { return ["deleted": false, "declined": true] }
    scheduled?.cancel()
    scheduled = nil
    let deleted = await VaultCloud.perform { VaultCloud.shared.deleteEverywhere() }
    if deleted { await cloudSettingChanged(on: false) }
    emit(deleted ? "deleted" : "failed")
    return ["deleted": deleted, "declined": false]
  }

  func resumeEverywhere() async {
    await VaultCloud.perform { VaultCloud.shared.resume() }
    emit(nil)
  }

  private func reconcile() async -> VaultCloudOutcome { await reconcileNoting().outcome }

  private func reconcileNoting() async -> (outcome: VaultCloudOutcome, changedHere: Bool) {
    let name = name
    return await VaultCloud.perform { () -> (outcome: VaultCloudOutcome, changedHere: Bool) in
      var changedHere = false
      let now = Date().timeIntervalSince1970
      let recovered = VaultCache.mergeHeld(name) { held, read in
        guard let recovered = ArdiaVaultFile.decode(held, device: "", now: now) else { return nil }
        if let plain = read.plain, ArdiaVaultFile.isNewerFormat(plain) { return nil }
        var file = ArdiaVaultBackup.file(from: read, now: now)
        file.merge(recovered)
        file.version = ArdiaVaultFile.currentVersion
        return try? JSONEncoder().encode(file)
      }
      if recovered { changedHere = true }
      let outcome = VaultCloud.shared.reconcile(name) { plains in
        var merge = VaultCloudMerge.keep
        ArdiaVaultBackup.edit(name, now: now) { file, stored in
          let plan = ArdiaVaultBackupPlan.cloudPlan(local: file, storedMissing: stored.isMissing, remotes: plains, now: now)
          file = plan.local
          if plan.newerElsewhere {
            merge = .newerFormat
          } else if let push = plan.push, let encoded = try? JSONEncoder().encode(push) {
            merge = .push(encoded)
          }
          if plan.changed { changedHere = true }
          return plan.changed
        }
        return merge
      }
      return (outcome, changedHere)
    }
  }

  private func record(_ outcome: VaultCloudOutcome, problem: ArdiaBackupProblem?, backedUp: Bool) {
    let state: ArdiaBackupState
    switch outcome {
    case .off: state = .off
    case .pending: state = .waitingForICloud
    case .waitingForKey: state = .waitingForKeychain
    case .failed: state = .failed
    case .needsUpdate: state = .needsUpdate
    case .done: state = problem == nil ? (lastOutcome == .failed && !backedUp ? .failed : .backedUp) : .failed
    }
    let resolvedProblem: ArdiaBackupProblem? = problem ?? (outcome == .failed ? .iCloud : nil)
    if backedUp {
      let now = Date().timeIntervalSince1970
      Self.edit(name, now: now) { file, stored in
        guard stored.plain != nil else { return false }
        file.backedUpAt = now
        return true
      }
    }
    lastProblem = state == .failed ? resolvedProblem ?? lastProblem : nil
    lastOutcome = state
    emit(outcome == .done && backedUp ? "backedUp" : state == .failed ? "failed" : state == .waitingForKeychain ? "waiting" : nil)
  }

  private func currentStatus() -> ArdiaBackupStatus {
    if VaultCloud.shared.isDeletedEverywhere { return ArdiaBackupStatus(state: .deleted) }
    guard VaultCloud.shared.isOn else { return ArdiaBackupStatus(state: .off) }
    let backedUpAt = load().backedUpAt
    let settled = backedUpAt == nil ? ArdiaBackupState.never : .backedUp
    let state = lastOutcome.flatMap { $0 == .never || $0 == .backedUp ? nil : $0 } ?? settled
    return ArdiaBackupStatus(state: state, backedUpAt: backedUpAt, problem: state == .failed ? lastProblem : nil)
  }

  private func emit(_ outcome: String?) {
    var payload = currentStatus().jsonObject()
    if let outcome { payload["outcome"] = outcome }
    let data = ArdiaConsentStamp.begin().onto(payload)
    DispatchQueue.main.async { ArdiaEvents.emit("vaults.backupChanged", data: data) }
  }

  private func load() -> ArdiaVaultFile {
    Self.file(from: VaultCache.readSealed(name), now: Date().timeIntervalSince1970)
  }

  @discardableResult
  private static func edit(_ name: String, now: Double, _ change: (inout ArdiaVaultFile, VaultCache.LocalRead) -> Bool) -> ArdiaVaultFile {
    VaultCache.updateSealed(name) { stored -> (Data?, ArdiaVaultFile) in
      var file = Self.file(from: stored, now: now)
      if let plain = stored.plain, ArdiaVaultFile.isNewerFormat(plain) {
        VaultStoreCounts.note(\.newerFormatKept)
        NSLog("[vaults] ardia.vault was written by a newer Ardia, so this one only reads it")
        return (nil, file)
      }
      guard change(&file, stored) else { return (nil, file) }
      file.version = ArdiaVaultFile.currentVersion
      return (try? JSONEncoder().encode(file), file)
    }
  }

  private static func file(from read: VaultCache.LocalRead, now: Double) -> ArdiaVaultFile {
    var file = ArdiaVaultFile()
    if let plain = read.plain, let decoded = ArdiaVaultFile.decode(plain, device: "", now: now) { file = decoded }
    if file.device == nil || file.device == "" { file.device = UUID().uuidString }
    let device = file.device ?? ""
    for (key, entry) in file.codes.entries where entry.device.isEmpty { file.codes.entries[key]?.device = device }
    for (key, entry) in file.standalone.entries where entry.device.isEmpty { file.standalone.entries[key]?.device = device }
    for (key, entry) in file.passkeys.entries where entry.device.isEmpty { file.passkeys.entries[key]?.device = device }
    return file
  }

  @MainActor
  private static func backedUpProfilesNow() -> [String] {
    ArdiaVaultStore.onArdia.backedUp(loaded: ArdiaHost.loadedProfiles) { ArdiaHost.isPrivateProfile($0) }
  }

  private static func backedUpProfiles() async -> Set<String> {
    Set(await MainActor.run { backedUpProfilesNow() })
  }

  private struct LoginRead: Sendable {
    var profiles: Set<String> = []
    var logins: [String: String] = [:]
    var failed = false
  }

  private static func listLogins(_ profiles: Set<String>) async -> (profiles: Set<String>, keys: Set<String>) {
    var listed: (profiles: Set<String>, keys: Set<String>) = ([], [])
    for profile in profiles.sorted() {
      guard let logins = await ArdiaVaultStore.listedLogins(profile) else { continue }
      listed.profiles.insert(profile)
      for login in logins { listed.keys.insert(ArdiaLoginKey.make(login)) }
    }
    return listed
  }

  private static func readLogins(_ profiles: Set<String>) async -> LoginRead {
    var read = LoginRead()
    for profile in profiles.sorted() {
      guard let entries = await ArdiaVaultStore.secretEntries(profile) else {
        read.failed = true
        continue
      }
      read.profiles.insert(profile)
      for entry in entries {
        guard let realm = entry["realm"] as? String, let username = entry["username"] as? String, let password = entry["password"] as? String,
          !password.isEmpty
        else { continue }
        let origin = ArdiaVault.originOfRealm(realm)
        guard VaultOriginMatch.isWebOrigin(origin) else { continue }
        let key = ArdiaLoginKey.make(ArdiaVaultLogin(profile: profile, origin: origin, username: username))
        if read.logins[key] == nil { read.logins[key] = password }
      }
    }
    return read
  }
}
