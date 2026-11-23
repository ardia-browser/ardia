import CryptoKit
import Foundation

enum VaultLocalRead: Equatable, Sendable {
  case missing
  case opened(Data)
  case unreadable

  var plain: Data? {
    if case .opened(let plain) = self { return plain }
    return nil
  }

  var isMissing: Bool { self == .missing }
}

struct VaultSealedFolder: Sendable {
  static let boundSuffix = ".bound"
  static let legacySuffix = ".legacy"

  let directory: URL
  let keys: @Sendable () -> [SymmetricKey]
  let sealingKey: @Sendable () -> SymmetricKey?

  static func context(_ name: String) -> String { "store/\(name)" }

  func file(_ name: String, _ suffix: String = "") -> URL { directory.appendingPathComponent("\(name).vault\(suffix)") }

  func exists(_ name: String) -> Bool { FileManager.default.fileExists(atPath: file(name).path) }

  func read(_ name: String) -> VaultLocalRead {
    if let migrated = migrateLegacy(name) { return migrated }
    let keys = keys()
    let main = Self.contents(of: file(name))
    var unreadable = false
    switch main {
    case .missing: break
    case .failed: unreadable = true
    case .read(let sealed):
      switch VaultSealed.open(sealed, keys: keys, context: Self.context(name)) {
      case .opened(let plain, let current):
        if !current, write(name, plain) { VaultStoreCounts.note(\.resealed) }
        return .opened(plain)
      case .unknownKey: unreadable = true
      case .corrupt:
        if VaultSealed.isNewerFormat(sealed) {
          VaultStoreCounts.note(\.newerFormatKept)
          unreadable = true
        } else if Self.isDamaged(sealed) {
          unreadable = true
        }
      }
    }
    switch Self.contents(of: file(name, ".bak")) {
    case .missing: break
    case .failed: unreadable = true
    case .read(let sealed):
      switch VaultSealed.open(sealed, keys: keys, context: Self.context(name)) {
      case .opened(let plain, _):
        NSLog("[vaults] the %@ store didn't open; using its backup copy", name)
        return .opened(plain)
      case .unknownKey: unreadable = true
      case .corrupt: if Self.isDamaged(sealed) || VaultSealed.isNewerFormat(sealed) { unreadable = true }
      }
    }
    return unreadable ? .unreadable : .missing
  }

  private static func isDamaged(_ sealed: Data) -> Bool { sealed.starts(with: VaultSealed.magic) }

  @discardableResult
  func write(_ name: String, _ plain: Data) -> Bool {
    guard let key = sealingKey(), let sealed = VaultSealed.seal(plain, with: key, context: Self.context(name)) else {
      NSLog("[vaults] couldn't seal the %@ store: no key", name)
      return false
    }
    guard prepare() else { return false }
    let url = file(name)
    switch Self.contents(of: url) {
    case .missing: break
    case .failed:
      NSLog("[vaults] the %@ store couldn't be read, so it isn't replaced", name)
      VaultStoreCounts.note(\.unreadableKept)
      return false
    case .read(let existing):
      switch VaultSealed.open(existing, keys: keys(), context: Self.context(name)) {
      case .opened:
        guard rename(url.path, file(name, ".bak").path) == 0 else { return false }
      case .unknownKey:
        guard !FileManager.default.fileExists(atPath: file(name, ".held").path) else {
          NSLog("[vaults] the %@ store is sealed with a key this Mac lacks and one copy is already held, so it isn't replaced", name)
          VaultStoreCounts.note(\.unreadableKept)
          return false
        }
        guard rename(url.path, file(name, ".held").path) == 0 else { return false }
      case .corrupt:
        if VaultSealed.isNewerFormat(existing) {
          NSLog("[vaults] the %@ store was written by a newer Ardia, so it isn't replaced", name)
          VaultStoreCounts.note(\.newerFormatKept)
          return false
        }
        if VaultSealed.isLegacy(existing), !isBound(name) {
          NSLog("[vaults] the %@ store is in the old format and didn't open, so it isn't replaced", name)
          return false
        }
        guard setAside(name) else { return false }
      }
    }
    guard Self.writeDurably(sealed, to: url).installed else { return false }
    bind(name)
    Self.excludeFromBackup(url)
    return true
  }

  func update<T>(_ name: String, _ body: (VaultLocalRead) -> (Data?, T)) -> T {
    let (plain, result) = body(read(name))
    if let plain { write(name, plain) }
    return result
  }

  func change(_ name: String, _ body: (VaultLocalRead) -> (Data?, Bool)) -> Bool {
    let (plain, changed) = body(read(name))
    guard let plain else { return changed }
    return write(name, plain) && changed
  }

  func heldPlain(_ name: String) -> Data? {
    guard case .read(let sealed) = Self.contents(of: file(name, ".held")),
      case .opened(let plain, _) = VaultSealed.open(sealed, keys: keys(), context: Self.context(name))
    else { return nil }
    return plain
  }

  func dropHeld(_ name: String) { try? FileManager.default.removeItem(at: file(name, ".held")) }

  func delete(_ name: String) {
    for suffix in ["", ".bak", ".held", Self.legacySuffix] { try? FileManager.default.removeItem(at: file(name, suffix)) }
    for aside in asideFiles(name) { try? FileManager.default.removeItem(at: aside) }
  }

  static let asideSuffix = ".aside-"
  static let mostAside = 8

  func asideFiles(_ name: String) -> [URL] {
    let prefix = "\(name).vault\(Self.asideSuffix)"
    let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
    return names.compactMap { file -> (Int, URL)? in
      guard file.hasPrefix(prefix), let number = Int(file.dropFirst(prefix.count)) else { return nil }
      return (number, directory.appendingPathComponent(file))
    }.sorted { $0.0 < $1.0 }.map(\.1)
  }

  private func setAside(_ name: String) -> Bool {
    let held = asideFiles(name)
    let next = (held.last.flatMap { Int($0.lastPathComponent.dropFirst("\(name).vault\(Self.asideSuffix)".count)) } ?? 0) + 1
    guard rename(file(name).path, file(name, "\(Self.asideSuffix)\(next)").path) == 0 else { return false }
    for old in held.dropLast(Self.mostAside - 1) { try? FileManager.default.removeItem(at: old) }
    VaultStoreCounts.note(\.setAside)
    NSLog("[vaults] set aside a %@ store file this build can't open", name)
    return true
  }

  func isBound(_ name: String) -> Bool { FileManager.default.fileExists(atPath: file(name, Self.boundSuffix).path) }

  private func bind(_ name: String) {
    let url = file(name, Self.boundSuffix)
    guard !FileManager.default.fileExists(atPath: url.path) else { return }
    _ = Self.writeDurably(Data(), to: url)
  }

  private func migrateLegacy(_ name: String) -> VaultLocalRead? {
    guard !isBound(name) else { return nil }
    let main = file(name)
    let parked = file(name, Self.legacySuffix)
    let source: URL
    if case .read(let sealed) = Self.contents(of: main), VaultSealed.isLegacy(sealed) {
      source = main
    } else if FileManager.default.fileExists(atPath: parked.path), !FileManager.default.fileExists(atPath: main.path) {
      source = parked
    } else {
      return nil
    }
    guard case .read(let sealed) = Self.contents(of: source), let plain = VaultSealed.openLegacy(sealed, keys: keys()) else {
      NSLog("[vaults] the %@ store is in the old format and didn't open yet", name)
      return .unreadable
    }
    guard let key = sealingKey(), let resealed = VaultSealed.seal(plain, with: key, context: Self.context(name)), prepare() else {
      return .opened(plain)
    }
    if source == main {
      try? FileManager.default.removeItem(at: parked)
      guard rename(main.path, parked.path) == 0 else { return .opened(plain) }
    }
    let written = Self.writeDurably(resealed, to: main)
    guard written.installed, case .read(let back) = Self.contents(of: main),
      VaultSealed.open(back, keys: [key], context: Self.context(name)).plain == plain
    else {
      try? FileManager.default.removeItem(at: main)
      _ = rename(parked.path, main.path)
      return .opened(plain)
    }
    guard written == .durable else {
      NSLog("[vaults] the %@ store moved to the bound format but its folder didn't sync, so the old copy is kept", name)
      return .opened(plain)
    }
    bind(name)
    Self.excludeFromBackup(main)
    try? FileManager.default.removeItem(at: parked)
    VaultStoreCounts.note(\.legacyMigrated)
    NSLog("[vaults] moved the %@ store to the bound format", name)
    return .opened(plain)
  }

  private func prepare() -> Bool {
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      Self.excludeFromBackup(directory)
      return true
    } catch {
      NSLog("[vaults] couldn't make the store folder: %@", error.localizedDescription)
      return false
    }
  }

  enum Contents: Equatable {
    case missing
    case read(Data)
    case failed
  }

  static func contents(of url: URL) -> Contents {
    do {
      return .read(try Data(contentsOf: url))
    } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
      return .missing
    } catch let error as NSError where error.domain == NSPOSIXErrorDomain && error.code == Int(ENOENT) {
      return .missing
    } catch {
      return FileManager.default.fileExists(atPath: url.path) ? .failed : .missing
    }
  }

  enum Written: Equatable {
    case durable
    case installedUnsynced
    case failed

    var installed: Bool { self != .failed }
  }

  static func writeDurably(_ data: Data, to url: URL) -> Written {
    let temporary = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString)")
    let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard descriptor >= 0 else { return .failed }
    let written = data.withUnsafeBytes { bytes -> Int in
      var offset = 0
      while offset < bytes.count {
        let count = Foundation.write(descriptor, bytes.baseAddress! + offset, bytes.count - offset)
        if count < 0, errno == EINTR { continue }
        if count <= 0 { return -1 }
        offset += count
      }
      return offset
    }
    let synced = Self.flush(descriptor)
    close(descriptor)
    guard written == data.count, synced, rename(temporary.path, url.path) == 0 else {
      unlink(temporary.path)
      return .failed
    }
    return syncFolder(of: url) ? .durable : .installedUnsynced
  }

  static func syncFolder(of url: URL) -> Bool {
    let folder = open(url.deletingLastPathComponent().path, O_RDONLY | O_CLOEXEC)
    guard folder >= 0 else { return false }
    defer { close(folder) }
    return fsync(folder) == 0
  }

  static func flush(_ descriptor: Int32) -> Bool {
    fcntl(descriptor, F_FULLFSYNC) == 0 || fsync(descriptor) == 0
  }

  static func writeNew(_ data: Data, to url: URL) -> Bool {
    let descriptor = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard descriptor >= 0 else { return false }
    let written = data.withUnsafeBytes { Foundation.write(descriptor, $0.baseAddress, $0.count) }
    let synced = flush(descriptor)
    close(descriptor)
    guard written == data.count, synced else {
      unlink(url.path)
      return false
    }
    return true
  }

  static func excludeFromBackup(_ url: URL) {
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    var marked = url
    try? marked.setResourceValues(values)
  }
}

struct VaultStoreCounts: Equatable, Sendable {
  var legacyMigrated = 0
  var newerFormatKept = 0
  var unreadableKept = 0
  var keyReadFailed = 0
  var staleWorkDropped = 0
  var resealed = 0
  var setAside = 0
  var keyNotNoted = 0
  var cloudNewerFormatKept = 0

  private static let lock = NSLock()
  nonisolated(unsafe) private static var held = VaultStoreCounts()

  static func note(_ field: WritableKeyPath<VaultStoreCounts, Int>) {
    lock.withLock { held[keyPath: field] += 1 }
  }

  static func take() -> VaultStoreCounts {
    lock.withLock {
      defer { held = VaultStoreCounts() }
      return held
    }
  }
}
