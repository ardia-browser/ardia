import Foundation

enum VaultGenerated {
  static let provider = "generated"
  static let defaultKeepDays = VaultGeneratedStore.defaultKeepDays
  private static let keepForever = VaultGeneratedStore.keepForever
  private static let keepNone = VaultGeneratedStore.keepNone
  static let longestKeep = 3650
  private static let mostEntries = VaultGeneratedStore.mostEntries
  private static let purgeInterval: TimeInterval = 3600

  private static let queue = DispatchQueue(label: "ardia.vaults.generated", qos: .utility)
  nonisolated(unsafe) private static var purgeTimer: DispatchSourceTimer?
  private static let submitHook: Void = ArdiaWebView.setGeneratedVaultSubmitHandler { password, username, origin in
    VaultGenerated.submitted(password: password, username: username, origin: origin)
  }

  private static let store = VaultGeneratedStore(
    read: { VaultCache.readSealed(VaultGeneratedStore.name) },
    update: { VaultCache.changeSealed(VaultGeneratedStore.name, $0) },
    mergeHeld: { VaultCache.mergeHeld(VaultGeneratedStore.name, $0) },
    legacyFile: VaultCache.managersDirectory?.appendingPathComponent("Generated.vault"),
    legacyKeys: { VaultStoreKey.candidates() },
    now: { Date().timeIntervalSince1970 * 1000 })
  nonisolated(unsafe) private static var legacyChecked = false

  private static func nowMilliseconds() -> Double { Date().timeIntervalSince1970 * 1000 }

  private static func clampedKeepDays(_ days: Int) -> Int {
    if days < 0 { return keepForever }
    return min(days, longestKeep)
  }

  private static func isFor(_ kept: String, origin: String) -> Bool {
    kept == origin || VaultOriginMatch.matches(kept, origin: origin)
  }

  static func installSubmitHook() { submitHook }

  static func keep(password: String, origin: String, replacing previous: String?) {
    guard !password.isEmpty, !origin.isEmpty else { return }
    let created = nowMilliseconds()
    let fresh = VaultGeneratedEntry(id: UUID().uuidString, origin: origin, username: "", password: password, createdAt: created, submitted: false)
    change { file in
      guard file.keepDays != keepNone else { return false }
      if let previous {
        file.entries.removeAll { $0.origin == origin && $0.password == previous && !$0.submitted }
      }
      file.entries.removeAll { $0.origin == origin && $0.password == password }
      file.entries.append(fresh)
      if file.entries.count > mostEntries { file.entries.removeFirst(file.entries.count - mostEntries) }
      return true
    }
  }

  static func submitted(password: String, username: String, origin: String) {
    let name = VaultNewLogin.cleanedUsername(username)
    change { file in
      var changed = false
      for index in file.entries.indices where isFor(file.entries[index].origin, origin: origin) && file.entries[index].password == password {
        file.entries[index].submitted = true
        if !name.isEmpty { file.entries[index].username = name }
        changed = true
      }
      return changed
    }
  }

  static func replacePassword(origin: String, from previous: String, to password: String) {
    guard !password.isEmpty, previous != password else { return }
    change { file in
      var changed = false
      for index in file.entries.indices where isFor(file.entries[index].origin, origin: origin) && file.entries[index].password == previous {
        file.entries[index].password = password
        changed = true
      }
      return changed
    }
  }

  static func saved(password: String, origin: String) {
    guard !password.isEmpty else { return }
    change { file in
      let before = file.entries.count
      file.entries.removeAll { isFor($0.origin, origin: origin) && $0.password == password }
      return file.entries.count != before
    }
  }

  static func delete(id: String) async -> Bool {
    await withCheckedContinuation { done in
      change(
        { file in
          let before = file.entries.count
          file.entries.removeAll { $0.id == id }
          return file.entries.count != before
        }, then: { done.resume(returning: $0) })
    }
  }

  static func setKeepDays(_ days: Int) {
    let keep = clampedKeepDays(days)
    change { file in
      let changed = file.keepDays != keep
      file.keepDays = keep
      return changed
    }
    startPurging()
  }

  static func list() async -> [[String: Any]] {
    await withCheckedContinuation { done in
      queue.async {
        let file = purgedFile()
        done.resume(returning: file.entries.sorted { $0.createdAt > $1.createdAt }.map { $0.jsonObject() })
      }
    }
  }

  static func entry(_ id: String) async -> VaultGeneratedEntry? {
    await withCheckedContinuation { done in
      queue.async { done.resume(returning: purgedFile().entries.first { $0.id == id }) }
    }
  }

  private static func startPurging() {
    queue.async {
      guard purgeTimer == nil else { return }
      let timer = DispatchSource.makeTimerSource(queue: queue)
      timer.schedule(deadline: .now() + purgeInterval, repeating: purgeInterval, leeway: .seconds(60))
      timer.setEventHandler { _ = purgedFile() }
      purgeTimer = timer
      timer.resume()
    }
  }

  private static func change(_ edit: @escaping @Sendable (inout VaultGeneratedFile) -> Bool, then: (@Sendable (Bool) -> Void)? = nil) {
    queue.async {
      migrateLegacy()
      let changed = store.change(edit)
      if changed { announce() }
      then?(changed)
    }
  }

  private static func purgedFile() -> VaultGeneratedFile {
    migrateLegacy()
    if store.change({ _ in false }) { announce() }
    return store.current() ?? VaultGeneratedFile(keepDays: defaultKeepDays, entries: [])
  }

  private static func migrateLegacy() {
    guard !legacyChecked else { return }
    if store.migrateLegacy() != .kept { legacyChecked = true }
  }

  private static func announce() {
    let payload = ArdiaConsentStamp.begin().onto([:])
    DispatchQueue.main.async { ArdiaEvents.emit("vaults.generatedChanged", data: payload) }
  }
}
