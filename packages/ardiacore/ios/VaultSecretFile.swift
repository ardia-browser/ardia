import CryptoKit
import Foundation

final class VaultSecretFile: VaultSecretBackend, @unchecked Sendable {
  static let sealedName = "Keychain.sealed"
  static let keyName = "Keychain.key"
  static let sealContext = "keychain"
  private static let keyLength = 32

  let directory: URL
  private let plainImport: URL?
  private let lock = NSLock()
  private var loaded: [String: String]?
  private var plainSettled = false

  init(directory: URL, plainImport: URL? = nil) {
    self.directory = directory
    self.plainImport = plainImport
  }

  var sealedFile: URL { directory.appendingPathComponent(Self.sealedName) }
  var keyFile: URL { directory.appendingPathComponent(Self.keyName) }

  func listAccounts() -> Set<String>? { withSecrets { Set($0.keys) } }

  func exists(_ account: String) -> Bool? { withSecrets { $0[account] != nil } }

  func value(_ account: String) -> String? { withSecrets { $0[account] } ?? nil }

  func store(_ account: String, _ secret: String) -> Bool { change { $0[account] = secret } }

  func remove(_ account: String) -> Bool { change { $0[account] = nil } }

  private func withSecrets<T>(_ body: ([String: String]) -> T) -> T? {
    lock.lock()
    defer { lock.unlock() }
    guard let secrets = load() else { return nil }
    settlePlain(secrets)
    return body(secrets)
  }

  private func change(_ body: (inout [String: String]) -> Void) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard var secrets = load() else { return false }
    settlePlain(secrets)
    let before = secrets
    body(&secrets)
    if secrets == before { return true }
    guard persist(secrets) else { return false }
    loaded = secrets
    return true
  }

  private func load() -> [String: String]? {
    if let loaded { return loaded }
    switch VaultSealedFolder.contents(of: sealedFile) {
    case .failed:
      return nil
    case .missing:
      guard let plainImport else {
        loaded = [:]
        return [:]
      }
      switch VaultSealedFolder.contents(of: plainImport) {
      case .failed:
        return nil
      case .missing:
        loaded = [:]
        return [:]
      case .read(let data):
        let imported = (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:]
        if !imported.isEmpty {
          guard persist(imported) else { return nil }
        }
        loaded = imported
        return imported
      }
    case .read(let sealed):
      if VaultSealed.isNewerFormat(sealed) {
        VaultStoreCounts.note(\.newerFormatKept)
        return nil
      }
      switch readKey() {
      case .failed:
        return nil
      case .missing:
        guard setAside() else { return nil }
        loaded = [:]
        return [:]
      case .found(let key):
        let plain: Data?
        switch VaultSealed.open(sealed, keys: [key], context: Self.sealContext) {
        case .opened(let opened, _): plain = opened
        case .unknownKey, .corrupt: plain = VaultSealed.isLegacy(sealed) ? VaultSealed.openLegacy(sealed, keys: [key]) : nil
        }
        guard let plain, let secrets = try? JSONDecoder().decode([String: String].self, from: plain) else {
          guard setAside() else { return nil }
          loaded = [:]
          return [:]
        }
        if VaultSealed.isLegacy(sealed), persist(secrets) { VaultStoreCounts.note(\.legacyMigrated) }
        loaded = secrets
        return secrets
      }
    }
  }

  private func settlePlain(_ secrets: [String: String]) {
    guard !plainSettled, let plainImport else { return }
    switch VaultSealedFolder.contents(of: plainImport) {
    case .missing:
      plainSettled = true
    case .failed:
      return
    case .read(let data):
      let plain = (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:]
      guard !plain.isEmpty, plain.allSatisfy({ secrets[$0.key] == $0.value }) else {
        plainSettled = true
        return
      }
      plainSettled = (try? FileManager.default.removeItem(at: plainImport)) != nil
    }
  }

  private func setAside() -> Bool {
    var aside = directory.appendingPathComponent(Self.sealedName + ".unreadable")
    var attempt = 1
    while FileManager.default.fileExists(atPath: aside.path) {
      attempt += 1
      aside = directory.appendingPathComponent(Self.sealedName + ".unreadable-\(attempt)")
    }
    return (try? FileManager.default.moveItem(at: sealedFile, to: aside)) != nil
  }

  private func persist(_ secrets: [String: String]) -> Bool {
    guard prepareDirectory(), let key = usableKey(), let plain = try? JSONEncoder().encode(secrets),
      let sealed = VaultSealed.seal(plain, with: key, context: Self.sealContext)
    else { return false }
    guard VaultSealedFolder.writeDurably(sealed, to: sealedFile).installed else { return false }
    excludeFromBackup(sealedFile)
    return true
  }

  private func prepareDirectory() -> Bool {
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      return true
    } catch {
      return false
    }
  }

  private enum KeyRead {
    case found(SymmetricKey)
    case missing
    case failed
  }

  private func readKey() -> KeyRead {
    switch VaultSealedFolder.contents(of: keyFile) {
    case .missing: return .missing
    case .failed: return .failed
    case .read(let data): return data.count == Self.keyLength ? .found(SymmetricKey(data: data)) : .failed
    }
  }

  private func usableKey() -> SymmetricKey? {
    switch readKey() {
    case .found(let key): return key
    case .failed: return nil
    case .missing: return createKey()
    }
  }

  private func createKey() -> SymmetricKey? {
    let fresh = SymmetricKey(size: .bits256)
    let bytes = fresh.withUnsafeBytes { Data($0) }
    guard VaultSealedFolder.writeNew(bytes, to: keyFile) else {
      if case .found(let key) = readKey() { return key }
      return nil
    }
    excludeFromBackup(keyFile)
    return fresh
  }

  private func excludeFromBackup(_ url: URL) {
    var target = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? target.setResourceValues(values)
  }
}
