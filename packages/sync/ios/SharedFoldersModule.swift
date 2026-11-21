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

    AsyncFunction("read") { (path: String, identity: [String: Int]?) -> [String: Any] in
      SharedFolderDirectory(root: URL(fileURLWithPath: path, isDirectory: true), identity: identity).read()
    }.runOnQueue(Self.work)

    AsyncFunction("apply") { (path: String, ops: String, identity: [String: Int]?) throws -> [String: Any] in
      try SharedFolderDirectory(root: URL(fileURLWithPath: path, isDirectory: true), identity: identity).apply(json: ops)
    }.runOnQueue(Self.work)

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

  private static let dataDirectory = LaunchConfig.shared.dataDirectory.map { URL(fileURLWithPath: $0, isDirectory: true) }
  private static let testParent = LaunchConfig.shared.instance("sharedFolders").map { URL(fileURLWithPath: $0, isDirectory: true) }

  static var defaultParent: URL {
    if let testParent { return testParent }
    if let dataDirectory { return dataDirectory.appendingPathComponent("Ardia Shared", isDirectory: true) }
    return SyncFolder.iCloudDrive.appendingPathComponent("Ardia Shared", isDirectory: true)
  }
}
