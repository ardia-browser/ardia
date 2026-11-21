import Darwin
import Foundation

struct LegacyInstall: Equatable {
  let owner: String
  let program: String
  let base: String
  let relative: String
  let current: String

  var folder: String { relative.isEmpty ? base : (base as NSString).appendingPathComponent(relative) }
  var launcher: String { "bin/\(program)" }
}

struct ProgramRegistry: Equatable {
  static let infoKey = "ArdiaProgramRegistry"
  static let version = 1
  static let knownLegacyRoots: Set<String> = ["Library/Application Support/Ardia/CLI"]
  static let empty = ProgramRegistry(claims: [:], legacy: [], failClosed: false)

  let claims: [String: String]
  let legacy: [LegacyInstall]
  let failClosed: Bool

  static func isComponent(_ text: String) -> Bool {
    !text.isEmpty && text.count <= 64 && text != "." && text != ".." && !text.contains("/") && !text.contains("\0")
  }

  static func isKnownRoot(_ root: String) -> Bool {
    knownLegacyRoots.contains(root) && root.split(separator: "/", omittingEmptySubsequences: false).allSatisfy { isComponent(String($0)) }
  }

  static func parse(_ value: Any?, home: String) -> ProgramRegistry? {
    guard let doc = value as? [String: Any], (doc["version"] as? NSNumber)?.intValue == version, let claims = doc["claims"] as? [String: String] else { return nil }
    guard claims.allSatisfy({ PluginPrograms.isName($0.key) && PluginPrograms.isName($0.value) }) else { return nil }
    let entries: [[String: Any]]
    if doc["legacyInstalls"] == nil {
      entries = []
    } else if let given = doc["legacyInstalls"] as? [[String: Any]] {
      entries = given
    } else {
      return nil
    }
    var legacy: [LegacyInstall] = []
    for entry in entries {
      guard let owner = entry["owner"] as? String, let program = entry["program"] as? String, let root = entry["root"] as? String, let current = entry["current"] as? String,
        claims[program] == owner, isKnownRoot(root), isComponent(current), !legacy.contains(where: { $0.program == program })
      else { return nil }
      legacy.append(LegacyInstall(owner: owner, program: program, base: home, relative: root, current: current))
    }
    return ProgramRegistry(claims: claims, legacy: legacy, failClosed: false)
  }

  static func claimedPrograms(manifest data: Data) -> [String] {
    guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return [] }
    let programs = ((doc["contributes"] as? [String: Any])?["programs"] ?? doc["programs"]) as? [[String: Any]] ?? []
    return programs.compactMap { entry in entry["claim"] as? Bool == true ? entry["name"] as? String : nil }
  }

  static func derivedClaims(_ bundled: [String: [String]]) -> (claims: [String: String], consistent: Bool) {
    var claims: [String: String] = [:]
    var consistent = true
    for owner in bundled.keys.sorted() {
      for program in bundled[owner] ?? [] {
        guard PluginPrograms.isName(program) else {
          consistent = false
          continue
        }
        if let other = claims[program], other != owner { consistent = false }
        claims[program] = claims[program] ?? owner
      }
    }
    return (claims, consistent)
  }

  static func closed(_ claims: [String: String]) -> ProgramRegistry {
    ProgramRegistry(claims: claims, legacy: [], failClosed: true)
  }

  static func rerooted(_ legacy: [LegacyInstall], at base: String?) -> [LegacyInstall] {
    guard let base, base.hasPrefix("/") else { return [] }
    return legacy.map { LegacyInstall(owner: $0.owner, program: $0.program, base: base, relative: "", current: $0.current) }
  }

  static func agrees(_ registry: ProgramRegistry, with derived: (claims: [String: String], consistent: Bool)) -> Bool {
    derived.consistent && derived.claims.allSatisfy { registry.claims[$0.key] == $0.value }
  }

  static func resolve(
    info: Any?, fixture: Any? = nil, bundled: [String: [String]], hasBundled: Bool, home: String, isolated: Bool, testInstance: Bool, scratchLegacyBase: String?
  ) -> ProgramRegistry {
    let derived = derivedClaims(bundled)
    if let info {
      guard let signed = parse(info, home: home), agrees(signed, with: derived) else {
        return closed((parse(info, home: home)?.claims ?? [:]).merging(derived.claims) { kept, _ in kept })
      }
      return isolated ? ProgramRegistry(claims: signed.claims, legacy: rerooted(signed.legacy, at: scratchLegacyBase), failClosed: false) : signed
    }
    guard testInstance else { return hasBundled || !derived.claims.isEmpty ? closed(derived.claims) : empty }
    if let fixture {
      guard let given = parse(fixture, home: home), agrees(given, with: derived) else { return closed(derived.claims) }
      return ProgramRegistry(claims: given.claims, legacy: rerooted(given.legacy, at: scratchLegacyBase), failClosed: false)
    }
    guard derived.consistent else { return closed(derived.claims) }
    let legacy = derived.claims.keys.sorted().map { LegacyInstall(owner: derived.claims[$0]!, program: $0, base: home, relative: "", current: PluginPrograms.currentName) }
    return ProgramRegistry(claims: derived.claims, legacy: rerooted(legacy, at: scratchLegacyBase), failClosed: false)
  }

  func refusal(program: String, plugin: String, builtIn: Bool) -> String? {
    if failClosed { return "Ardia's list of program names kept for its built-in plugins is missing or damaged, so no program goes on PATH" }
    guard let owner = claims[program] else { return nil }
    return builtIn && owner == plugin ? nil : "\(program) belongs to Ardia's built-in \(owner) plugin"
  }

  func adoption(for plugin: String, programs: [String], builtIn: Bool) -> LegacyInstall? {
    guard builtIn, !failClosed else { return nil }
    return legacy.first { $0.owner == plugin && programs.contains($0.program) }
  }

  var jsonValue: [String: Any] {
    ["claims": claims, "failClosed": failClosed, "legacyOwners": legacy.map(\.owner)]
  }
}
