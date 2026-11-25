import AppKit
import ArdiaCore
import ExpoModulesCore

public class SharedFoldersModule: Module, SharedFoldersNative {
  private static let work = DispatchQueue(label: "ardia.shared-folders", qos: .utility)
  private var watcher: SharedFolderWatcher?

  static var queue: DispatchQueue { work }

  static func location() -> [String: Any] {
    [
      "path": Self.defaultParent.path,
      "iCloudAvailable": Self.testParent != nil || SyncFolder.iCloudDriveAvailable,
      "iCloudPath": SyncFolder.iCloudDrive.path,
    ]
  }

  static func read(_ path: String, _ identity: [String: Int]?) -> [String: Any] { SharedFolderDirectory(root: URL(fileURLWithPath: path, isDirectory: true), identity: identity).read() }

  static func apply(_ path: String, _ ops: String, _ identity: [String: Int]?) throws -> [String: Any] { try SharedFolderDirectory(root: URL(fileURLWithPath: path, isDirectory: true), identity: identity).apply(json: ops) }

  static func resolve(_ path: String, _ promise: Promise) {
    do {
      promise.resolve(try SharedFolderDirectory.resolve(path))
    } catch let refused as SharedFolderDirectory.Refused {
      promise.reject("ERR_SHARED_FOLDER_REFUSED", refused.message)
    } catch {
      promise.reject("ERR_SHARED_FOLDER", error.localizedDescription)
    }
  }

  static func discard(_ path: String, _ identity: [String: Int]) -> Bool { SharedFolderDirectory.discard(path, identity: identity) }

  static func create(_ parent: String, _ parentIdentity: [String: Int]?, _ name: String) throws -> [String: Any] { try SharedFolderDirectory.create(inParent: parent, parentIdentity: parentIdentity, named: name) }

  func watch(_ paths: [String]) { watcher?.watch(paths) }

  public func definition() -> ModuleDefinition {
    Name(Self.moduleName)

    Self.eventsDefinition

    OnCreate { [weak self] in
      self?.watcher = SharedFolderWatcher { [weak self] paths in self?.sendEvent("onChange", ["paths": paths]) }
    }

    Self.locationFunction

    Self.readFunction

    Self.applyFunction

    Self.resolveFunction

    Self.discardFunction

    Self.createFunction

    watchFunction

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
