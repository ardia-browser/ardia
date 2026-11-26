import ArdiaCore
import Foundation

enum PluginLocalInstall {
  private static let queue = DispatchQueue(label: "ardia.plugin-local-install", qos: .userInitiated)

  static func archive(_ path: String, done: @escaping ([String: Any]) -> Void) {
    queue.async {
      guard let folders = PluginFolders.current() else { return done(["ok": false, "reason": "Ardia has no data folder"]) }
      let store = folders.store()
      guard PluginPrograms.realFolder(store.root, creating: true) != nil else { return done(["ok": false, "reason": "Ardia's plugin store couldn't be made"]) }
      let scratch = (store.root as NSString).appendingPathComponent(".local-\(getpid())-\(UInt32.random(in: 0...UInt32.max))")
      guard mkdir(scratch, 0o700) == 0 else { return done(["ok": false, "reason": "a scratch folder couldn't be made"]) }
      defer { PluginPrograms.discard(scratch) }
      switch PluginInstaller.localArchive(path, scratch: scratch, store: store) {
      case .failure(let failure): done(["ok": false, "reason": failure.reason])
      case .success(let made):
        let id = PluginStore.id(made.copy.key) ?? ""
        done(["ok": true, "name": made.copy.key, "id": id, "source": "store", "sha256": made.copy.sha, "candidate": PluginFolders.candidate(made.manifest, copy: made.copy)])
      }
    }
  }

  static func folder(_ path: String, done: @escaping ([String: Any]) -> Void) {
    queue.async {
      guard let folders = PluginFolders.current() else { return done(["ok": false, "reason": "Ardia has no data folder"]) }
      let source = PluginSandbox.resolved(path) ?? path
      guard PluginPrograms.isRealFolder(source), let opened = PluginFiles.openFolder(source) else { return done(["ok": false, "reason": "That folder can't be opened."]) }
      let read = PluginFiles.readManifest(in: opened)
      opened.close()
      guard case .text(let text) = read, let id = PluginInstaller.manifestFields(text).id, let key = PluginInstaller.keyOf(id), PluginInstaller.manifestFields(text).manifest == 3 else {
        return done(["ok": false, "reason": "That folder has no manifest 3 plugin.json with an id like @you/name."])
      }
      guard PluginStore.parts(key)?.scope != PluginInstaller.officialScope else { return done(["ok": false, "reason": "@ardia plugins come only from Ardia's registry."]) }
      guard let target = folders.lexicalFolder(key) else { return done(["ok": false, "reason": "That plugin's id can't be a folder name."]) }
      var info = stat()
      guard lstat(target, &info) != 0 else { return done(["ok": false, "reason": "A plugin with that id is already in your plugins folder."]) }
      try? FileManager.default.createDirectory(atPath: folders.pluginsLexical, withIntermediateDirectories: true)
      guard PluginFiles.openFolder(source).map({ folder -> Bool in
        defer { folder.close() }
        return PluginPrograms.checkTree(folder.fd) == nil
      }) == true else { return done(["ok": false, "reason": "That folder holds links or special files, so it wasn't copied."]) }
      do {
        try FileManager.default.copyItem(atPath: source, toPath: target)
      } catch {
        return done(["ok": false, "reason": "It couldn't be copied (\(error.localizedDescription))."])
      }
      done(["ok": true, "name": key, "id": id, "source": "local"])
    }
  }

  static func activate(_ name: String, folderId: String, approved: String) -> [String: Any] {
    guard let folders = PluginFolders.current() else { return ["ok": false, "reason": "Ardia has no data folder"] }
    if let problem = PluginInstaller.activate(name, folderId: folderId, approved: approved, store: folders.store(), officialKeys: PluginOfficial.keys(override: LaunchConfig.shared.pluginNativeKeys)) { return ["ok": false, "reason": problem] }
    return ["ok": true, "folderId": folderId]
  }

  static func rollback(_ name: String, expectedVersion: String, expectedSha256: String) -> [String: Any] {
    guard let folders = PluginFolders.current() else { return ["ok": false, "reason": "Ardia has no data folder"] }
    guard PluginStore.isSha(expectedSha256), !expectedVersion.isEmpty else { return ["ok": false, "reason": "rollbackStore needs the version and SHA-256 Ardia checked"] }
    guard let earlier = folders.store().rollback(name, expectedVersion: expectedVersion, expectedSha: expectedSha256) else {
      return ["ok": false, "reason": "The earlier copy isn't the one Ardia checked, so it wasn't switched to."]
    }
    return ["ok": true, "folderId": earlier.folderId]
  }
}
