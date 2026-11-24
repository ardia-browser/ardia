import AppKit
import ArdiaCore

final class SidebarEdgeWatcher {
  static let shared = SidebarEdgeWatcher()
  static let reach: CGFloat = 24

  var pointerOverride: NSPoint?
  private var backgroundPoint: NSPoint?
  private struct Watch {
    let rootHold: CGFloat
    let right: Bool
    let whilePressed: Bool
    var hold: CGFloat { InterfaceScale.windowLength(fromRoot: rootHold) }
  }

  private var watched: [String: Watch] = [:]
  private var over: Set<String> = []
  private var pressedInside: Set<String> = []
  private var unreported: Set<String> = []
  private var buttonHeld = false
  private var wasPressed = false
  private var crossings: [String: ScreenEdgeCrossing] = [:]
  private var returnedTo: String?
  private var localMonitor: Any?
  private var globalMonitor: Any?
  private var observers: [NSObjectProtocol] = []
  private var dockApp: NSRunningApplication?
  private var lastHitWindow = 0
  private var lastHitIsDock = false
  #if DEBUG
  private(set) var wakes: [String: Int] = ["global": 0, "local": 0]
  var stats: [String: Any] { ["wakes": wakes, "global": globalMonitor != nil, "local": localMonitor != nil, "watched": watched.count] }
  func resetStats() { wakes = ["global": 0, "local": 0] }
  #endif

  private static let pointerEvents: NSEvent.EventTypeMask = [
    .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .leftMouseUp, .rightMouseUp, .otherMouseUp,
  ]
  private static let localEvents: NSEvent.EventTypeMask = pointerEvents.union([.leftMouseDown, .rightMouseDown, .otherMouseDown])

  func watch(id: String, on: Bool, hold: CGFloat, right: Bool, whilePressed: Bool) {
    watched[id] = on ? Watch(rootHold: max(0, hold), right: right, whilePressed: whilePressed) : nil
    if on { unreported.insert(id) } else { over.remove(id) }
    if !on, crossings[id]?.awaitingReturn(at: ProcessInfo.processInfo.systemUptime) != true { crossings[id] = nil }
    if watched.isEmpty { return stop() }
    start()
    checkPointer()
  }

  func checkPointer() {
    if let pointerOverride { return check(pointerOverride, live: false) }
    if let backgroundPoint { return check(backgroundPoint, live: false) }
    check(NSEvent.mouseLocation, live: true)
  }

  private func checkPointer(after event: NSEvent) {
    if LaunchConfig.shared.background, let window = event.window {
      backgroundPoint = window.convertPoint(toScreen: event.locationInWindow)
    }
    checkPointer()
  }

  private func noteButtons(_ event: NSEvent) {
    switch event.type {
    case .leftMouseDown, .rightMouseDown, .otherMouseDown:
      buttonHeld = true
      pressedInside.formUnion(over.filter { watched[$0]?.whilePressed == true })
    case .leftMouseDragged, .rightMouseDragged, .otherMouseDragged: buttonHeld = true
    case .leftMouseUp, .rightMouseUp, .otherMouseUp, .mouseMoved:
      buttonHeld = false
      pressedInside = []
    default: break
    }
  }

  private func check(_ point: NSPoint, live: Bool) {
    let screenEdge = crossScreenEdge(point, live: live)
    lazy var onDock = live && NSApp.isActive && isOnDock(point)
    let pressed = buttonHeld || (live && NSEvent.pressedMouseButtons != 0)
    if pressed && !wasPressed { pressedInside.formUnion(over.filter { watched[$0]?.whilePressed == true }) }
    wasPressed = pressed
    for (id, watch) in watched {
      guard let window = WindowManager.shared.window(id) else {
        watched[id] = nil
        over.remove(id)
        unreported.remove(id)
        crossings[id] = nil
        continue
      }
      if !pressed { pressedInside.remove(id) }
      let inColumn = Self.inColumn(point, window.frame, watch) && window.screen?.frame.contains(point) == true
      let now = (pressed && pressedInside.contains(id)) || (watch.whilePressed || !pressed) && (isOver(point, of: window, watch, live: live, holding: over.contains(id))
        || (inColumn && over.contains(id) && onDock)
        || (inColumn && isOver(point, of: window, watch, live: false) && onDock && isTopBeneathDock(point, of: window, right: watch.right))
        || returnedTo == id)
      let fresh = unreported.remove(id) != nil
      let edgeNote = screenEdge[id]
      guard fresh || now != over.contains(id) || edgeNote != nil else { continue }
      if now { over.insert(id) } else { over.remove(id) }
      let inRoot = InterfaceScale.rootPoint(fromScreen: point, in: window)
      var event: [String: Any] = ["type": "sidebarEdge", "id": id, "over": now, "point": [inRoot.x, inRoot.y]]
      if let edgeNote { event["screenEdge"] = edgeNote }
      ShellEvents.send(.window, event)
    }
    if watched.isEmpty { return stop() }
    updateGlobalMonitor()
  }

  private func crossScreenEdge(_ point: NSPoint, live: Bool) -> [String: String] {
    let pressed = buttonHeld || (live && NSEvent.pressedMouseButtons != 0)
    let tracking = !pressed && (!live || (NSApp.isActive && !LaunchConfig.shared.background))
    if let id = returnedTo, !tracking || !nearScreenEdge(point, id, live: live) { returnedTo = nil }
    let time = ProcessInfo.processInfo.systemUptime
    for (id, crossing) in crossings where watched[id] == nil && !crossing.awaitingReturn(at: time) { crossings[id] = nil }
    var notes: [String: String] = [:]
    for (id, watch) in watched {
      guard tracking, let window = WindowManager.shared.window(id), let screen = window.screen,
        window.isVisible, !window.isMiniaturized, !window.styleMask.contains(.fullScreen),
        Self.inRows(point, window.frame), Self.sidebarSideAtScreenEdge(window, screen, right: watch.right)
      else {
        crossings[id] = nil
        continue
      }
      let edgeX = Self.screenEdgeX(screen.frame, watch.right)
      let past = watch.right ? point.x.rounded(.down) - edgeX : edgeX - point.x.rounded(.down)
      guard let move = crossings[id, default: ScreenEdgeCrossing()].track(past: past, at: time) else { continue }
      switch move {
      case .crossed:
        if live {
          let hit = NSApp.window(withWindowNumber: Self.windowNumber(at: Self.insideEdge(window.frame, watch.right, y: point.y)))
          guard hit === window || hit?.parent === window else {
            crossings[id] = nil
            continue
          }
        }
        if returnedTo == id { returnedTo = nil }
        notes[id] = "crossed"
      case .returned:
        guard nearScreenEdge(point, id, live: live) else { continue }
        returnedTo = id
        notes[id] = "returned"
      }
    }
    return notes
  }

  private func nearScreenEdge(_ point: NSPoint, _ id: String, live: Bool) -> Bool {
    guard let watch = watched[id], let window = WindowManager.shared.window(id), let display = window.screen else { return false }
    let reach = max(watch.hold, ScreenEdgeCrossing.reach)
    let frame = window.frame
    let inside = watch.right ? point.x >= frame.maxX - reach && point.x < frame.maxX : point.x >= frame.minX && point.x < frame.minX + reach
    guard inside, Self.inRows(point, frame), Self.sidebarSideAtScreenEdge(window, display, right: watch.right) else { return false }
    guard live else { return true }
    let hit = NSApp.window(withWindowNumber: Self.windowNumber(at: point))
    return hit === window || hit?.parent === window
  }

  private static func sidebarSideAtScreenEdge(_ window: NSWindow, _ screen: NSScreen, right: Bool) -> Bool {
    let inside = right ? window.frame.maxX <= screen.frame.maxX : window.frame.minX >= screen.frame.minX
    return inside && besideScreenEdge(window, screen, right: right)
  }

  private static func screenEdgeX(_ screen: NSRect, _ right: Bool) -> CGFloat {
    right ? screen.maxX - 1 : screen.minX
  }

  private static func inRows(_ point: NSPoint, _ frame: NSRect) -> Bool {
    point.y >= frame.minY && point.y < frame.maxY
  }

  private static func inColumn(_ point: NSPoint, _ frame: NSRect, _ watch: Watch) -> Bool {
    watch.right ? point.x >= frame.maxX - watch.hold : point.x < frame.minX + watch.hold
  }

  private static func inBand(_ point: NSPoint, _ frame: NSRect, _ watch: Watch) -> Bool {
    watch.right
      ? point.x < frame.maxX && point.x >= frame.maxX - watch.hold
      : point.x >= frame.minX && point.x < frame.minX + watch.hold
  }

  private static func beyondEdge(_ point: NSPoint, _ frame: NSRect, _ screen: NSRect, _ right: Bool) -> Bool {
    right
      ? point.x >= frame.maxX && point.x < min(screen.maxX, frame.maxX + reach)
      : point.x < frame.minX && point.x >= max(screen.minX, frame.minX - reach)
  }

  private static func insideEdge(_ frame: NSRect, _ right: Bool, y: CGFloat) -> NSPoint {
    NSPoint(x: right ? frame.maxX - 1 : frame.minX + 1, y: y)
  }

  private func isOver(_ point: NSPoint, of window: NSWindow, _ watch: Watch, live: Bool, holding: Bool = false) -> Bool {
    guard window.isVisible, !window.isMiniaturized, let screen = window.screen else { return false }
    let frame = window.frame
    let slack = holding ? Self.reach : 0
    guard point.y >= frame.minY - slack, point.y < frame.maxY + slack else { return false }
    let insideY = min(max(point.y, frame.minY), frame.maxY - 1)
    if Self.inBand(point, frame, watch) {
      guard live else { return true }
      let hit = NSApp.window(withWindowNumber: Self.windowNumber(at: NSPoint(x: point.x, y: insideY)))
      guard hit === window || hit?.parent === window else { return false }
      return insideY == point.y || !Self.overAnotherOfOurs(point, besides: window)
    }
    guard Self.beyondEdge(point, frame, screen.frame, watch.right) else { return false }
    guard live else { return true }
    guard Self.windowNumber(at: Self.insideEdge(frame, watch.right, y: insideY)) == window.windowNumber else { return false }
    if Self.overAnotherOfOurs(point, besides: window) { return false }
    return NSApp.isActive || Self.besideScreenEdge(window, screen, right: watch.right)
  }

  private static func overAnotherOfOurs(_ point: NSPoint, besides window: NSWindow) -> Bool {
    let under = windowNumber(at: point)
    return under != window.windowNumber && NSApp.window(withWindowNumber: under) != nil
  }

  private static func windowNumber(at point: NSPoint, below start: Int = 0) -> Int {
    var number = NSWindow.windowNumber(at: point, belowWindowWithWindowNumber: start)
    while let passThrough = NSApp.window(withWindowNumber: number), passThrough.ignoresMouseEvents {
      let below = NSWindow.windowNumber(at: point, belowWindowWithWindowNumber: number)
      guard below != number else { break }
      number = below
    }
    return number
  }

  private func isOnDock(_ point: NSPoint) -> Bool {
    isDock(Self.windowNumber(at: point))
  }

  private func isTopBeneathDock(_ point: NSPoint, of window: NSWindow, right: Bool) -> Bool {
    let edge = Self.insideEdge(window.frame, right, y: point.y)
    let probe = NSPoint(x: right ? min(point.x, edge.x) : max(point.x, edge.x), y: point.y)
    var number = Self.windowNumber(at: probe)
    while isDock(number) {
      let below = Self.windowNumber(at: probe, below: number)
      guard below != number else { break }
      number = below
    }
    let hit = NSApp.window(withWindowNumber: number)
    return hit === window || hit?.parent === window
  }

  private func isDock(_ number: Int) -> Bool {
    guard number > 0, NSApp.window(withWindowNumber: number) == nil else { return false }
    if number != lastHitWindow {
      lastHitWindow = number
      lastHitIsDock = isDockWindow(number)
    }
    return lastHitIsDock
  }

  private func isDockWindow(_ number: Int) -> Bool {
    if dockApp?.isTerminated ?? true {
      dockApp = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first
    }
    guard let dockApp,
      let info = CGWindowListCopyWindowInfo(.optionIncludingWindow, CGWindowID(number)) as? [[String: Any]],
      let owner = info.first?[kCGWindowOwnerPID as String] as? pid_t,
      let layer = info.first?[kCGWindowLayer as String] as? Int
    else { return false }
    return owner == dockApp.processIdentifier && layer >= Int(CGWindowLevelForKey(.dockWindow))
  }

  private static func besideScreenEdge(_ window: NSWindow, _ screen: NSScreen, right: Bool) -> Bool {
    (right ? screen.frame.maxX - window.frame.maxX : window.frame.minX - screen.frame.minX) <= reach
  }

  private var needsGlobalMonitor: Bool {
    if NSApp.isActive || !over.isEmpty { return true }
    return watched.contains { id, watch in
      guard let window = WindowManager.shared.window(id) else { return false }
      if watch.rootHold > 0 { return true }
      guard let screen = window.screen else { return false }
      return Self.besideScreenEdge(window, screen, right: watch.right)
    }
  }

  private func updateGlobalMonitor() {
    let needed = !watched.isEmpty && needsGlobalMonitor
    guard needed != (globalMonitor != nil) else { return }
    if let globalMonitor {
      NSEvent.removeMonitor(globalMonitor)
      self.globalMonitor = nil
      return
    }
    globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: Self.pointerEvents, handler: { [weak self] event in
      #if DEBUG
      self?.wakes["global", default: 0] += 1
      #endif
      self?.noteButtons(event)
      self?.checkPointer()
    })
  }

  private func isWatched(_ window: NSWindow) -> Bool {
    watched.keys.contains { WindowManager.shared.window($0) === window }
  }

  private func start() {
    if localMonitor == nil {
      localMonitor = NSEvent.addLocalMonitorForEvents(matching: Self.localEvents, handler: { [weak self] event in
        #if DEBUG
        self?.wakes["local", default: 0] += 1
        #endif
        self?.noteButtons(event)
        self?.checkPointer(after: event)
        return event
      })
    }
    if observers.isEmpty {
      let center = NotificationCenter.default
      for name in [NSApplication.didBecomeActiveNotification, NSApplication.didResignActiveNotification] {
        observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
          self?.checkPointer()
        })
      }
      observers.append(center.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
        self?.updateGlobalMonitor()
      })
      observers.append(center.addObserver(forName: .ArdiaInterfaceScaleDidChange, object: nil, queue: .main) { [weak self] _ in
        self?.checkPointer()
      })
      for name in [NSWindow.didMoveNotification, NSWindow.didResizeNotification, NSWindow.didChangeScreenNotification] {
        observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
          guard let self, let window = note.object as? NSWindow, self.isWatched(window) else { return }
          self.updateGlobalMonitor()
        })
      }
    }
    updateGlobalMonitor()
  }

  func reset() {
    watched = [:]
    over = []
    pressedInside = []
    unreported = []
    crossings = [:]
    returnedTo = nil
    pointerOverride = nil
    backgroundPoint = nil
    stop()
  }

  private func stop() {
    returnedTo = nil
    for monitor in [localMonitor, globalMonitor].compactMap({ $0 }) { NSEvent.removeMonitor(monitor) }
    localMonitor = nil
    globalMonitor = nil
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers = []
  }
}
