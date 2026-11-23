import Foundation

enum VaultCache {
  typealias LocalRead = VaultLocalRead

  private static let lock = NSLock()

  static var managersDirectory: URL? {
    let base: URL
    if let sandbox = VaultSandbox.directory {
      base = URL(fileURLWithPath: sandbox, isDirectory: true)
    } else if let data = LaunchConfig.shared.dataDirectory {
      base = URL(fileURLWithPath: data, isDirectory: true)
    } else if let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
      base = support.appendingPathComponent(Bundle.main.bundleIdentifier ?? "Ardia", isDirectory: true)
    } else {
      return nil
    }
    return base.appendingPathComponent("Password Managers", isDirectory: true)
  }

  private static let folder: VaultSealedFolder? = managersDirectory.map {
    VaultSealedFolder(directory: $0.appendingPathComponent("Cache", isDirectory: true), keys: { VaultStoreKey.candidates() },
                      sealingKey: { VaultStoreKey.current(creating: true) })
  }

  static func storeContext(_ name: String) -> String { VaultSealedFolder.context(name) }

  private static func locked<T>(_ body: (VaultSealedFolder) -> T, otherwise: T) -> T {
    guard let folder else { return otherwise }
    lock.lock()
    defer { lock.unlock() }
    return body(folder)
  }

  static func exists(_ provider: String) -> Bool { locked({ $0.exists(provider) }, otherwise: false) }

  static func load(_ provider: String) -> VaultCacheSnapshot? {
    VaultOffMain.check()
    return readSealed(provider).plain.flatMap(VaultCacheSnapshot.decoded)
  }

  @discardableResult
  static func save(_ provider: String, _ snapshot: VaultCacheSnapshot, toCloud: Bool = true) -> Bool {
    VaultOffMain.check()
    guard let plain = try? JSONEncoder().encode(snapshot) else { return false }
    let saved = updateSealed(provider) { read -> (Data?, Bool) in
      if let held = read.plain, VaultCacheSnapshot.isNewerFormat(held) {
        VaultStoreCounts.note(\.newerFormatKept)
        return (nil, false)
      }
      return (plain, true)
    }
    guard saved, readSealed(provider).plain == plain else { return false }
    if toCloud { VaultCloud.shared.noteLocalChange(provider) }
    return true
  }

  static func delete(_ provider: String, fromCloud: Bool) {
    locked({ $0.delete(provider) }, otherwise: ())
    if fromCloud { VaultCloud.shared.delete(provider) }
  }

  static func reconcile(_ provider: String, account: String?) -> (outcome: VaultCloudOutcome, adopted: VaultCacheSnapshot?) {
    var adopted: VaultCacheSnapshot?
    let outcome = VaultCloud.shared.reconcile(provider) { plains in
      updateSealed(provider) { read -> (Data?, VaultCloudMerge) in
        if let held = read.plain, VaultCacheSnapshot.isNewerFormat(held) { return (nil, .newerFormat) }
        let plan = VaultCacheSnapshot.cloudPlan(local: read.plain.flatMap(VaultCacheSnapshot.decoded), remotes: plains, account: account)
        adopted = plan.local
        let write = plan.local.flatMap { try? JSONEncoder().encode($0) }
        if plan.newerElsewhere { return (write, .newerFormat) }
        return (write, plan.push.flatMap { try? JSONEncoder().encode($0) }.map(VaultCloudMerge.push) ?? .keep)
      }
    }
    return (outcome, adopted)
  }

  static func changeSealed(_ name: String, _ body: (LocalRead) -> (Data?, Bool)) -> Bool {
    guard let folder else { return false }
    lock.lock()
    defer { lock.unlock() }
    return folder.change(name, body)
  }

  static func readSealed(_ name: String) -> LocalRead { locked({ $0.read(name) }, otherwise: .missing) }

  static func updateSealed<T>(_ name: String, _ body: (LocalRead) -> (Data?, T)) -> T {
    guard let folder else { return body(.unreadable).1 }
    lock.lock()
    defer { lock.unlock() }
    return folder.update(name, body)
  }

  static func mergeHeld(_ name: String, _ merge: (_ held: Data, _ current: LocalRead) -> Data?) -> Bool {
    locked({ folder in
      guard let held = folder.heldPlain(name), let merged = merge(held, folder.read(name)), folder.write(name, merged),
        folder.read(name).plain == merged
      else { return false }
      folder.dropHeld(name)
      return true
    }, otherwise: false)
  }

  static func markExcludedFromBackup(_ url: URL) { VaultSealedFolder.excludeFromBackup(url) }
}
