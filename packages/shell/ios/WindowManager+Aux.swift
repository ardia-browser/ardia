import AppKit
import ArdiaCore

extension WindowManager {
  func openAux(id: String, kind: WindowKind, title: String) {
    guard let makeContentView = WindowHost.makeContentView else { return }
    let settings = kind == .settings
    let design = settings ? NSSize(width: 820, height: 640) : NSSize(width: 640, height: 600)
    var style: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .fullSizeContentView]
    if settings { style.insert(.resizable) }
    let window = NSWindow(contentRect: NSRect(origin: .zero, size: design), styleMask: style, backing: .buffered, defer: false)
    let size = ArdiaChromeWindowHost.windowSize(fromInterface: design, for: window)
    window.setAccessibilitySubrole(.dialog)
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.title = title
    window.isReleasedWhenClosed = false
    window.tabbingMode = .disallowed
    let controller = UtilityContentController()
    let root = makeContentView(id)
    controller.view = root
    controller.view.frame = NSRect(origin: .zero, size: size)
    window.contentViewController = controller
    if settings { ArdiaChromeWindowHost.insetTrafficLights(of: window) }
    InterfaceScale.rootAttached(root)
    window.setContentSize(size)
    window.delegate = self
    let entry = ManagedWindow(id: id, kind: kind, window: window)
    managed[id] = entry
    if !window.setFrameUsingName(Self.auxFrameName(kind)) {
      window.center()
    } else if !settings {
      let top = window.frame.maxY
      window.setContentSize(size)
      window.setFrameTopLeftPoint(NSPoint(x: window.frame.minX, y: top))
    }
    ArdiaChromeWindowHost.setInterfaceMinSize(settings ? NSSize(width: 720, height: 480) : design, of: window)
    ArdiaChromeWindowHost.keepInterfaceContentSize(of: window)
    for name in [NSWindow.didMoveNotification, NSWindow.didResizeNotification] {
      NotificationCenter.default.addObserver(self, selector: #selector(auxFrameChanged(_:)), name: name, object: window)
    }
    entry.waitToReveal(entrance: nil, timeout: Self.revealTimeout) { [weak self] in self?.reveal($0) }
    entry.keepContentSized(in: root)
    entry.watchContent(of: root) { [weak self] entry, root in self?.contentAppeared(entry, root: root) }
    relayoutRoot(window)
    window.makeKeyAndOrderFront(nil)
  }

  static let auxFrameSaveDelay: TimeInterval = 0.3

  static func auxFrameName(_ kind: WindowKind) -> String { "Ardia\(kind.rawValue.capitalized)" }

  @objc func auxFrameChanged(_ notification: Notification) {
    guard let window = notification.object as? NSWindow else { return }
    NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(saveAuxFrame(_:)), object: window)
    perform(#selector(saveAuxFrame(_:)), with: window, afterDelay: Self.auxFrameSaveDelay)
  }

  @objc func saveAuxFrame(_ window: NSWindow) {
    guard let kind = kind(of: window), !kind.isBrowser else { return }
    window.saveFrame(usingName: Self.auxFrameName(kind))
  }
}
