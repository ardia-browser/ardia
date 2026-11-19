import AppKit
import ArdiaCore
import ExpoModulesCore

public class SharedFoldersModule: Module {
  private static let work = DispatchQueue(label: "ardia.shared-folders", qos: .utility)
  private var watcher: SharedFolderWatcher?

  public func definition() -> ModuleDefinition {
    Name("ArdiaSharedFolders")

    Events("onChange")

    OnCreate { [weak self] in
      self?.watcher = SharedFolderWatcher { [weak self] paths in self?.sendEvent("onChange", ["paths": paths]) }
    }

    Function("location") { () -> [String: Any] in
      [
        "path": Self.defaultParent.path,
        "iCloudAvailable": Self.testParent != nil || SyncFolder.iCloudDriveAvailable,
        "iCloudPath": SyncFolder.iCloudDrive.path,
      ]
    }

    AsyncFunction("read") { (path: String, identity: [String: Int]?, promise: Promise) in
      Self.folderQueue(path).async {
        guard let identity else { return promise.resolve(["exists": false, "error": Self.unconfirmed]) }
        promise.resolve(SharedFolderDirectory(root: URL(fileURLWithPath: path, isDirectory: true), identity: identity).read())
      }
    }

    AsyncFunction("apply") { (path: String, ops: String, identity: [String: Int]?, token: String?, promise: Promise) in
      Self.folderQueue(path).async {
        defer { if let token { Self.cancellations.forget(token) } }
        guard let identity else { return promise.reject("ERR_SHARED_FOLDER", Self.unconfirmed) }
        let cancelled = { token.map(Self.cancellations.isCancelled) ?? false }
        do {
          promise.resolve(try SharedFolderDirectory(root: URL(fileURLWithPath: path, isDirectory: true), identity: identity, cancelled: cancelled).apply(json: ops))
        } catch {
          promise.reject("ERR_SHARED_FOLDER", error.localizedDescription)
        }
      }
    }

    Function("cancel") { (token: String) in Self.cancellations.cancel(token) }

    AsyncFunction("resolve") { (path: String, promise: Promise) in
      do {
        promise.resolve(try SharedFolderDirectory.resolve(path))
      } catch let refused as SharedFolderDirectory.Refused {
        promise.reject("ERR_SHARED_FOLDER_REFUSED", refused.message)
      } catch {
        promise.reject("ERR_SHARED_FOLDER", error.localizedDescription)
      }
    }.runOnQueue(Self.work)

    AsyncFunction("discard") { (path: String, identity: [String: Int]) -> Bool in
      SharedFolderDirectory.discard(path, identity: identity)
    }.runOnQueue(Self.work)

    AsyncFunction("create") { (parent: String, parentIdentity: [String: Int]?, name: String) throws -> [String: Any] in
      try SharedFolderDirectory.create(inParent: parent, parentIdentity: parentIdentity, named: name)
    }.runOnQueue(Self.work)

    Function("watch") { [weak self] (paths: [String]) in self?.watcher?.watch(paths) }

    OnDestroy { [weak self] in self?.watcher?.stop() }
  }

  static let cancellations = SharedFolderCancellations()
  private static let queuesLock = NSLock()
  nonisolated(unsafe) private static var queues: [String: DispatchQueue] = [:]

  static func folderQueue(_ path: String) -> DispatchQueue {
    queuesLock.lock()
    defer { queuesLock.unlock() }
    if let queue = queues[path] { return queue }
    let queue = DispatchQueue(label: "ardia.shared-folders.folder", qos: .utility)
    queues[path] = queue
    return queue
  }

  private static let unconfirmed = "Ardia can’t confirm which folder this is any more. Stop syncing it, then add it again."
  private static let dataDirectory = LaunchConfig.shared.dataDirectory.map { URL(fileURLWithPath: $0, isDirectory: true) }
  private static let testParent = LaunchConfig.shared.instance("sharedFolders").map { URL(fileURLWithPath: $0, isDirectory: true) }

  static var defaultParent: URL {
    if let testParent { return testParent }
    if let dataDirectory { return dataDirectory.appendingPathComponent("Ardia Shared", isDirectory: true) }
    return SyncFolder.iCloudDrive.appendingPathComponent("Ardia Shared", isDirectory: true)
  }
}
