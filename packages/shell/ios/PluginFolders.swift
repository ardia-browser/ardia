import AppKit
import ArdiaCore
import Foundation

struct PluginFolders {
  static let maxPlugins = 64
  static let manifestName = "plugin.json"
  static let officialFolderName = "OfficialPlugins"
  private static let namePattern = try! NSRegularExpression(pattern: "^[a-z0-9][a-z0-9-]{0,39}$")

  static let legacyId = OfficialPin.legacyFolderId

  let config: String
  let appData: String
  let pluginsLexical: String

  static func current() -> PluginFolders? {
    guard let marker = try? DocumentStore.url("plugins.json") else { return nil }
    let appData = marker.deletingLastPathComponent().path
    let config = LaunchConfig.shared.configDirectory
    return PluginFolders(
      config: PluginSandbox.resolved(config) ?? config, appData: PluginSandbox.resolved(appData) ?? appData,
      pluginsLexical: (config as NSString).appendingPathComponent("plugins"))
  }

  static func officialPin() -> OfficialPin? {
    if LaunchConfig.shared.testInstance, let path = LaunchConfig.shared.testValue(OfficialPin.pinFixtureKey) {
      return FileManager.default.contents(atPath: path).flatMap { try? JSONSerialization.jsonObject(with: $0) }.flatMap(OfficialPin.parse)
    }
    return OfficialPin.parse(Bundle.main.infoDictionary?[OfficialPin.infoKey])
  }

  func officialStore() -> OfficialStore { OfficialStore(root: (appData as NSString).appendingPathComponent(Self.officialFolderName)) }

  func programPlaces() -> Result<ProgramPlaces, FolderRefusal> {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    if LaunchConfig.shared.isolated {
      guard let bin = LaunchConfig.shared.instance("cliBinDir") else {
        return .failure(FolderRefusal(reason: "a test instance puts programs on PATH only with ARDIA_INSTANCE cliBinDir set"))
      }
      return .success(ProgramPlaces(store: (appData as NSString).appendingPathComponent("Programs"), binDir: bin))
    }
    let given = (home as NSString).appendingPathComponent("Library/Application Support/Ardia")
    try? FileManager.default.createDirectory(atPath: given, withIntermediateDirectories: true)
    let support = PluginSandbox.resolved(given) ?? given
    return .success(ProgramPlaces(store: (support as NSString).appendingPathComponent("Programs"), binDir: (home as NSString).appendingPathComponent(".local/bin")))
  }

  static let isolatedLegacyKey = "cliHome"

  func programRegistry(pin: OfficialPin? = PluginFolders.officialPin()) -> ProgramRegistry {
    let isolated = LaunchConfig.shared.isolated
    return ProgramRegistry.resolve(
      info: Bundle.main.infoDictionary?[ProgramRegistry.infoKey], pin: pin, home: FileManager.default.homeDirectoryForCurrentUser.path, isolated: isolated,
      testInstance: LaunchConfig.shared.testInstance, scratchLegacyBase: isolated ? LaunchConfig.shared.instance(Self.isolatedLegacyKey) : nil)
  }

  static func isName(_ name: String) -> Bool {
    let whole = NSRange(name.startIndex..., in: name)
    return namePattern.firstMatch(in: name, range: whole)?.range == whole
  }

  func lexicalFolder(_ name: String) -> String? {
    Self.isName(name) ? (pluginsLexical as NSString).appendingPathComponent(name) : nil
  }

  func officialCopy(_ name: String, folderId: String, pin: OfficialPin? = PluginFolders.officialPin(), fresh: Bool = false) -> OfficialCopy? {
    OfficialTrust.copy(officialStore(), name: name, folderId: folderId, pin: pin, fresh: fresh)
  }

  func legacyFolder(_ name: String, pin: OfficialPin? = PluginFolders.officialPin()) -> String? {
    guard let entry = pin?.entry(name), OfficialTrust.trustedActive(officialStore(), entry) == nil, case .success(let places) = programPlaces(),
      let folder = PluginPrograms.legacyCopy(plugin: name, places: places), OfficialTrust.bundledCopyHolds(folder, digests: entry.bundledDigests)
    else { return nil }
    return folder
  }

  private func source(_ name: String, folderId: String) -> (path: String, identity: String?)? {
    if folderId == Self.legacyId { return legacyFolder(name).map { ($0, Self.legacyId) } }
    if OfficialPin.sha(ofFolderId: folderId) != nil { return officialCopy(name, folderId: folderId).map { ($0.path, folderId) } }
    return lexicalFolder(name).map { ($0, nil) }
  }

  func isOfficial(_ name: String, folderId: String) -> Bool {
    folderId == Self.legacyId ? legacyFolder(name) != nil : officialCopy(name, folderId: folderId) != nil
  }

  func approvedFolder(_ name: String, folderId: String, approved: String) -> Result<OpenedFolder, FolderRefusal> {
    guard let source = source(name, folderId: folderId) else { return .failure(FolderRefusal(reason: "it has no folder")) }
    return PluginFiles.approvedFolder(source.path, folderId: folderId, approved: approved, identity: source.identity)
  }

  func readPageFile(_ name: String, folderId: String, approved: String, relative: String) -> Data? {
    guard let source = source(name, folderId: folderId) else { return nil }
    return PluginFiles.readPageFile(source.path, folderId: folderId, approved: approved, relative: relative, identity: source.identity)
  }

  func dataRoot() -> String { (appData as NSString).appendingPathComponent("PluginData") }

  func dataFolder(_ name: String) -> OpenedFolder? {
    guard Self.isName(name) else { return nil }
    let folder = (dataRoot() as NSString).appendingPathComponent(name)
    try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    return PluginFiles.openDataFolder(folder)
  }

  static func manifestText(_ path: String) -> (status: String, text: String?, id: String?) {
    guard let folder = PluginFiles.openFolder(path) else { return ("missing", nil, nil) }
    defer { folder.close() }
    let read = PluginFiles.readManifest(in: folder)
    if case .text(let text) = read { return (read.status, text, folder.id) }
    return (read.status, nil, folder.id)
  }

  static func candidate(_ text: String, folderId: String, version: String) -> [String: Any] {
    ["folderId": folderId, "text": text, "legacyHash": PluginFiles.approvalHash(text: text, folderId: legacyId), "version": version]
  }

  func officialEntry(_ entry: OfficialPinEntry) -> [String: Any]? {
    let store = officialStore()
    store.sweep(entry.name, keeping: [entry.sha256])
    let active = OfficialTrust.trustedActive(store, entry)
    var result: [String: Any]?
    if let active {
      let read = Self.manifestText(active.path)
      result = ["name": entry.name, "status": read.status, "official": true, "folderId": active.folderId]
      if active.sha != entry.sha256 { result!["legacy"] = true }
      if let text = read.text {
        result!["text"] = text
        if active.sha == entry.sha256 { result!["legacyHash"] = PluginFiles.approvalHash(text: text, folderId: Self.legacyId) }
      }
    } else if let folder = legacyFolder(entry.name), case let read = Self.manifestText(folder), let text = read.text, OfficialPin.manifestName(text) == entry.name {
      result = ["name": entry.name, "status": read.status, "official": true, "legacy": true, "folderId": Self.legacyId, "text": text]
    }
    if active?.sha != entry.sha256, let copy = store.copy(entry.name, sha: entry.sha256), let text = Self.manifestText(copy.path).text {
      if result == nil { result = ["name": entry.name, "status": "missing", "official": true, "candidateOnly": true] }
      result!["candidate"] = Self.candidate(text, folderId: copy.folderId, version: entry.version)
    }
    result?["autoInstall"] = LaunchConfig.shared.testInstance
    return result
  }

  func list() -> [[String: Any]] {
    let user = Set(((try? FileManager.default.contentsOfDirectory(atPath: pluginsLexical)) ?? []).filter(Self.isName))
    var official: [String: [String: Any]] = [:]
    for entry in Self.officialPin()?.entries ?? [] {
      if let found = officialEntry(entry) { official[entry.name] = found }
    }
    let installed = Set(official.filter { $0.value["candidateOnly"] as? Bool != true }.keys)
    let shown = (installed.sorted() + user.subtracting(installed).sorted()).prefix(Self.maxPlugins).sorted()
    var entries: [[String: Any]] = shown.map { name in
      if var entry = official[name], installed.contains(name) {
        if user.contains(name) { entry["ignoresUserFolder"] = true }
        return entry
      }
      var entry: [String: Any] = ["name": name, "status": "missing", "official": false]
      let read = Self.manifestText((pluginsLexical as NSString).appendingPathComponent(name))
      entry["status"] = read.status
      if let id = read.id { entry["folderId"] = id }
      if let text = read.text { entry["text"] = text }
      return entry
    }
    for (name, entry) in official where !installed.contains(name) { entries.append(entry) }
    return entries
  }

  func remove(_ name: String, official: Bool, folderId: String?) -> String? {
    guard Self.isName(name) else { return "That isn't a plugin's name." }
    let link = (pluginsLexical as NSString).appendingPathComponent(name)
    var info = stat()
    if official {
      return officialStore().remove(name) ? nil : "Its downloaded copy couldn't be removed."
    }
    if let folderId, lstat(link, &info) == 0, PluginFiles.openFolder(link).map({ folder -> String in
      defer { folder.close() }
      return folder.id
    }) != folderId {
      return "Another folder took its place while it was being removed, so nothing was deleted. Try again."
    }
    if lstat(link, &info) == 0 {
      do {
        if LaunchConfig.shared.dataDirectory != nil {
          try FileManager.default.removeItem(atPath: link)
        } else {
          try FileManager.default.trashItem(at: URL(fileURLWithPath: link), resultingItemURL: nil)
        }
      } catch {
        return "Its folder couldn't be moved to the Trash (\(error.localizedDescription))."
      }
    }
    let data = (dataRoot() as NSString).appendingPathComponent(name)
    guard lstat(data, &info) == 0 else { return nil }
    do {
      try FileManager.default.removeItem(atPath: data)
    } catch {
      return "Its folder is gone, but its data couldn't be deleted (\(error.localizedDescription)); removing it again finishes that."
    }
    return nil
  }
}
