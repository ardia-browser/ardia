import Foundation

struct OfficialLegacyInstall: Equatable {
  let program: String
  let root: String
  let current: String
}

struct OfficialPinEntry: Equatable {
  let name: String
  let version: String
  let url: URL
  let sha256: String
  let reservedPrograms: [String]
  let legacyInstall: OfficialLegacyInstall?
  var trustedArtifacts: Set<String> = []
  var bundledDigests: Set<String> = []
  var credentialPrograms: [String] = []
  var title = ""
  var blurb = ""
  var icon = ""
  var symbol = ""
  var accent = ""

  var folderId: String { OfficialPin.folderId(sha256) }

  func trusts(_ sha: String) -> Bool { sha == sha256 || trustedArtifacts.contains(sha) }
  var file: String { url.lastPathComponent }
}

struct OfficialPin: Equatable {
  static let infoKey = "ArdiaOfficialPlugins"
  static let version = 1
  static let platform = "macos-arm64"
  static let pinFixtureKey = "officialPin"
  static let sourceKey = "officialPluginsFrom"
  static let folderPrefix = "official-"
  static let legacyFolderId = "bundled"
  static let maxEntries = 16
  static let maxTrusted = 256
  private static let versionPattern = try! NSRegularExpression(pattern: "^[0-9]{1,4}\\.[0-9]{1,4}\\.[0-9]{1,4}(-[a-z]{1,16}\\.[0-9]{1,4})?$")
  private static let shaPattern = try! NSRegularExpression(pattern: "^[0-9a-f]{64}$")

  let entries: [OfficialPinEntry]
  var reservedProviders: [String: String] = [:]
  var ownerTitles: [String: String] = [:]

  func credentialRefusal(name: String, official: Bool, program: String?) -> String? {
    if !official {
      if let owner = providerTitle(name) { return "\(name) is kept for Ardia's official \(owner) plugin." }
      return program == nil ? nil : "Ardia runs password managers only from its official plugins."
    }
    guard let program else { return nil }
    guard reservedProviders[name] == name, let entry = entry(name) else { return "Ardia runs password managers only from its official plugins." }
    return entry.credentialPrograms.contains(program) ? nil : "\(program) isn't a program this plugin may run."
  }

  func providerTitle(_ name: String) -> String? {
    guard let owner = reservedProviders[name] else { return nil }
    let title = ownerTitles[owner] ?? ""
    return title.isEmpty ? owner : title
  }

  var providerTitles: [String: String] {
    Dictionary(uniqueKeysWithValues: reservedProviders.keys.compactMap { name in providerTitle(name).map { (name, $0) } })
  }

  static func folderId(_ sha256: String) -> String { folderPrefix + sha256 }

  private static func label(_ value: Any?, limit: Int) -> String {
    guard let text = value as? String, text.count <= limit, !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return "" }
    return text
  }

  private static func accent(_ value: Any?) -> String {
    let text = label(value, limit: 7)
    return text.range(of: "^#[0-9A-Fa-f]{6}$", options: .regularExpression) == nil ? "" : text
  }

  static func sha(ofFolderId folderId: String) -> String? {
    guard folderId.hasPrefix(folderPrefix) else { return nil }
    let sha = String(folderId.dropFirst(folderPrefix.count))
    return isSha(sha) ? sha : nil
  }

  static func isSha(_ text: String) -> Bool { matches(shaPattern, text) }

  static func isVersion(_ text: String) -> Bool { matches(versionPattern, text) }

  private static func matches(_ pattern: NSRegularExpression, _ text: String) -> Bool {
    let whole = NSRange(text.startIndex..., in: text)
    return pattern.firstMatch(in: text, range: whole)?.range == whole
  }

  func entry(_ name: String) -> OfficialPinEntry? { entries.first { $0.name == name } }

  static func parse(_ value: Any?) -> OfficialPin? {
    guard let doc = value as? [String: Any], (doc["version"] as? NSNumber)?.intValue == version, let plugins = doc["plugins"] as? [[String: Any]], plugins.count <= maxEntries
    else { return nil }
    var entries: [OfficialPinEntry] = []
    var reserved: Set<String> = []
    var providers: [String: String] = [:]
    var ownerTitles: [String: String] = [:]
    for plugin in plugins {
      guard let owner = plugin["name"] as? String else { return nil }
      ownerTitles[owner] = label(plugin["title"], limit: 60)
      let names = plugin["reservedProviders"] as? [String] ?? []
      guard plugin["reservedProviders"] == nil || plugin["reservedProviders"] is [String], names.allSatisfy(PluginPrograms.isName) else { return nil }
      for name in names {
        guard providers[name] == nil || providers[name] == owner else { return nil }
        providers[name] = owner
      }
    }
    for plugin in plugins {
      guard let name = plugin["name"] as? String, PluginPrograms.isName(name), !entries.contains(where: { $0.name == name }),
        let version = plugin["version"] as? String, isVersion(version), let release = plugin["release"] as? String
      else { return nil }
      let programs = plugin["reservedPrograms"] as? [String] ?? []
      guard plugin["reservedPrograms"] == nil || plugin["reservedPrograms"] is [String], programs.allSatisfy(PluginPrograms.isName), Set(programs).count == programs.count
      else { return nil }
      let credentialPrograms = plugin["credentialPrograms"] as? [String] ?? []
      guard plugin["credentialPrograms"] == nil || plugin["credentialPrograms"] is [String], credentialPrograms.allSatisfy(PluginPrograms.isName),
        credentialPrograms.count <= 4
      else { return nil }
      guard let artifact = (plugin["artifacts"] as? [String: Any])?[platform] as? [String: Any], let file = artifact["file"] as? String, let sha = artifact["sha256"] as? String else { continue }
      guard isSha(sha), ProgramRegistry.isComponent(file), let url = URL(string: release + "/" + file), url.scheme == "https", url.host?.isEmpty == false,
        reserved.isDisjoint(with: programs)
      else { return nil }
      reserved.formUnion(programs)
      var legacy: OfficialLegacyInstall?
      if let given = plugin["legacyInstall"] {
        guard let fields = given as? [String: Any], let program = fields["program"] as? String, let root = fields["root"] as? String, let current = fields["current"] as? String,
          programs.contains(program), ProgramRegistry.isKnownRoot(root), ProgramRegistry.isComponent(current)
        else { return nil }
        legacy = OfficialLegacyInstall(program: program, root: root, current: current)
      }
      var trustedArtifacts: Set<String> = []
      var bundledDigests: Set<String> = []
      if let given = plugin["trusted"] {
        guard let fields = given as? [String: Any], let artifacts = fields["artifacts"] as? [String] ?? (fields["artifacts"] == nil ? [] : nil),
          let bundled = fields["bundledDigests"] as? [String] ?? (fields["bundledDigests"] == nil ? [] : nil), artifacts.allSatisfy(isSha), bundled.allSatisfy(isSha),
          artifacts.count <= maxTrusted, bundled.count <= maxTrusted
        else { return nil }
        trustedArtifacts = Set(artifacts)
        bundledDigests = Set(bundled)
      }
      entries.append(
        OfficialPinEntry(
          name: name, version: version, url: url, sha256: sha, reservedPrograms: programs, legacyInstall: legacy, trustedArtifacts: trustedArtifacts, bundledDigests: bundledDigests,
          credentialPrograms: credentialPrograms, title: label(plugin["title"], limit: 60), blurb: label(plugin["blurb"], limit: 200), icon: label(plugin["icon"], limit: 64),
          symbol: label(plugin["symbol"], limit: 64), accent: accent(plugin["accent"])))
    }
    return OfficialPin(entries: entries, reservedProviders: providers, ownerTitles: ownerTitles.filter { !$0.value.isEmpty })
  }

  static func manifestName(_ text: String) -> String? {
    guard let doc = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else { return nil }
    return doc["name"] as? String
  }

  static func manifestVersion(_ text: String) -> String? {
    guard let doc = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else { return nil }
    return doc["version"] as? String
  }

  var registryDocument: [String: Any] {
    var claims: [String: String] = [:]
    var legacy: [[String: Any]] = []
    for entry in entries {
      for program in entry.reservedPrograms { claims[program] = entry.name }
      if let install = entry.legacyInstall {
        legacy.append(["owner": entry.name, "program": install.program, "root": install.root, "current": install.current])
      }
    }
    return ["version": ProgramRegistry.version, "claims": claims, "legacyInstalls": legacy]
  }

  func refusal(manifest text: String, of entry: OfficialPinEntry) -> String? {
    guard OfficialPin.manifestName(text) == entry.name else { return "its plugin.json isn't the \(entry.name) plugin" }
    guard OfficialPin.manifestVersion(text) == entry.version else { return "its plugin.json isn't version \(entry.version), the one this Ardia pins" }
    let claimed = ProgramRegistry.claimedPrograms(manifest: Data(text.utf8))
    if let stray = claimed.first(where: { !entry.reservedPrograms.contains($0) }) {
      return "it claims \(stray), which this Ardia doesn't reserve for it"
    }
    return nil
  }
}
