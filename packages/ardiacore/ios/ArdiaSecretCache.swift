import Foundation

struct ArdiaSecretCache<Passkey: Equatable & Sendable>: Sendable {
  struct Changes: Equatable, Sendable {
    var codes = false
    var standalone = false
    var passkeys = false
  }

  private(set) var codes: [String: String]?
  private(set) var standalone: [String: ArdiaStandaloneCode]?
  private(set) var passkeys: [String: Passkey]?

  var holdsSecrets: Bool { codes != nil || standalone != nil || passkeys != nil }

  mutating func codes(loading load: () -> [String: String]) -> [String: String] {
    if let codes { return codes }
    let loaded = load()
    codes = loaded
    return loaded
  }

  mutating func standalone(loading load: () -> [String: ArdiaStandaloneCode]) -> [String: ArdiaStandaloneCode] {
    if let standalone { return standalone }
    let loaded = load()
    standalone = loaded
    return loaded
  }

  mutating func passkeys(loading load: () -> [String: Passkey]) -> [String: Passkey] {
    if let passkeys { return passkeys }
    let loaded = load()
    passkeys = loaded
    return loaded
  }

  mutating func keep(codes fresh: [String: String]) { codes = fresh }

  mutating func keep(standalone fresh: [String: ArdiaStandaloneCode]) { standalone = fresh }

  mutating func keep(passkeys fresh: [String: Passkey]) { passkeys = fresh }

  mutating func drop() {
    codes = nil
    standalone = nil
    passkeys = nil
  }

  mutating func refresh(from file: ArdiaVaultFile, passkeys decode: ([String: String]) -> [String: Passkey]) -> Changes {
    var changes = Changes()
    if let held = codes {
      let fresh = file.codes.values
      changes.codes = fresh != held
      codes = fresh
    }
    if let held = standalone {
      let fresh = file.standaloneCodes
      changes.standalone = fresh != held
      standalone = fresh
    }
    if let held = passkeys {
      let fresh = decode(file.passkeys.values)
      changes.passkeys = fresh != held
      passkeys = fresh
    }
    return changes
  }
}
