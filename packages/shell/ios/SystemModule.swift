import AppKit
import ArdiaCore
import ExpoModulesCore
import ServiceManagement
import UniformTypeIdentifiers

public class SystemModule: Module, SystemNative {
  static var backgroundInstance: Bool { LaunchConfig.shared.background }

  static func isDefaultBrowser() -> Bool {
    guard let probe = URL(string: "https://example.com"),
          let handler = NSWorkspace.shared.urlForApplication(toOpen: probe) else { return false }
    return handler.standardizedFileURL == Bundle.main.bundleURL.standardizedFileURL
  }

  static func setAsDefaultBrowser(_ promise: Promise) {
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
  }

  static func launchAtLoginStatus() -> String {
    switch SMAppService.mainApp.status {
    case .enabled: return "enabled"
    case .requiresApproval: return "requiresApproval"
    case .notFound: return "notFound"
    default: return "notRegistered"
    }
  }

  static func setLaunchAtLogin(_ enabled: Bool) throws {
    if LaunchConfig.shared.background {
      NSLog("ArdiaSystem: background instance, not changing launch at login")
      return
    }
    if enabled {
      try SMAppService.mainApp.register()
    } else {
      try SMAppService.mainApp.unregister()
    }
  }

  static func fileExists(_ path: String) -> Bool { FileManager.default.fileExists(atPath: path) }

  static func openFile(_ path: String, _ promise: Promise) {
    guard FileManager.default.fileExists(atPath: path) else { return promise.resolve(false) }
    if LaunchConfig.shared.background {
      NSLog("ArdiaSystem: background instance, not opening %@", path)
      return promise.resolve(true)
    }
    NSWorkspace.shared.open(URL(fileURLWithPath: path), configuration: NSWorkspace.OpenConfiguration()) { _, error in
      promise.resolve(error == nil)
    }
  }

  static func revealFile(_ path: String) -> Bool {
    guard FileManager.default.fileExists(atPath: path) else { return false }
    if LaunchConfig.shared.background {
      NSLog("ArdiaSystem: background instance, not revealing %@", path)
      return true
    }
    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    return true
  }

  static func moveToTrash(_ path: String) -> Bool {
    guard FileManager.default.fileExists(atPath: path) else { return false }
    do {
      try FileManager.default.trashItem(at: URL(fileURLWithPath: path), resultingItemURL: nil)
      return true
    } catch {
      return false
    }
  }

  static func fileIcon(_ path: String, _ size: Double) -> String? {
    let icon = FileManager.default.fileExists(atPath: path)
      ? NSWorkspace.shared.icon(forFile: path)
      : NSWorkspace.shared.icon(for: .init(filenameExtension: (path as NSString).pathExtension) ?? .data)
    return icon.pngDataURL(points: CGFloat(size), scale: 2)
  }

  static func runningAppIcon(_ pid: Int, _ size: Double) -> String? { NSRunningApplication(processIdentifier: pid_t(pid))?.icon?.pngDataURL(points: CGFloat(size), scale: 2) }

  static func hapticTick() {
    DispatchQueue.main.async {
      NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now)
      HapticLog.note("alignment")
    }
  }

  static func setThinScrollBars(_ thin: Bool) { ThinScrollBars.set(thin) }

  public func definition() -> ModuleDefinition {
    Name(Self.moduleName)

    Self.backgroundInstanceConstant

    Self.isDefaultBrowserFunction

    Self.setAsDefaultBrowserFunction

    Self.launchAtLoginStatusFunction

    Self.setLaunchAtLoginFunction

    Self.fileExistsFunction

    Self.openFileFunction

    Self.revealFileFunction

    Self.moveToTrashFunction

    Self.fileIconFunction

    Self.runningAppIconFunction

    Self.hapticTickFunction

    Self.setThinScrollBarsFunction
  }
}
