import AppKit
import ArdiaCore

final class SidebarEdgeWatcher {
  static let shared = SidebarEdgeWatcher()
  static let reach: CGFloat = 24
  static let revealStrip: CGFloat = 3

  var pointerOverride: NSPoint?
  private var backgroundPoint: NSPoint?
  private struct Watch {
    let rootHold: CGFloat
    let right: Bool
    let whilePressed: Bool
    var hold: CGFloat { InterfaceScale.windowLength(fromRoot: rootHold) }
    var strip: CGFloat { InterfaceScale.windowLength(fromRoot: SidebarEdgeWatcher.revealStrip) }
  }

  private var watched: [String: Watch] = [:]
  private var over: Set<String> = []
  private var pressedInside: Set<String> = []
  private var unreported: Set<String> = []
  private var buttonHeld = false
  private var wasPressed = false
  private var crossings: [String: ScreenEdgeCrossing] = [:]
  private var returnedTo: String?
  private var returnedThroughOverlay = false
  private var overlaid: Set<String> = []
  private var localMonitor: Any?
  private var globalMonitor: Any?
  private var observers: [NSObjectProtocol] = []
  private var dockApp: NSRunningApplication?
  private var lastHitWindow = 0
  private var lastHitIsDock = false
  private var lastHitMenuProbe = 0
  private var lastHitIsMenu = false
  private var heldByMenu: Set<String> = []
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
    if on { unreported.insert(id) } else { over.remove(id); heldByMenu.remove(id) }
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
    overlaid = []
    let screenEdge = crossScreenEdge(point, live: live)
    lazy var onDock = live && NSApp.isActive && isOnDock(point)
    let pressed = buttonHeld || (live && NSEvent.pressedMouseButtons != 0)
    if pressed && !wasPressed { pressedInside.formUnion(over.filter { watched[$0]?.whilePressed == true }) }
    wasPressed = pressed
    for (id, watch) in watched {
      guard let window = WindowManager.shared.window(id) else {
        watched[id] = nil
        over.remove(id)
        heldByMenu.remove(id)
        unreported.remove(id)
        crossings[id] = nil
        continue
      }
      if !pressed { pressedInside.remove(id) }
      let inColumn = Self.inColumn(point, window.frame, watch) && window.screen?.frame.contains(point) == true
      let menu = live && over.contains(id) && window.isVisible ? menuOwner(Self.windowNumber(at: point)) : nil
      let viaMenu = menu != nil
      let menuStarted = viaMenu && heldByMenu.insert(id).inserted
      if !viaMenu { heldByMenu.remove(id) }
      let now = viaMenu || (pressed && pressedInside.contains(id)) || (watch.whilePressed || !pressed) && (isOver(point, of: window, watch, live: live, holding: over.contains(id))
        || (inColumn && over.contains(id) && onDock)
        || (inColumn && isOver(point, of: window, watch, live: false) && onDock && isTopBeneathDock(point, of: window, right: watch.right))
        || returnedTo == id)
      let throughOverlay = now && (overlaid.contains(id) || (returnedTo == id && returnedThroughOverlay))
      let fresh = unreported.remove(id) != nil
      let edgeNote = screenEdge[id]
      guard fresh || now != over.contains(id) || edgeNote != nil || menuStarted else { continue }
      if now { over.insert(id) } else { over.remove(id) }
      let inRoot = InterfaceScale.rootPoint(fromScreen: point, in: window)
      var event: [String: Any] = ["type": "sidebarEdge", "id": id, "over": now, "point": [inRoot.x, inRoot.y]]
      if let edgeNote { event["screenEdge"] = edgeNote }
      if throughOverlay { event["overlay"] = true }
      if menuStarted, let menu { event["heldByMenu"] = menu }
      ShellEvents.send(.window, event)
    }
    if watched.isEmpty { return stop() }
    updateGlobalMonitor()
  }

  private func crossScreenEdge(_ point: NSPoint, live: Bool) -> [String: String] {
    let pressed = buttonHeld || (live && NSEvent.pressedMouseButtons != 0)
    let tracking = !pressed && (!live || (NSApp.isActive && !LaunchConfig.shared.background))
    if let id = returnedTo, !tracking || !nearScreenEdge(point, id, live: live) { returnedTo = nil }
    if returnedTo == nil { returnedThroughOverlay = false }
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
        Self.passedOverlay = false
        guard nearScreenEdge(point, id, live: live) else { continue }
        returnedTo = id
        returnedThroughOverlay = Self.passedOverlay
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

  private static func inBand(_ point: NSPoint, _ frame: NSRect, right: Bool, width: CGFloat) -> Bool {
    right
      ? point.x < frame.maxX && point.x >= frame.maxX - width
      : point.x >= frame.minX && point.x < frame.minX + width
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
    let inHold = Self.inBand(point, frame, right: watch.right, width: watch.hold)
    let inStrip = !inHold && live && Self.inBand(point, frame, right: watch.right, width: watch.strip)
    if inHold || inStrip {
      guard live else { return true }
      Self.passedOverlay = false
      let hit = NSApp.window(withWindowNumber: Self.windowNumber(at: NSPoint(x: point.x, y: insideY)))
      guard hit === window || hit?.parent === window, !inStrip || Self.passedOverlay else { return false }
      let through = Self.passedOverlay
      guard insideY == point.y || !Self.overAnotherOfOurs(point, besides: window) else { return false }
      if through, let id = watchedID(of: window) { overlaid.insert(id) }
      return true
    }
    guard Self.beyondEdge(point, frame, screen.frame, watch.right) else { return false }
    guard live else { return true }
    Self.passedOverlay = false
    guard Self.windowNumber(at: Self.insideEdge(frame, watch.right, y: insideY)) == window.windowNumber else { return false }
    let through = Self.passedOverlay
    if Self.overAnotherOfOurs(point, besides: window) { return false }
    guard NSApp.isActive || Self.besideScreenEdge(window, screen, right: watch.right) else { return false }
    if through, let id = watchedID(of: window) { overlaid.insert(id) }
    return true
  }

  private static func overAnotherOfOurs(_ point: NSPoint, besides window: NSWindow) -> Bool {
    let under = windowNumber(at: point)
    return under != window.windowNumber && NSApp.window(withWindowNumber: under) != nil
  }

  private static func windowNumber(at point: NSPoint, below start: Int = 0) -> Int {
    var number = NSWindow.windowNumber(at: point, belowWindowWithWindowNumber: start)
    while passesThrough(number, at: point) {
      let below = NSWindow.windowNumber(at: point, belowWindowWithWindowNumber: number)
      guard below != number else { break }
      number = below
    }
    return number
  }

  private static var passedOverlay = false
  private static var foreign: [Int: (overlay: ScreenOverlay?, at: TimeInterval)] = [:]

  private static func passesThrough(_ number: Int, at point: NSPoint) -> Bool {
    if let ours = NSApp.window(withWindowNumber: number) { return ours.ignoresMouseEvents }
    guard number > 0, let overlay = foreignWindow(number) else { return false }
    let windows = NSApp.windows.filter { $0.isVisible && $0.parent == nil }.map(\.frame)
    guard overlay.passesOver(point, displays: NSScreen.screens.map(\.frame), windows: windows, margin: reach) else { return false }
    passedOverlay = true
    return true
  }

  private static func foreignWindow(_ number: Int) -> ScreenOverlay? {
    let time = ProcessInfo.processInfo.systemUptime
    if let cached = foreign[number], time - cached.at < 1 { return cached.overlay }
    if foreign.count > 32 { foreign = [:] }
    let overlay = readForeignWindow(number)
    foreign[number] = (overlay, time)
    return overlay
  }

  private static func readForeignWindow(_ number: Int) -> ScreenOverlay? {
    guard let primary = NSScreen.screens.first?.frame,
      let info = (CGWindowListCopyWindowInfo(.optionIncludingWindow, CGWindowID(number)) as? [[String: Any]])?.first,
      let layer = info[kCGWindowLayer as String] as? Int,
      let cgBounds = (info[kCGWindowBounds as String] as? NSDictionary).flatMap({ CGRect(dictionaryRepresentation: $0) })
    else { return nil }
    let owner = (info[kCGWindowOwnerPID as String] as? pid_t).flatMap { NSRunningApplication(processIdentifier: $0)?.bundleIdentifier }
    let bounds = NSRect(x: cgBounds.minX, y: primary.maxY - cgBounds.maxY, width: cgBounds.width, height: cgBounds.height)
    let capturable = (info[kCGWindowSharingState as String] as? UInt32).map { $0 != CGWindowSharingType.none.rawValue } ?? true
    return ScreenOverlay(bounds: bounds, layer: layer, fromSlack: owner == ScreenOverlay.slackBundle, capturable: capturable)
  }

  private func menuOwner(_ number: Int) -> String? {
    guard number > 0 else { return nil }
    if let ours = NSApp.window(withWindowNumber: number) { return ours.level == .popUpMenu ? "app" : nil }
    if number != lastHitMenuProbe {
      lastHitMenuProbe = number
      lastHitIsMenu = Self.onMenuLayer(number)
    }
    return lastHitIsMenu ? "system" : nil
  }

  private static func onMenuLayer(_ number: Int) -> Bool {
    guard let info = CGWindowListCopyWindowInfo(.optionIncludingWindow, CGWindowID(number)) as? [[String: Any]],
      let layer = info.first?[kCGWindowLayer as String] as? Int
    else { return false }
    return layer == Int(CGWindowLevelForKey(.popUpMenuWindow))
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

  private func watchedID(of window: NSWindow) -> String? {
    watched.keys.first { WindowManager.shared.window($0) === window }
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
        Self.foreign = [:]
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
    heldByMenu = []
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
    Self.foreign = [:]
    for monitor in [localMonitor, globalMonitor].compactMap({ $0 }) { NSEvent.removeMonitor(monitor) }
    localMonitor = nil
    globalMonitor = nil
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers = []
  }
}
