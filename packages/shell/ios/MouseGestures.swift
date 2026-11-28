import AppKit
import ArdiaCore

final class MouseGestures {
  static let shared = MouseGestures()

  private var enabled = false
  private var monitor: Any?
  private var press: NSEvent?
  private weak var window: NSWindow?
  private var strokes = MouseGestureStrokes(start: .zero)
  private var trail: MouseGestureTrail?
  private var replaying = false
  private(set) var lastOutcome = "none"

  var isTracking: Bool { press != nil }

  func update(_ on: Bool) {
    enabled = on
    if on { install() } else if press == nil { uninstall() }
  }

  private func install() {
    guard monitor == nil else { return }
    monitor = NSEvent.addLocalMonitorForEvents(matching: [.rightMouseDown, .rightMouseDragged, .rightMouseUp]) { [weak self] event in
      guard let self else { return event }
      return self.filter(event)
    }
  }

  private func uninstall() {
    guard let monitor else { return }
    NSEvent.removeMonitor(monitor)
    self.monitor = nil
  }

  private func filter(_ event: NSEvent) -> NSEvent? {
    if replaying { return event }
    switch event.type {
    case .rightMouseDown: return began(event)
    case .rightMouseDragged:
      guard press != nil else { return event }
      moved(event)
      return nil
    case .rightMouseUp:
      guard press != nil else { return event }
      return ended(event)
    default: return event
    }
  }

  private static let ignoredModifiers: NSEvent.ModifierFlags = [.capsLock, .numericPad, .function]

  private func began(_ event: NSEvent) -> NSEvent? {
    finish()
    guard enabled, !ShortcutRecorder.shared.isRecording,
      event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting(Self.ignoredModifiers).isEmpty,
      let window = event.window, MouseShortcuts.browserWindowId(of: window) != nil,
      ArdiaWebView.hasPage(at: event.locationInWindow, in: window)
    else {
      lastOutcome = "passed"
      return event
    }
    press = event
    self.window = window
    strokes = MouseGestureStrokes(start: window.convertPoint(toScreen: event.locationInWindow))
    return nil
  }

  private func screenPoint(_ event: NSEvent) -> NSPoint {
    guard let window = event.window ?? window else { return event.locationInWindow }
    return window.convertPoint(toScreen: event.locationInWindow)
  }

  private func moved(_ event: NSEvent) {
    guard strokes.add(screenPoint(event)), strokes.isGesture, let window else { return }
    if trail == nil { trail = MouseGestureTrail(over: window) }
    trail?.draw(strokes.points, title: strokes.action?.title)
  }

  private func ended(_ event: NSEvent) -> NSEvent? {
    strokes.add(screenPoint(event))
    let press = self.press, window = self.window, strokes = self.strokes
    finish()
    guard strokes.isGesture else {
      lastOutcome = "menu"
      guard let press else { return event }
      replaying = true
      NSApp.sendEvent(press)
      replaying = false
      return event
    }
    guard let action = strokes.action, let window, let windowId = MouseShortcuts.browserWindowId(of: window),
      let item = MainMenu.commandItem(shortcutId: action.command)
    else {
      lastOutcome = "unrecognized"
      return nil
    }
    guard window !== NSApp.keyWindow || MenuTarget.shared.validateMenuItem(item) else {
      lastOutcome = "unavailable:\(action.command)"
      return nil
    }
    lastOutcome = action.command
    MenuTarget.shared.perform(item, in: window, windowId: windowId, mouseGesture: action.telemetry)
    return nil
  }

  private func finish() {
    press = nil
    trail?.close()
    trail = nil
    if !enabled { uninstall() }
  }

  #if DEBUG
  func devDrive(windowId: String, points: [[Double]], release: Bool) -> [String: Any] {
    guard let window = WindowManager.shared.window(windowId), let page = KeyEquivalents.pageViews(in: window).first else {
      return ["error": "no page in \(windowId)"]
    }
    let located = points.compactMap { xy -> NSPoint? in
      guard xy.count == 2 else { return nil }
      return page.convert(SyntheticInput.localPoint(x: xy[0], top: xy[1], in: page), to: nil)
    }
    func send(_ type: NSEvent.EventType, _ point: NSPoint) {
      guard let event = NSEvent.mouseEvent(
        with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
        windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: type == .rightMouseUp ? 0 : 1)
      else { return }
      NSApp.sendEvent(event)
    }
    for (index, point) in located.enumerated() {
      send(index == 0 && press == nil ? .rightMouseDown : .rightMouseDragged, point)
    }
    let trailWindow = trail?.windowNumber
    let title = trail?.title
    if release, let last = located.last { send(.rightMouseUp, last) }
    return [
      "outcome": release ? lastOutcome : "tracking", "tracking": isTracking, "installed": monitor != nil,
      "trailWindow": trailWindow as Any, "title": title as Any,
    ]
  }
  #endif
}

final class MouseGestureTrail {
  private let panel: NSPanel
  private let line = CAShapeLayer()
  private let badge = NSView()
  private let label = NSTextField(labelWithString: "")

  var windowNumber: Int { panel.windowNumber }
  var title: String? { badge.isHidden ? nil : label.stringValue }

  init(over window: NSWindow) {
    panel = NSPanel(contentRect: window.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.isReleasedWhenClosed = false
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.ignoresMouseEvents = true
    panel.collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary]
    let content = NSView(frame: NSRect(origin: .zero, size: window.frame.size))
    content.wantsLayer = true
    line.fillColor = nil
    line.strokeColor = NSColor.controlAccentColor.withAlphaComponent(0.9).cgColor
    line.lineWidth = 4
    line.lineCap = .round
    line.lineJoin = .round
    line.contentsScale = window.backingScaleFactor
    content.layer?.addSublayer(line)
    badge.wantsLayer = true
    badge.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.72).cgColor
    badge.layer?.cornerRadius = 8
    badge.isHidden = true
    label.font = .systemFont(ofSize: 15, weight: .semibold)
    label.textColor = .white
    badge.addSubview(label)
    content.addSubview(badge)
    panel.contentView = content
    window.addChildWindow(panel, ordered: .above)
  }

  func draw(_ screenPoints: [CGPoint], title: String?) {
    let origin = panel.frame.origin
    let path = CGMutablePath()
    for (index, point) in screenPoints.enumerated() {
      let local = CGPoint(x: point.x - origin.x, y: point.y - origin.y)
      if index == 0 { path.move(to: local) } else { path.addLine(to: local) }
    }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    line.path = path
    CATransaction.commit()
    guard let title else {
      badge.isHidden = true
      return
    }
    if label.stringValue != title {
      label.stringValue = title
      label.sizeToFit()
      let size = NSSize(width: label.frame.width + 28, height: label.frame.height + 14)
      let bounds = panel.contentView?.bounds ?? .zero
      badge.frame = NSRect(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2, width: size.width, height: size.height)
      label.setFrameOrigin(NSPoint(x: 14, y: 7))
    }
    badge.isHidden = false
  }

  func close() {
    panel.parent?.removeChildWindow(panel)
    panel.orderOut(nil)
  }
}
