import AppKit
import ArdiaCore
import CryptoKit
import Foundation

struct PluginFolders {
  static let maxPlugins = 64
  static let manifestName = "plugin.json"
  static let storeFolderName = PluginSandbox.storeFolderName
  static let devFolderName = "plugins-dev"
  static let devPrefix = "dev-"
  static let maxDevLink = 16 << 10

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

  func store() -> PluginStore { PluginStore(root: (appData as NSString).appendingPathComponent(Self.storeFolderName)) }

  var devLinks: String { (config as NSString).appendingPathComponent(Self.devFolderName) }

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

  static func isName(_ name: String) -> Bool { PluginPrograms.isKey(name) }

  func lexicalFolder(_ name: String) -> String? {
    Self.isName(name) ? (pluginsLexical as NSString).appendingPathComponent(name) : nil
  }

  func storeCopy(_ name: String, folderId: String, fresh: Bool = false) -> StoreCopy? {
    guard let sha = PluginStore.sha(ofFolderId: folderId) else { return nil }
    return store().copy(name, sha: sha, fresh: fresh)
  }

  static func devFolderId(_ path: String) -> String {
    devPrefix + SHA256.hash(data: Data(path.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
  }

  func devLink(_ name: String) -> String? {
    guard Self.isName(name), PluginStore.parts(name) != nil else { return nil }
    let file = (devLinks as NSString).appendingPathComponent("\(name).json")
    var info = stat()
    guard lstat(file, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_size <= Self.maxDevLink, let data = FileManager.default.contents(atPath: file),
      let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], (doc["v"] as? NSNumber)?.intValue == 1, doc["id"] as? String == PluginStore.id(name),
      let path = doc["path"] as? String, path.hasPrefix("/"), !path.contains("\0")
    else { return nil }
    let folder = PluginSandbox.resolved(path) ?? path
    guard PluginPrograms.isRealFolder(folder), ![appData, config].contains(where: { PluginSandbox.isInside(folder, $0) || PluginSandbox.isInside($0, folder) }) else { return nil }
    return folder
  }

  private func source(_ name: String, folderId: String) -> (path: String, identity: String?, digested: Bool)? {
    if let copy = storeCopy(name, folderId: folderId) { return (copy.path, folderId, false) }
    if PluginStore.sha(ofFolderId: folderId) != nil { return nil }
    if folderId.hasPrefix(Self.devPrefix) {
      guard let path = devLink(name), Self.devFolderId(path) == folderId else { return nil }
      return (path, folderId, false)
    }
    guard folderId.hasPrefix(PluginFolderDigest.prefix) else { return nil }
    return lexicalFolder(name).map { ($0, nil, true) }
  }

  func approvedFolder(_ name: String, folderId: String, approved: String) -> Result<OpenedFolder, FolderRefusal> {
    guard let source = source(name, folderId: folderId) else { return .failure(FolderRefusal(reason: "it has no folder")) }
    return PluginFiles.approvedFolder(source.path, folderId: folderId, approved: approved, identity: source.identity, digested: source.digested)
  }

  func readPageFile(_ name: String, folderId: String, approved: String, relative: String) -> Data? {
    guard let source = source(name, folderId: folderId) else { return nil }
    return PluginFiles.readPageFile(source.path, folderId: folderId, approved: approved, relative: relative, identity: source.identity, digested: source.digested)
  }

  static func localEntry(_ name: String, path: String) -> [String: Any] {
    var entry: [String: Any] = ["name": name, "source": "local", "status": "missing"]
    guard let folder = PluginFiles.openFolder(path) else { return entry }
    defer { folder.close() }
    let read = PluginFiles.readManifest(in: folder)
    entry["status"] = read.status
    guard case .text(let text) = read else { return entry }
    switch PluginFiles.digestedFolder(folder) {
    case .success(let named):
      entry["folderId"] = named.id
      entry["text"] = text
    case .failure(let refusal):
      entry["status"] = "unchecked"
      entry["reason"] = refusal.reason
    }
    return entry
  }

  static func localFolderId(_ path: String) -> String? {
    guard let folder = PluginFiles.openFolder(path) else { return nil }
    defer { folder.close() }
    guard case .success(let named) = PluginFiles.digestedFolder(folder) else { return nil }
    return named.id
  }

  func dataRoot() -> String { (appData as NSString).appendingPathComponent("PluginData") }

  static let profilesFolder = PluginDataPaths.profilesFolder
  static func isProfileId(_ text: String) -> Bool { PluginDataPaths.isProfileId(text) }
  static func dataPath(_ space: String) -> String? { PluginDataPaths.relative(space) }

  func dataFolder(_ name: String) -> OpenedFolder? {
    guard let relative = Self.dataPath(name) else { return nil }
    let folder = (dataRoot() as NSString).appendingPathComponent(relative)
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

  static func candidate(_ text: String, copy: StoreCopy) -> [String: Any] {
    ["folderId": copy.folderId, "text": text, "version": copy.version, "payloadDigest": copy.payloadDigest]
  }

  private func storeEntry(_ name: String) -> [String: Any]? {
    let store = store()
    store.sweep(name)
    let active = store.active(name)
    let waiting = store.candidates(name).compactMap { copy in Self.manifestText(copy.path).text.map { Self.candidate($0, copy: copy) } }
    var entry: [String: Any] = ["name": name, "source": "store", "status": "missing"]
    if let active {
      let read = Self.manifestText(active.path)
      entry["status"] = read.status
      entry["folderId"] = active.folderId
      if let text = read.text { entry["text"] = text }
    }
    if let previous = store.previous(name), let text = Self.manifestText(previous.path).text { entry["previous"] = Self.candidate(text, copy: previous) }
    if !waiting.isEmpty { entry["candidates"] = waiting }
    return active != nil || !waiting.isEmpty ? entry : nil
  }

  private func devEntry(_ name: String) -> [String: Any]? {
    guard let path = devLink(name) else { return nil }
    let read = Self.manifestText(path)
    var entry: [String: Any] = ["name": name, "source": "dev", "status": read.status, "folderId": Self.devFolderId(path), "devPath": path]
    if let text = read.text { entry["text"] = text }
    return entry
  }

  func list() -> [[String: Any]] {
    let user = ((try? FileManager.default.contentsOfDirectory(atPath: pluginsLexical)) ?? []).filter(Self.isName)
    let dev = ((try? FileManager.default.contentsOfDirectory(atPath: devLinks)) ?? []).filter { $0.hasSuffix(".json") }.map { String($0.dropLast(5)) }.filter(Self.isName)
    var entries: [String: [String: Any]] = [:]
    for name in store().keys() { if let found = storeEntry(name) { entries[name] = found } }
    for name in user where entries[name] == nil {
      entries[name] = Self.localEntry(name, path: (pluginsLexical as NSString).appendingPathComponent(name))
    }
    for name in dev {
      guard var found = devEntry(name) else { continue }
      if entries[name]?["source"] as? String == "store" { found["shadowsStore"] = true }
      entries[name] = found
    }
    return entries.keys.sorted().prefix(Self.maxPlugins).compactMap { entries[$0] }
  }

  func remove(_ name: String, source: String, folderId: String?) -> String? {
    guard Self.isName(name) else { return "That isn't a plugin's name." }
    var info = stat()
    switch source {
    case "store":
      if let folderId {
        if !store().removeCandidate(name, folderId: folderId) { return "Its downloaded copy couldn't be removed." }
      } else if !store().remove(name) {
        return "Its downloaded copy couldn't be removed."
      }
    case "dev":
      let file = (devLinks as NSString).appendingPathComponent("\(name).json")
      if lstat(file, &info) == 0, unlink(file) != 0 { return "Its dev link couldn't be removed (\(String(cString: strerror(errno))))." }
      return nil
    default:
      let link = (pluginsLexical as NSString).appendingPathComponent(name)
      if let folderId, lstat(link, &info) == 0, Self.localFolderId(link) != folderId {
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
    }
    let profiles = (dataRoot() as NSString).appendingPathComponent(Self.profilesFolder)
    let perProfile = ((try? FileManager.default.contentsOfDirectory(atPath: profiles)) ?? []).filter(Self.isProfileId).map {
      ((profiles as NSString).appendingPathComponent($0) as NSString).appendingPathComponent(name)
    }
    for data in [(dataRoot() as NSString).appendingPathComponent(name)] + perProfile where lstat(data, &info) == 0 {
      do {
        try FileManager.default.removeItem(atPath: data)
      } catch {
        return "Its files are gone, but its data couldn't be deleted (\(error.localizedDescription)); removing it again finishes that."
      }
    }
    return nil
  }
}
