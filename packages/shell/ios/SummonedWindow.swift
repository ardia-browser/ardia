import AppKit
import ArdiaCore

enum SummonedWindow {
  private static let landingCheck: TimeInterval = 0.5

  static func bringForward(_ window: NSWindow) {
    window.orderFrontRegardless()
    window.makeKey()
  }

  static func makeKeyAndFront(_ window: NSWindow, summoned: Bool) {
    window.makeKeyAndOrderFront(nil)
    if summoned, SummonedLanding.needsRaise(own: getpid(), frontmost: frontmostPid) { window.orderFrontRegardless() }
  }

  static func checkLanding(_ window: NSWindow) {
    DispatchQueue.main.asyncAfter(deadline: .now() + landingCheck) { [weak window] in
      guard let window, window.isVisible else { return }
      let key = window.isKeyWindow
      let front = inFront(window)
      NSLog("[littleArdia] shortcut window landed key=%d front=%d", key ? 1 : 0, front ? 1 : 0)
      if key && front { return }
      ShellEvents.send(.app, ["type": "littleArdiaGlobalShortcutBehind"])
    }
  }

  private static var frontmostPid: Int32? { NSWorkspace.shared.frontmostApplication?.processIdentifier }

  private static func inFront(_ window: NSWindow) -> Bool {
    guard let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
    else { return false }
    let list = info.compactMap { entry -> SummonedLanding.Listed? in
      guard let number = (entry[kCGWindowNumber as String] as? NSNumber)?.intValue,
        let owner = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
        let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue
      else { return nil }
      return SummonedLanding.Listed(number: number, owner: owner, layer: layer)
    }
    return SummonedLanding.inFront(window.windowNumber, own: getpid(), frontmost: frontmostPid, frontToBack: list)
  }
}
