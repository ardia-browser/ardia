import CryptoKit
import Foundation

struct VaultGeneratedEntry: Codable, Equatable, Sendable {
  var id: String
  var origin: String
  var username: String
  var password: String
  var createdAt: Double
  var submitted: Bool

  func jsonObject() -> [String: Any] {
    ["id": id, "origin": origin, "username": username, "createdAt": createdAt, "submitted": submitted]
  }
}

struct VaultGeneratedFile: Codable, Equatable, Sendable {
  static let currentVersion = 1

  var version = VaultGeneratedFile.currentVersion
  var keepDays: Int
  var entries: [VaultGeneratedEntry]
}

struct VaultGeneratedStore: Sendable {
  static let name = "generated"
  static let defaultKeepDays = 7
  static let keepForever = -1
  static let keepNone = 0
  static let mostEntries = 200
  private static let millisecondsPerDay = 86_400_000.0

  let read: @Sendable () -> VaultLocalRead
  let update: @Sendable ((VaultLocalRead) -> (Data?, Bool)) -> Bool
  let mergeHeld: @Sendable ((Data, VaultLocalRead) -> Data?) -> Bool
  let legacyFile: URL?
  let legacyKeys: @Sendable () -> [SymmetricKey]
  let now: @Sendable () -> Double

  static func isExpired(_ entry: VaultGeneratedEntry, keepDays: Int, now: Double) -> Bool {
    if keepDays == keepNone { return true }
    if keepDays < 0 { return false }
    return now - entry.createdAt >= Double(keepDays) * millisecondsPerDay
  }

  static func decode(_ read: VaultLocalRead) -> VaultGeneratedFile? {
    guard let plain = read.plain else { return read.isMissing ? VaultGeneratedFile(keepDays: defaultKeepDays, entries: []) : nil }
    guard let file = try? JSONDecoder().decode(VaultGeneratedFile.self, from: plain), file.version == VaultGeneratedFile.currentVersion else { return nil }
    return file
  }

  static func merge(_ entries: [VaultGeneratedEntry], into file: inout VaultGeneratedFile) {
    let known = Set(file.entries.map(\.id))
    file.entries += entries.filter { !known.contains($0.id) }
    file.entries.sort { $0.createdAt < $1.createdAt }
    if file.entries.count > mostEntries { file.entries.removeFirst(file.entries.count - mostEntries) }
  }

  func current() -> VaultGeneratedFile? { Self.decode(read()) }

  @discardableResult
  func change(_ edit: (inout VaultGeneratedFile) -> Bool) -> Bool {
    _ = mergeHeld { held, read in
      guard let recovered = try? JSONDecoder().decode(VaultGeneratedFile.self, from: held), var file = Self.decode(read) else { return nil }
      Self.merge(recovered.entries, into: &file)
      return try? JSONEncoder().encode(file)
    }
    let now = now()
    return update { read -> (Data?, Bool) in
      if read.plain != nil, Self.decode(read) == nil {
        VaultStoreCounts.note(\.newerFormatKept)
        return (nil, false)
      }
      var file = Self.decode(read) ?? VaultGeneratedFile(keepDays: Self.defaultKeepDays, entries: [])
      let before = file.entries.count
      file.entries.removeAll { Self.isExpired($0, keepDays: file.keepDays, now: now) || $0.password.isEmpty }
      let purged = file.entries.count != before
      let edited = edit(&file)
      if file.keepDays == Self.keepNone { file.entries = [] }
      guard purged || edited else { return (nil, false) }
      return (try? JSONEncoder().encode(file), true)
    }
  }

  enum Migration: Equatable {
    case nothing
    case moved
    case kept
  }

  func migrateLegacy() -> Migration {
    guard let legacyFile else { return .nothing }
    guard case .read(let sealed) = VaultSealedFolder.contents(of: legacyFile) else {
      return FileManager.default.fileExists(atPath: legacyFile.path) ? .kept : .nothing
    }
    guard let plain = VaultSealed.openLegacy(sealed, keys: legacyKeys()), let legacy = try? JSONDecoder().decode(VaultGeneratedFile.self, from: plain) else {
      NSLog("[vaults] the old generated passwords file didn't open yet; it's kept as is")
      return .kept
    }
    let now = now()
    let wanted = Set(legacy.entries.filter { !Self.isExpired($0, keepDays: legacy.keepDays, now: now) && !$0.password.isEmpty }.suffix(Self.mostEntries).map(\.id))
    change { file in
      Self.merge(legacy.entries, into: &file)
      file.keepDays = legacy.keepDays
      return true
    }
    guard let moved = current(), wanted.isSubset(of: Set(moved.entries.map(\.id))) else { return .kept }
    try? FileManager.default.removeItem(at: legacyFile)
    VaultStoreCounts.note(\.legacyMigrated)
    NSLog("[vaults] moved the generated passwords to the bound format")
    return .moved
  }
}
