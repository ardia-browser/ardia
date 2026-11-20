import CryptoKit
import Foundation

enum ArdiaLoginKey {
  static let longest = 8192

  static func make(_ login: ArdiaVaultLogin) -> String {
    Data([login.profile, login.origin, login.username].joined(separator: "\n").utf8).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  static func parse(_ key: String) -> ArdiaVaultLogin? {
    guard !key.isEmpty, key.count <= longest else { return nil }
    var base64 = key.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while base64.count % 4 != 0 { base64.append("=") }
    guard let data = Data(base64Encoded: base64), let text = String(data: data, encoding: .utf8) else { return nil }
    let parts = text.split(separator: "\n", maxSplits: 2, omittingEmptySubsequences: false).map(String.init)
    guard parts.count == 3 else { return nil }
    return ArdiaVaultLogin(profile: parts[0], origin: parts[1], username: parts[2])
  }
}

struct ArdiaVaultFile: Codable, Equatable, Sendable {
  static let currentVersion = 5

  var version = ArdiaVaultFile.currentVersion
  var codes = VaultLedger()
  var logins = VaultLedger()
  var standalone = VaultLedger()
  var passkeys = VaultLedger()
  var device: String?
  var seen: [String: String]?
  var backedUpAt: Double?
  var seenStamps: [String: Int64]?

  init(version: Int = ArdiaVaultFile.currentVersion, codes: VaultLedger = VaultLedger(), logins: VaultLedger = VaultLedger(),
       standalone: VaultLedger = VaultLedger(), passkeys: VaultLedger = VaultLedger(), device: String? = nil) {
    self.version = version
    self.codes = codes
    self.logins = logins
    self.standalone = standalone
    self.passkeys = passkeys
    self.device = device
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    version = try container.decode(Int.self, forKey: .version)
    codes = try container.decodeIfPresent(VaultLedger.self, forKey: .codes) ?? VaultLedger()
    logins = try container.decodeIfPresent(VaultLedger.self, forKey: .logins) ?? VaultLedger()
    standalone = try container.decodeIfPresent(VaultLedger.self, forKey: .standalone) ?? VaultLedger()
    passkeys = try container.decodeIfPresent(VaultLedger.self, forKey: .passkeys) ?? VaultLedger()
    device = try container.decodeIfPresent(String.self, forKey: .device)
    seen = try container.decodeIfPresent([String: String].self, forKey: .seen)
    backedUpAt = try container.decodeIfPresent(Double.self, forKey: .backedUpAt)
    seenStamps = try container.decodeIfPresent([String: Int64].self, forKey: .seenStamps)
  }

  var shared: ArdiaVaultFile {
    ArdiaVaultFile(version: ArdiaVaultFile.currentVersion, codes: codes, logins: logins, standalone: standalone, passkeys: passkeys)
  }

  var isNewerFormat: Bool { version > Self.currentVersion }

  static func isNewerFormat(_ plain: Data) -> Bool { (VaultFormatVersion.of(plain) ?? 0) > currentVersion }

  var standaloneCodes: [String: ArdiaStandaloneCode] { ArdiaStandaloneCode.decodedAll(standalone.values) }

  var isEmpty: Bool { codes.entries.isEmpty && logins.entries.isEmpty && standalone.entries.isEmpty && passkeys.entries.isEmpty }

  @discardableResult
  mutating func merge(_ other: ArdiaVaultFile) -> Bool {
    let codesChanged = codes.merge(other.codes)
    let loginsChanged = logins.merge(other.logins)
    let standaloneChanged = standalone.merge(other.standalone)
    let passkeysChanged = passkeys.merge(other.passkeys)
    return codesChanged || loginsChanged || standaloneChanged || passkeysChanged
  }

  static func decode(_ plain: Data, device: String, now: Double) -> ArdiaVaultFile? {
    if var file = try? JSONDecoder().decode(ArdiaVaultFile.self, from: plain), file.version >= 3 {
      file.version = max(file.version, currentVersion)
      return file
    }
    guard let old = try? JSONDecoder().decode(VaultCacheSnapshot.self, from: plain) else { return nil }
    var file = ArdiaVaultFile(device: device)
    let stampedAt = old.savedAt.isFinite && old.savedAt > 0 ? min(old.savedAt, now) : now
    for (key, code) in old.totps ?? [:] where !code.value.isEmpty {
      file.codes.set(key, code.value, at: stampedAt, device: device)
    }
    return file
  }
}

struct ArdiaRestoreItem: Equatable, Sendable {
  var source: String
  var target: ArdiaVaultLogin
  var password: String
  var code: String?

  var targetKey: String { ArdiaLoginKey.make(target) }
}

enum ArdiaVaultBackupPlan {
  struct CloudPlan {
    var local: ArdiaVaultFile
    var changed: Bool
    var push: ArdiaVaultFile?
    var newerElsewhere: Bool
  }

  static func cloudPlan(local: ArdiaVaultFile, storedMissing: Bool, remotes: [Data], now: Double) -> CloudPlan {
    var remote = ArdiaVaultFile()
    for plain in remotes {
      if let each = ArdiaVaultFile.decode(plain, device: "", now: now) { remote.merge(each) }
    }
    var merged = local
    merged.merge(remote)
    let changed = merged != local || storedMissing && !merged.isEmpty
    let newer = remotes.contains(where: ArdiaVaultFile.isNewerFormat)
    let push = !newer && !merged.isEmpty && (remotes.count != 1 || merged.shared != remote.shared) ? merged.shared : nil
    return CloudPlan(local: merged, changed: changed, push: push, newerElsewhere: newer)
  }

  static func fingerprint(_ password: String) -> String {
    SHA256.hash(data: Data(password.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  @discardableResult
  static func noteLocal(_ file: inout ArdiaVaultFile, read profiles: Set<String>, local: [String: String], now: Double, device: String) -> Bool {
    var seen = file.seen ?? [:]
    var stamps = file.seenStamps ?? [:]
    var changed = false
    for (key, password) in local {
      guard let login = ArdiaLoginKey.parse(key), profiles.contains(login.profile), !password.isEmpty else { continue }
      let print = fingerprint(password)
      let before = seen[key]
      seen[key] = print
      if before != print { changed = true }
      let known = file.logins.entries[key] != nil
      let editedHere = before != nil && before != print
      if file.logins.value(key) != password {
        guard !known || editedHere else { continue }
        if file.logins.set(key, password, at: now, device: device) { changed = true }
      }
      if let stamp = file.logins.entries[key]?.stamp, stamps[key] != stamp {
        stamps[key] = stamp
        changed = true
      }
    }
    var gone: [String: [String]] = [:]
    var known: [String: Int] = [:]
    for key in seen.keys {
      guard let login = ArdiaLoginKey.parse(key), profiles.contains(login.profile) else { continue }
      known[login.profile, default: 0] += 1
      if local[key] == nil { gone[login.profile, default: []].append(key) }
    }
    for (profile, keys) in gone where !looksWiped(missing: keys.count, of: known[profile] ?? 0) {
      for key in keys {
        seen[key] = nil
        stamps[key] = nil
        file.logins.set(key, nil, at: now, device: device)
      }
      changed = true
    }
    file.seen = seen
    file.seenStamps = stamps
    return changed
  }

  static func updatePlan(_ file: ArdiaVaultFile, present: [String: String]) -> [ArdiaRestoreItem] {
    var items: [ArdiaRestoreItem] = []
    for (key, password) in present {
      guard let entry = file.logins.entries[key], let newer = entry.value, !newer.isEmpty, newer != password,
        file.seen?[key] == fingerprint(password), let known = file.seenStamps?[key], entry.stamp > known,
        let login = ArdiaLoginKey.parse(key)
      else { continue }
      items.append(ArdiaRestoreItem(source: key, target: login, password: newer, code: nil))
    }
    return items.sorted { ($0.target.origin, $0.target.username, $0.target.profile) < ($1.target.origin, $1.target.username, $1.target.profile) }
  }

  static func updatableCount(_ file: ArdiaVaultFile, present: Set<String>) -> Int {
    file.logins.entries.filter { key, entry in
      guard present.contains(key), let newer = entry.value, !newer.isEmpty, let known = file.seenStamps?[key], entry.stamp > known,
        let seen = file.seen?[key]
      else { return false }
      return seen != fingerprint(newer)
    }.count
  }

  static func noteUpdated(_ file: inout ArdiaVaultFile, _ item: ArdiaRestoreItem) {
    file.seen = (file.seen ?? [:]).merging([item.source: fingerprint(item.password)]) { $1 }
    if let stamp = file.logins.entries[item.source]?.stamp {
      file.seenStamps = (file.seenStamps ?? [:]).merging([item.source: stamp]) { $1 }
    }
  }

  static let wipeFloor = 3

  static func looksWiped(missing: Int, of known: Int) -> Bool {
    missing > wipeFloor && missing * 2 > known
  }

  static func restorePlan(_ file: ArdiaVaultFile, profiles: Set<String>, present: Set<String>) -> [ArdiaRestoreItem] {
    var chosen: [String: (item: ArdiaRestoreItem, exact: Bool, stamp: Int64)] = [:]
    for (key, entry) in file.logins.entries {
      guard let password = entry.value, !password.isEmpty, let source = ArdiaLoginKey.parse(key) else { continue }
      var target = source
      if !profiles.contains(source.profile) { target.profile = "" }
      let targetKey = ArdiaLoginKey.make(target)
      guard !present.contains(targetKey), !file.logins.isRemoved(targetKey) else { continue }
      let exact = target.profile == source.profile
      let item = ArdiaRestoreItem(source: key, target: target, password: password, code: file.codes.value(key) ?? file.codes.value(targetKey))
      if let held = chosen[targetKey] {
        let better = exact != held.exact ? exact : entry.stamp > held.stamp || (entry.stamp == held.stamp && key > held.item.source)
        guard better else { continue }
      }
      chosen[targetKey] = (item, exact, entry.stamp)
    }
    return chosen.values.map(\.item).sorted { ($0.target.origin, $0.target.username, $0.target.profile) < ($1.target.origin, $1.target.username, $1.target.profile) }
  }

  @discardableResult
  static func noteRestored(_ file: inout ArdiaVaultFile, _ item: ArdiaRestoreItem, now: Double, device: String) -> Bool {
    let key = item.targetKey
    var seen = file.seen ?? [:]
    seen[key] = fingerprint(item.password)
    file.seen = seen
    var changed = true
    if key != item.source {
      changed = file.logins.set(key, item.password, at: now, device: device) || changed
      if let code = item.code { file.codes.set(key, code, at: now, device: device) }
    }
    if let stamp = file.logins.entries[key]?.stamp { file.seenStamps = (file.seenStamps ?? [:]).merging([key: stamp]) { $1 } }
    return changed
  }
}
