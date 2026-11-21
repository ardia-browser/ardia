import AppKit
import ArdiaCore

final class LeavingOverPiP: NSObject {
  static let justNow = 1.0
  private var resignedActiveAt: TimeInterval = 0
  private var gaveFocusBackAt: TimeInterval = 0
  private var appLeftFor: NSRunningApplication?

  override init() {
    super.init()
    NotificationCenter.default.addObserver(self, selector: #selector(appDidResignActive(_:)), name: NSApplication.didResignActiveNotification, object: nil)
    NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(otherAppActivated(_:)), name: NSWorkspace.didActivateApplicationNotification, object: nil)
  }

  @objc private func appDidResignActive(_ notification: Notification) {
    resignedActiveAt = ProcessInfo.processInfo.systemUptime
  }

  @objc private func otherAppActivated(_ notification: Notification) {
    guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication, app != .current else { return }
    appLeftFor = app
  }

  func givesFocusBack() -> Bool {
    let now = ProcessInfo.processInfo.systemUptime
    let isPiP = { (window: NSWindow) in ArdiaChromeWindowHost.isVideoPicture(inPictureWindow: window) }
    guard !LaunchConfig.shared.background, NSApp.isActive, now - resignedActiveAt < LeavingOverPiP.justNow, !NSEvent.modifierFlags.contains(.command),
      NSApp.modalWindow == nil, NSApp.keyWindow.map({ isPiP($0) || !$0.isOnActiveSpace }) ?? true,
      NSApp.orderedWindows.contains(where: { $0.isVisible && $0.isOnActiveSpace && isPiP($0) }) else { return false }
    guard let app = appLeftFor, !app.isTerminated else { return false }
    let again = now - gaveFocusBackAt < 2 * LeavingOverPiP.justNow
    gaveFocusBackAt = now
    if !again {
      if #available(macOS 14.0, *) { app.activate(from: .current, options: []) } else { app.activate(options: []) }
    }
    ShellEvents.send(.app, ArdiaConsentStamp.begin().onto(["type": "pipActivationHandBack", "again": again]))
    return true
  }
}
