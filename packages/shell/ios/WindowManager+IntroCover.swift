import AppKit
import ArdiaCore

extension WindowManager {
  func openIntroCover(id: String, over owner: String?) {
    guard let makeContentView = WindowHost.makeContentView else { return revealHeld(owner) }
    let browser = owner.flatMap { managed[$0]?.window } ?? managed.values.first(where: { $0.kind == .browser })?.window
    guard let screen = browser?.screen ?? NSScreen.main ?? NSScreen.screens.first else { return revealHeld(owner) }
    let background = LaunchConfig.shared.background
    let frame = background ? browser?.frame ?? screen.visibleFrame : screen.frame
    let window = IntroCoverWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.level = background ? .normal : NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) + 1)
    window.collectionBehavior = [.fullScreenAuxiliary, .stationary, .ignoresCycle]
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = false
    window.isReleasedWhenClosed = false
    window.animationBehavior = .none
    let controller = NSViewController()
    let root = makeContentView(id)
    controller.view = root
    root.frame = NSRect(origin: .zero, size: frame.size)
    window.contentViewController = controller
    window.setFrame(frame, display: false)
    InterfaceScale.rootAttached(root)
    window.delegate = self
    let entry = ManagedWindow(id: id, kind: .intro, window: window)
    Self.identify(window, id: id, kind: .intro)
    managed[id] = entry
    entry.keepContentSized(in: root)
    Self.clearBackdrop(root)
    entry.watchContent(of: root) { entry, root in
      Self.clearBackdrop(root)
      entry.keepContentSized(in: root)
    }
    relayoutRoot(window)
    if background, let browser {
      window.order(.above, relativeTo: browser.windowNumber)
    } else {
      window.makeKeyAndOrderFront(nil)
    }
  }

  private func revealHeld(_ owner: String?) {
    for id in owner.map({ [$0] }) ?? Array(heldHidden) { setShown(id: id, shown: true) }
  }

  static func clearBackdrop(_ view: NSView, depth: Int = 2) {
    view.wantsLayer = true
    view.layer?.backgroundColor = NSColor.clear.cgColor
    let setter = Selector(("setBackgroundColor:"))
    if view.responds(to: setter) { view.perform(setter, with: NSColor.clear) }
    guard depth > 0 else { return }
    for child in view.subviews { clearBackdrop(child, depth: depth - 1) }
  }

  func setShown(id: String, shown: Bool, burst: Bool = false) {
    if !shown { heldHidden.insert(id) }
    guard let entry = managed[id] else {
      if shown { heldHidden.remove(id) }
      return
    }
    let window = entry.window
    if !shown {
      window.alphaValue = 0
      window.ignoresMouseEvents = true
      return
    }
    guard heldHidden.remove(id) != nil else { return }
    window.ignoresMouseEvents = false
    if entry.isWaitingToReveal { return }
    if !LaunchConfig.shared.background { window.makeKeyAndOrderFront(nil) }
    WindowMotion.enter(window, style: burst ? .burst : .main, scales: true)
  }
}

final class IntroCoverWindow: NSWindow {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
}
