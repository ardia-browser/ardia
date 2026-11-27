import ArdiaCore
import Foundation

enum PluginFileCalls {
  static let quota = PluginFileQuota()
  static let access = PluginFileAccess()
  static let maxWatches = 256
  private static let lock = NSLock()
  private static var queues: [String: DispatchQueue] = [:]
  private static var watchers: [String: (plugin: String, root: String?, watcher: PluginFileWatcher)] = [:]

  static func queue(for plugin: String) -> DispatchQueue {
    lock.withLock {
      if let known = queues[plugin] { return known }
      let made = DispatchQueue(label: "ardia.plugins.files.\(plugin)", qos: .userInitiated)
      queues[plugin] = made
      return made
    }
  }

  static func dataRoot(_ plugin: String) -> String? {
    guard let data = PluginFolders.current()?.dataFolder(plugin) else { return nil }
    defer { data.close() }
    return (data.path as NSString).appendingPathComponent("files")
  }

  static func grantRoot(_ path: String) -> String? { PluginFileStore.isPlainAbsolute(path) ? path : nil }

  static func guardedFolders() -> [String] {
    var guarded: [String] = []
    if let folders = PluginFolders.current() {
      guarded += [folders.appData, folders.config, folders.pluginsLexical, folders.dataRoot(), folders.officialStore().root]
      if case .success(let places) = folders.programPlaces() { guarded.append(places.store) }
    }
    if let data = LaunchConfig.shared.dataDirectory { guarded.append(data) }
    guarded.append((NSHomeDirectory() as NSString).appendingPathComponent("Library/Application Support/Ardia"))
    return guarded
  }

  static func isProtected(_ path: String) -> Bool { PluginFileStore.isProtected(path, guarding: guardedFolders()) }

  static func store(_ plugin: String, root: String?, identity: PluginFileIdentity? = nil) -> Result<PluginFileStore, PluginFileFailure> {
    guard PluginFolders.isName(plugin) else { return .failure(PluginFileFailure(.refused, "that isn't a plugin's name")) }
    guard let root else {
      guard let path = dataRoot(plugin) else { return .failure(PluginFileFailure(.unavailable, "the plugin's data folder couldn't be opened")) }
      return .success(PluginFileStore(root: path, isData: true, quota: quota))
    }
    guard let path = grantRoot(root) else { return .failure(PluginFileFailure(.refused, "the folder isn't a plain absolute path")) }
    guard !isProtected(path) else { return .failure(PluginFileFailure(.refused, "that folder holds Ardia's own data or the system's")) }
    return .success(PluginFileStore(root: path, isData: false, coordinated: PluginFileStore.isInICloud(path), identity: identity))
  }

  static func call(_ spec: [String: Any], done: @escaping ([String: Any]) -> Void) {
    let plugin = spec["plugin"] as? String ?? ""
    guard PluginFolders.isName(plugin) else { return done(PluginFileFailure(.refused, "that isn't a plugin's name").reply) }
    let root = spec["root"] as? String
    let ticket = PluginFileStore.integer(spec["ticket"])
    let operation = (spec["operation"] as? String).flatMap { UUID(uuidString: $0)?.uuidString }
    queue(for: plugin).async {
      guard access.allows(ticket, plugin: plugin, root: root, operation: operation) else { return done(PluginFileStore.accessEnded.reply) }
      switch store(plugin, root: root, identity: PluginFileIdentity(spec: spec["rootIdentity"])) {
      case .failure(let failure): done(failure.reply)
      case .success(var store):
        store.gate = access.gate(ticket: ticket, plugin: plugin, root: root, operation: operation)
        done(store.perform(spec))
      }
    }
  }

  private final class WatcherSlot {
    weak var watcher: PluginFileWatcher?
  }

  static func watch(_ id: String, plugin: String, root: String?, identity: PluginFileIdentity?, emit: @escaping (String, [String], Bool) -> Void) -> Bool {
    guard !id.isEmpty, id.utf8.count <= 128, case .success(let store) = store(plugin, root: root, identity: identity) else { return false }
    let slot = WatcherSlot()
    let made = PluginFileWatcher.verified(
      store,
      onGone: {
        lock.withLock { if let current = slot.watcher, watchers[id]?.watcher === current { watchers[id] = nil } }
        emit(id, [], true)
      },
      onChange: { paths in emit(id, paths, false) })
    guard case .success(let watcher) = made else { return false }
    slot.watcher = watcher
    let (admitted, previous) = lock.withLock { () -> (Bool, PluginFileWatcher?) in
      let previous = watchers[id]?.watcher
      guard previous != nil || watchers.count < maxWatches else { return (false, nil) }
      watchers[id] = (plugin, root, watcher)
      return (true, previous)
    }
    previous?.stop()
    guard admitted else { return false }
    guard watcher.start() else {
      lock.withLock { if watchers[id]?.watcher === watcher { watchers[id] = nil } }
      return false
    }
    return true
  }

  static func unwatch(_ id: String) {
    let removed = lock.withLock { watchers.removeValue(forKey: id) }
    removed?.watcher.stop()
  }

  static func revoke(_ plugin: String, root: String?) {
    access.revoke(plugin: plugin, root: root)
    let dropped = lock.withLock { () -> [PluginFileWatcher] in
      let matching = watchers.filter { $0.value.plugin == plugin && (root == nil || $0.value.root == root) }
      for id in matching.keys { watchers[id] = nil }
      return matching.values.map(\.watcher)
    }
    dropped.forEach { $0.stop() }
  }

  static func forget(_ plugin: String) {
    let dropped = lock.withLock { () -> [PluginFileWatcher] in
      let matching = watchers.filter { $0.value.plugin == plugin }
      for id in matching.keys { watchers[id] = nil }
      return matching.values.map(\.watcher)
    }
    dropped.forEach { $0.stop() }
    guard PluginFolders.isName(plugin), let folders = PluginFolders.current() else { return }
    let path = ((folders.dataRoot() as NSString).appendingPathComponent(plugin) as NSString).appendingPathComponent("files")
    queue(for: plugin).async { quota.forget(path) }
  }

  static func folderInfo(_ path: String) -> [String: Any] {
    guard path.hasPrefix("/") else { return ["exists": false, "realPath": path, "location": "other", "protected": true] }
    let real = PluginFileStore.realPath(path)
    var info = stat()
    let exists = real.map { lstat($0, &info) == 0 && (info.st_mode & S_IFMT) == S_IFDIR } ?? false
    let shown = real ?? path
    var answer: [String: Any] = ["exists": exists, "realPath": shown, "location": PluginFileStore.isInICloud(shown) ? "icloud" : "other", "protected": isProtected(shown)]
    if exists { answer.merge(PluginFileIdentity(info).reply) { $1 } }
    return answer
  }
}
