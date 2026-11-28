import AppKit
import ArdiaCore

final class MouseGestures {
  static let shared = MouseGestures()

  private var enabled = false
  private var monitor: Any?
  private var resigning: NSObjectProtocol?
  private var closing: NSObjectProtocol?
  private var press: NSEvent?
  private weak var page: NSView?
  private var pageTab: String?
  private weak var window: NSWindow?
  private var strokes = MouseGestureStrokes(start: .zero)
  private var cancelled = false
  private var trail: MouseGestureTrail?
  private var replays: [NSEvent] = []
  private var releaseWatch: Timer?
  private var releasedSince: TimeInterval?
  private var driven = false
  private(set) var lastOutcome = "none"

  var isTracking: Bool { press != nil }

  func update(_ on: Bool) {
    enabled = on
    if on { return install() }
    if press == nil { uninstall() } else { cancel() }
  }

  private func install() {
    guard monitor == nil else { return }
    monitor = NSEvent.addLocalMonitorForEvents(matching: [.rightMouseDown, .rightMouseDragged, .rightMouseUp]) { [weak self] event in
      guard let self else { return event }
      return self.filter(event)
    }
    resigning = NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
      self?.cancel()
    }
  }

  private func uninstall() {
    if let monitor { NSEvent.removeMonitor(monitor) }
    if let resigning { NotificationCenter.default.removeObserver(resigning) }
    monitor = nil
    resigning = nil
    replays = []
  }

  private func filter(_ event: NSEvent) -> NSEvent? {
    if let replay = replays.first, replay.type == event.type, replay.timestamp == event.timestamp {
      replays.removeFirst()
      return event
    }
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

  private static func overPeek(_ event: NSEvent, in window: NSWindow) -> Bool {
    if PeekInputRoute.routed?.timestamp == event.timestamp { return true }
    return PeekStage.stages.allObjects.contains { stage in
      guard stage.window === window, let parent = stage.superview else { return false }
      return stage.hitTest(parent.convert(event.locationInWindow, from: nil)) != nil
    }
  }

  private func began(_ event: NSEvent) -> NSEvent? {
    finish()
    replays.removeAll { event.timestamp - $0.timestamp > 1 }
    guard enabled, !ShortcutRecorder.shared.isRecording,
      event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting(Self.ignoredModifiers).isEmpty,
      let window = event.window, MouseShortcuts.browserWindowId(of: window) != nil, !Self.overPeek(event, in: window),
      let page = ArdiaWebView.pageView(at: event.locationInWindow, in: window), !ArdiaWebView.tabId(ofPageView: page).isEmpty
    else {
      lastOutcome = "passed"
      return event
    }
    press = event
    self.page = page
    pageTab = ArdiaWebView.tabId(ofPageView: page)
    self.window = window
    strokes = MouseGestureStrokes(start: window.convertPoint(toScreen: event.locationInWindow))
    closing = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
      self?.cancel()
    }
    releasedSince = nil
    releaseWatch = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.checkRelease() }
    return nil
  }

  private static let lostReleaseSeconds: TimeInterval = 0.5

  private func checkRelease() {
    guard press != nil, !driven else { return }
    guard NSEvent.pressedMouseButtons & 0b10 == 0 else {
      releasedSince = nil
      return
    }
    let now = ProcessInfo.processInfo.systemUptime
    guard let since = releasedSince else {
      releasedSince = now
      return
    }
    guard now - since > Self.lostReleaseSeconds else { return }
    lastOutcome = "abandoned"
    finish()
  }

  private func screenPoint(_ event: NSEvent) -> NSPoint {
    guard let window = event.window else { return event.locationInWindow }
    return window.convertPoint(toScreen: event.locationInWindow)
  }

  private func moved(_ event: NSEvent) {
    guard !cancelled, strokes.add(screenPoint(event)), strokes.isGesture, let window else { return }
    if trail == nil { trail = MouseGestureTrail(over: window) }
    trail?.draw(strokes.points, title: strokes.action?.title)
  }

  private func cancel() {
    guard press != nil else { return }
    cancelled = true
    trail?.close()
    trail = nil
  }

  private func ended(_ event: NSEvent) -> NSEvent? {
    strokes.add(screenPoint(event))
    let press = self.press, window = self.window, page = self.page, pageTab = self.pageTab, strokes = self.strokes, cancelled = self.cancelled
    finish()
    if cancelled {
      lastOutcome = "cancelled"
      return nil
    }
    guard let press, let window, let page, let pageTab, window.isVisible, ArdiaWebView.pageView(at: press.locationInWindow, in: window) === page,
      ArdiaWebView.tabId(ofPageView: page) == pageTab
    else {
      lastOutcome = "pageGone"
      return nil
    }
    guard strokes.isGesture else {
      lastOutcome = "menu"
      replays = [press, event]
      NSApp.postEvent(event, atStart: true)
      NSApp.postEvent(press, atStart: true)
      return nil
    }
    guard let action = strokes.action, let windowId = MouseShortcuts.browserWindowId(of: window),
      let item = MainMenu.commandItem(shortcutId: action.command)
    else {
      lastOutcome = "unrecognized"
      return nil
    }
    let inBrowserWindow = WindowManager.shared.kind(of: window) == .browser
    guard inBrowserWindow || window !== NSApp.keyWindow || MenuTarget.shared.validateMenuItem(item) else {
      lastOutcome = "unavailable:\(action.command)"
      return nil
    }
    lastOutcome = action.command
    MenuTarget.shared.perform(item, in: window, windowId: windowId, mouseGesture: action.telemetry, gestureTab: pageTab)
    return nil
  }

  private func finish() {
    press = nil
    page = nil
    releaseWatch?.invalidate()
    releaseWatch = nil
    releasedSince = nil
    driven = false
    pageTab = nil
    cancelled = false
    trail?.close()
    trail = nil
    if let closing { NotificationCenter.default.removeObserver(closing) }
    closing = nil
    if !enabled { uninstall() }
  }

  #if DEBUG
  func devDrive(windowId: String, points: [[Double]], release: Bool) -> [String: Any] {
    guard let window = WindowManager.shared.window(windowId), let root = SyntheticInput.root(of: window) else {
      return ["error": "no window \(windowId)"]
    }
    let located = points.compactMap { xy -> NSPoint? in
      guard xy.count == 2 else { return nil }
      return root.convert(SyntheticInput.localPoint(x: xy[0], top: xy[1], in: root), to: nil)
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
      if press != nil { driven = true }
    }
    let trailWindow = trail?.windowNumber
    let title = trail?.title
    if release, let last = located.last { send(.rightMouseUp, last) }
    return [
      "outcome": release ? lastOutcome : "tracking", "tracking": isTracking, "installed": monitor != nil,
      "trailWindow": trailWindow as Any, "title": title as Any, "pageTab": pageTab as Any,
    ]
  }
  #endif
}

final class MouseGestureTrail {
  private final class Panel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
  }

  private let panel: Panel
  private let line = CAShapeLayer()
  private let badge = NSView()
  private let label = NSTextField(labelWithString: "")

  var windowNumber: Int { panel.windowNumber }
  var title: String? { badge.isHidden ? nil : label.stringValue }

  init(over window: NSWindow) {
    panel = Panel(contentRect: window.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
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
