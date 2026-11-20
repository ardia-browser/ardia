import AppKit
import ArdiaCore
import Foundation

struct PluginFolders {
  static let maxPlugins = 64
  static let manifestName = "plugin.json"
  private static let namePattern = try! NSRegularExpression(pattern: "^[a-z0-9][a-z0-9-]{0,39}$")

  static let bundledId = "bundled"

  let config: String
  let appData: String
  let pluginsLexical: String
  let bundled: String?

  static func current() -> PluginFolders? {
    guard let marker = try? DocumentStore.url("plugins.json") else { return nil }
    let appData = marker.deletingLastPathComponent().path
    let config = LaunchConfig.shared.configDirectory
    return PluginFolders(
      config: PluginSandbox.resolved(config) ?? config, appData: PluginSandbox.resolved(appData) ?? appData,
      pluginsLexical: (config as NSString).appendingPathComponent("plugins"), bundled: bundledRoot())
  }

  static func bundledRoot() -> String? {
    if LaunchConfig.shared.isolated, let path = LaunchConfig.shared.testValue("bundledPlugins") { return PluginSandbox.resolved(path) ?? path }
    guard let resources = Bundle.main.resourcePath else { return nil }
    let root = (resources as NSString).appendingPathComponent("Plugins")
    return FileManager.default.fileExists(atPath: root) ? root : nil
  }

  func bundledFolder(_ name: String) -> String? {
    guard Self.isName(name), let bundled else { return nil }
    return (bundled as NSString).appendingPathComponent(name)
  }

  func isUserPlugin(_ name: String) -> Bool {
    guard let path = lexicalFolder(name) else { return false }
    var info = stat()
    guard lstat(path, &info) == 0 else { return false }
    return LaunchConfig.shared.isolated || bundledFolder(name).map { !FileManager.default.fileExists(atPath: $0) } ?? true
  }

  func programPlaces() -> Result<ProgramPlaces, FolderRefusal> {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    if LaunchConfig.shared.isolated {
      guard let bin = LaunchConfig.shared.instance("cliBinDir") else {
        return .failure(FolderRefusal(reason: "a test instance puts programs on PATH only with ARDIA_INSTANCE cliBinDir set"))
      }
      return .success(ProgramPlaces(store: (appData as NSString).appendingPathComponent("Programs"), binDir: bin, legacy: LaunchConfig.shared.instance("cliHome")))
    }
    let support = (home as NSString).appendingPathComponent("Library/Application Support/Ardia")
    return .success(
      ProgramPlaces(
        store: (support as NSString).appendingPathComponent("Programs"), binDir: (home as NSString).appendingPathComponent(".local/bin"),
        legacy: (support as NSString).appendingPathComponent("CLI")))
  }

  static func isName(_ name: String) -> Bool {
    let whole = NSRange(name.startIndex..., in: name)
    return namePattern.firstMatch(in: name, range: whole)?.range == whole
  }

  func lexicalFolder(_ name: String) -> String? {
    Self.isName(name) ? (pluginsLexical as NSString).appendingPathComponent(name) : nil
  }

  private func source(_ name: String, folderId: String) -> (path: String, identity: String?)? {
    if folderId == Self.bundledId {
      guard !isUserPlugin(name), let path = bundledFolder(name) else { return nil }
      return (path, Self.bundledId)
    }
    return lexicalFolder(name).map { ($0, nil) }
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

  func list() -> [[String: Any]] {
    let user = Set(((try? FileManager.default.contentsOfDirectory(atPath: pluginsLexical)) ?? []).filter(Self.isName))
    let builtIn = Set(bundled.flatMap { try? FileManager.default.contentsOfDirectory(atPath: $0) }?.filter(Self.isName) ?? [])
    let overrides = LaunchConfig.shared.isolated
    let shown = (builtIn.sorted() + user.subtracting(builtIn).sorted()).prefix(Self.maxPlugins).sorted()
    return shown.map { name in
      let fromUser = user.contains(name) && (overrides || !builtIn.contains(name))
      let path = fromUser ? (pluginsLexical as NSString).appendingPathComponent(name) : bundledFolder(name)!
      var entry: [String: Any] = [
        "name": name, "status": "missing", "bundled": !fromUser, "replacesBundled": fromUser && builtIn.contains(name),
        "ignoresUserFolder": !fromUser && user.contains(name),
      ]
      guard let folder = PluginFiles.openFolder(path) else { return entry }
      defer { folder.close() }
      let read = PluginFiles.readManifest(in: folder)
      entry["status"] = read.status
      entry["folderId"] = fromUser ? folder.id : Self.bundledId
      if case .text(let text) = read { entry["text"] = text }
      return entry
    }
  }

  func remove(_ name: String) -> String? {
    guard Self.isName(name) else { return "That isn't a plugin's name." }
    let link = (pluginsLexical as NSString).appendingPathComponent(name)
    var info = stat()
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
