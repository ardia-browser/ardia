import AppKit
import ArdiaCore
import ExpoModulesCore
import ServiceManagement
import UniformTypeIdentifiers

public class SystemModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaSystem")

    OnCreate { Task { await ThumbnailCache.shared.trim() } }

    OnDestroy { FolderMediaWatches.shared.stopAll() }

    Events("onFolderChange")

    Constant("backgroundInstance") { () -> Bool in LaunchConfig.shared.background }

    AsyncFunction("isDefaultBrowser") { () -> Bool in
      guard let probe = URL(string: "https://example.com"),
            let handler = NSWorkspace.shared.urlForApplication(toOpen: probe) else { return false }
      return handler.standardizedFileURL == Bundle.main.bundleURL.standardizedFileURL
    }.runOnQueue(.main)

    AsyncFunction("setAsDefaultBrowser") { (promise: Promise) in
      if LaunchConfig.shared.background {
        NSLog("ArdiaSystem: background instance, not setting the default browser")
        return promise.resolve(false)
      }
      let app = Bundle.main.bundleURL
      NSWorkspace.shared.setDefaultApplication(at: app, toOpenURLsWithScheme: "http") { error in
        guard error == nil else { return promise.resolve(false) }
        NSWorkspace.shared.setDefaultApplication(at: app, toOpenURLsWithScheme: "https") { _ in
          DispatchQueue.main.async {
            let handler = URL(string: "https://example.com").flatMap(NSWorkspace.shared.urlForApplication(toOpen:))
            promise.resolve(handler?.standardizedFileURL == app.standardizedFileURL)
          }
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("launchAtLoginStatus") { () -> String in
      switch SMAppService.mainApp.status {
      case .enabled: return "enabled"
      case .requiresApproval: return "requiresApproval"
      case .notFound: return "notFound"
      default: return "notRegistered"
      }
    }.runOnQueue(.main)

    AsyncFunction("setLaunchAtLogin") { (enabled: Bool) in
      if LaunchConfig.shared.background {
        NSLog("ArdiaSystem: background instance, not changing launch at login")
        return
      }
      if enabled {
        try SMAppService.mainApp.register()
      } else {
        try SMAppService.mainApp.unregister()
      }
    }.runOnQueue(.main)

    Function("fileExists") { (path: String) -> Bool in FileManager.default.fileExists(atPath: path) }

    AsyncFunction("openFile") { (path: String) -> Bool in
      guard FileManager.default.fileExists(atPath: path) else { return false }
      if LaunchConfig.shared.background {
        NSLog("ArdiaSystem: background instance, not opening %@", path)
        return true
      }
      return NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }.runOnQueue(.main)

    AsyncFunction("revealFile") { (path: String) -> Bool in
      guard FileManager.default.fileExists(atPath: path) else { return false }
      if LaunchConfig.shared.background {
        NSLog("ArdiaSystem: background instance, not revealing %@", path)
        return true
      }
      NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
      return true
    }.runOnQueue(.main)

    AsyncFunction("moveToTrash") { (path: String) -> Bool in
      guard FileManager.default.fileExists(atPath: path) else { return false }
      do {
        try FileManager.default.trashItem(at: URL(fileURLWithPath: path), resultingItemURL: nil)
        return true
      } catch {
        return false
      }
    }.runOnQueue(.main)

    AsyncFunction("fileIcon") { (path: String, size: Double) -> String? in
      let icon = FileManager.default.fileExists(atPath: path)
        ? NSWorkspace.shared.icon(forFile: path)
        : NSWorkspace.shared.icon(for: .init(filenameExtension: (path as NSString).pathExtension) ?? .data)
      return icon.pngDataURL(points: CGFloat(size), scale: 2)
    }.runOnQueue(DispatchQueue.global(qos: .userInitiated))

    AsyncFunction("fileThumbnail") { (path: String, size: Double, ephemeral: Bool?) async -> String? in
      await ThumbnailCache.shared.thumbnail(path: path, points: size, scale: 2, ephemeral: ephemeral ?? false)
    }

    AsyncFunction("forgetThumbnails") { (paths: [String]?) async in
      await ThumbnailCache.shared.forget(paths: paths)
    }

    AsyncFunction("imageSize") { (path: String) -> [String: Int]? in
      ThumbnailCache.pixelSize(path)
    }.runOnQueue(DispatchQueue.global(qos: .utility))

    AsyncFunction("listFolderMedia") { (folder: String, limit: Int) -> [String: Any] in
      FolderMedia.list(folder, limit: limit)
    }.runOnQueue(DispatchQueue.global(qos: .userInitiated))

    Function("watchFolder") { [weak self] (token: String, folder: String) in
      FolderMediaWatches.shared.watch(token: token, folder: folder) { self?.sendEvent("onFolderChange", ["token": $0]) }
    }

    Function("unwatchFolder") { (token: String) in FolderMediaWatches.shared.stop(token: token) }

    AsyncFunction("runningAppIcon") { (pid: Int, size: Double) -> String? in
      NSRunningApplication(processIdentifier: pid_t(pid))?.icon?.pngDataURL(points: CGFloat(size), scale: 2)
    }.runOnQueue(.main)

    Function("hapticTick") {
      DispatchQueue.main.async {
        NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now)
        HapticLog.note("alignment")
      }
    }

    AsyncFunction("setThinScrollBars") { (thin: Bool) in ThinScrollBars.set(thin) }.runOnQueue(.main)
  }
}
