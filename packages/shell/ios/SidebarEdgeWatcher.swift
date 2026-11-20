import AppKit
import ArdiaCore

final class SidebarEdgeWatcher {
  static let shared = SidebarEdgeWatcher()
  static let reach: CGFloat = SidebarEdgeRegions.inactiveEdgeReach
  static let pushThrough: TimeInterval = 0.35

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
  private var trackers: [String: SidebarEdgeTracker] = [:]
  private var dwellWorkItem: DispatchWorkItem?
  private var buttonHeld = false
  private var wasPressed = false
  private var lastPoint: NSPoint?
  private var stoppedAtScreenEdge: String?
  private var crossing = ScreenEdgeCrossing()
  private var overSince: [String: TimeInterval] = [:]
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
    if on {
      let wasWatched = watched[id] != nil
      watched[id] = Watch(rootHold: max(0, hold), right: right, whilePressed: whilePressed)
      if !wasWatched {
        unreported.insert(id)
        trackers[id] = SidebarEdgeTracker()
      }
    } else {
      watched[id] = nil
      over.remove(id)
      overSince[id] = nil
      trackers[id] = nil
      unreported.remove(id)
    }
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

  private func check(_ pointer: NSPoint, live: Bool) {
    let nowTime = ProcessInfo.processInfo.systemUptime
    let (point, screenEdge) = stopAtScreenEdge(pointer, live: live)
    lazy var onDock = live && NSApp.isActive && isOnDock(point)
    let pressed = buttonHeld || (live && NSEvent.pressedMouseButtons != 0)
    if pressed && !wasPressed { pressedInside.formUnion(over.filter { watched[$0]?.whilePressed == true }) }
    wasPressed = pressed
    var earliestDeadline: TimeInterval?
    for (id, watch) in watched {
      guard let window = WindowManager.shared.window(id) else {
        watched[id] = nil
        over.remove(id)
        overSince[id] = nil
        trackers[id] = nil
        unreported.remove(id)
        continue
      }
      if !pressed { pressedInside.remove(id) }
      var tracker = trackers[id] ?? SidebarEdgeTracker()
      let fresh = unreported.remove(id) != nil
      let edgeNote = screenEdge?.id == id ? screenEdge?.note : nil
      let evaluation = evaluate(
        point: point,
        of: window,
        watch: watch,
        id: id,
        live: live,
        pressed: pressed,
        onDock: onDock,
        tracker: &tracker,
        time: nowTime,
        initial: fresh
      )
      trackers[id] = tracker
      if let deadline = evaluation.nextDeadline {
        earliestDeadline = earliestDeadline.map { min($0, deadline) } ?? deadline
      }
      let now = evaluation.over
      guard fresh || now != over.contains(id) || edgeNote != nil else { continue }
      if now, !over.contains(id) { overSince[id] = nowTime }
      if now { over.insert(id) } else { over.remove(id) }
      let inRoot = InterfaceScale.rootPoint(fromScreen: point, in: window)
      var event: [String: Any] = ["type": "sidebarEdge", "id": id, "over": now, "point": [inRoot.x, inRoot.y]]
      if let edgeNote { event["screenEdge"] = edgeNote }
      ShellEvents.send(.window, event)
    }
    if watched.isEmpty { return stop() }
    scheduleDwell(until: earliestDeadline, now: nowTime)
    updateGlobalMonitor()
  }

  private func scheduleDwell(until deadline: TimeInterval?, now: TimeInterval) {
    dwellWorkItem?.cancel()
    dwellWorkItem = nil
    guard let deadline else { return }
    let delay = max(0.001, deadline - now)
    let work = DispatchWorkItem { [weak self] in
      self?.dwellWorkItem = nil
      self?.checkPointer()
    }
    dwellWorkItem = work
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
  }

  private func stopAtScreenEdge(_ point: NSPoint, live: Bool) -> (NSPoint, (id: String, note: String)?) {
    let pressed = buttonHeld || (live && NSEvent.pressedMouseButtons != 0)
    let tracking = !pressed && (!live || (NSApp.isActive && !LaunchConfig.shared.background))
    let alreadyStopped = stoppedAtScreenEdge
    if let id = stoppedAtScreenEdge, !tracking || !restsAtScreenEdge(point, id, live: live) { stoppedAtScreenEdge = nil }
    let from = lastPoint
    lastPoint = tracking ? point : nil
    if tracking { crossing.track(point, at: ProcessInfo.processInfo.systemUptime) } else { crossing.forget() }
    guard let from, lastPoint != nil else { return (point, nil) }
    for (id, watch) in watched {
      guard let window = WindowManager.shared.window(id), let screen = window.screen,
        window.isVisible, !window.isMiniaturized, !window.styleMask.contains(.fullScreen),
        Self.crossesScreenEdge(from, point, screen.frame, watch.right), Self.inRows(point, window.frame),
        Self.sidebarSideAtScreenEdge(window, screen, right: watch.right),
        !live || Self.isWindowOrChild(Self.windowNumber(at: Self.insideEdge(window.frame, watch.right, y: point.y)), of: window)
      else { continue }
      let edgeX = Self.screenEdgeX(screen.frame, watch.right)
      let first = alreadyStopped != id
      if first {
        crossing.startPush()
        if crossing.isFling(right: watch.right) { return (point, (id, "flung")) }
      } else if crossing.push(by: watch.right ? point.x - edgeX : edgeX - point.x) {
        stoppedAtScreenEdge = nil
        return (point, (id, "passed"))
      }
      if over.contains(id), let since = overSince[id], ProcessInfo.processInfo.systemUptime - since >= Self.pushThrough {
        stoppedAtScreenEdge = nil
        return (point, (id, "passed"))
      }
      let edge = NSPoint(x: edgeX, y: point.y)
      stoppedAtScreenEdge = id
      lastPoint = edge
      if live {
        CGWarpMouseCursorPosition(CGPoint(x: edge.x, y: (NSScreen.screens.first?.frame.maxY ?? 0) - edge.y))
        CGAssociateMouseAndMouseCursorPosition(1)
      } else if pointerOverride != nil {
        pointerOverride = edge
      } else {
        backgroundPoint = edge
      }
      return (edge, first ? (id, "stopped") : nil)
    }
    return (point, nil)
  }

  private func restsAtScreenEdge(_ point: NSPoint, _ id: String, live: Bool) -> Bool {
    guard let watch = watched[id], let window = WindowManager.shared.window(id), let display = window.screen else { return false }
    let screen = display.frame
    return screen.contains(point) && abs(point.x - Self.screenEdgeX(screen, watch.right)) < 1 && Self.inRows(point, window.frame)
      && Self.sidebarSideAtScreenEdge(window, display, right: watch.right)
      && (!live || Self.isWindowOrChild(Self.windowNumber(at: Self.insideEdge(window.frame, watch.right, y: point.y)), of: window))
  }

  private static func sidebarSideAtScreenEdge(_ window: NSWindow, _ screen: NSScreen, right: Bool) -> Bool {
    let inside = right ? window.frame.maxX <= screen.frame.maxX : window.frame.minX >= screen.frame.minX
    return inside && besideScreenEdge(window, screen, right: right)
  }

  private static func crossesScreenEdge(_ from: NSPoint, _ to: NSPoint, _ screen: NSRect, _ right: Bool) -> Bool {
    screen.contains(from) && (right ? to.x >= screen.maxX : to.x < screen.minX)
  }

  private static func screenEdgeX(_ screen: NSRect, _ right: Bool) -> CGFloat {
    right ? screen.maxX - 1 : screen.minX
  }

  private static func inRows(_ point: NSPoint, _ frame: NSRect) -> Bool {
    point.y >= frame.minY && point.y < frame.maxY
  }

  private static func inColumn(_ point: NSPoint, _ frame: NSRect, _ watch: Watch) -> Bool {
    let width = max(watch.hold, InterfaceScale.windowLength(fromRoot: SidebarEdgeRegions.innerRevealWidth))
    return watch.right ? point.x >= frame.maxX - width : point.x < frame.minX + width
  }

  private static func insideEdge(_ frame: NSRect, _ right: Bool, y: CGFloat) -> NSPoint {
    NSPoint(x: right ? frame.maxX - 1 : frame.minX + 1, y: y)
  }

  private static func isWindowOrChild(_ number: Int, of window: NSWindow) -> Bool {
    let hit = NSApp.window(withWindowNumber: number)
    return hit === window || hit?.parent === window
  }

  private func evaluate(
    point: NSPoint,
    of window: NSWindow,
    watch: Watch,
    id: String,
    live: Bool,
    pressed: Bool,
    onDock: Bool,
    tracker: inout SidebarEdgeTracker,
    time: TimeInterval,
    initial: Bool
  ) -> SidebarEdgeTracker.Decision {
    if pressed && pressedInside.contains(id) {
      tracker.holdActive()
      return SidebarEdgeTracker.Decision(over: true, nextDeadline: nil)
    }
    guard window.isVisible, !window.isMiniaturized, let screen = window.screen else {
      return tracker.step(point: point, at: time, inInnerBand: false, inOuterBand: false, inWindow: false, peeking: false, immediate: false, initial: false)
    }
    let frame = window.frame
    let tabDragBand = InterfaceScale.windowLength(fromRoot: SidebarEdgeRegions.tabDragBandWidth)
    let peeking = watch.hold > tabDragBand
    let immediate = watch.whilePressed || stoppedAtScreenEdge == id
    let g = SidebarEdgeTracker.Geometry(
      frame: frame,
      screen: screen.frame,
      right: watch.right,
      hold: watch.hold,
      innerReveal: InterfaceScale.windowLength(fromRoot: SidebarEdgeRegions.innerRevealWidth),
      innerExpanded: InterfaceScale.windowLength(fromRoot: SidebarEdgeRegions.innerExpandedWidth),
      outerApproach: InterfaceScale.windowLength(fromRoot: SidebarEdgeRegions.outerApproachReach),
      outerPersist: InterfaceScale.windowLength(fromRoot: SidebarEdgeRegions.outerPersistReach),
      inactiveReach: InterfaceScale.windowLength(fromRoot: SidebarEdgeRegions.inactiveEdgeReach),
      verticalSlack: InterfaceScale.windowLength(fromRoot: SidebarEdgeRegions.verticalHoldSlack),
      appActive: !live || NSApp.isActive,
      peeking: peeking,
      immediate: immediate
    )
    let regions = tracker.regions(for: point, geometry: g)
    let inWindowHit = regions.inWindow && (!live || Self.isWindowOrChild(Self.windowNumber(at: point), of: window))
    var inInnerHit = false
    var inOuterHit = false
    if watch.whilePressed || !pressed {
      let insideY = min(max(point.y, frame.minY), frame.maxY - 1)
      if regions.inInnerBand {
        if !live {
          inInnerHit = true
        } else if Self.isWindowOrChild(Self.windowNumber(at: NSPoint(x: point.x, y: insideY)), of: window),
          insideY == point.y || !Self.overAnotherOfOurs(point, besides: window)
        {
          inInnerHit = true
        }
      }
      if regions.inOuterBand {
        if !live || ((NSApp.isActive || Self.besideScreenEdge(window, screen, right: watch.right))
          && Self.isWindowOrChild(Self.windowNumber(at: Self.insideEdge(frame, watch.right, y: insideY)), of: window)
          && !Self.overAnotherOfOurs(point, besides: window))
        {
          inOuterHit = true
        }
      }
      let inColumn = Self.inColumn(point, frame, watch) && screen.frame.contains(point)
      if inColumn && onDock {
        let topBeneathDock = (regions.inInnerBand || regions.inOuterBand) && isTopBeneathDock(point, of: window, right: watch.right)
        if over.contains(id) || topBeneathDock {
          if watch.right ? point.x >= frame.maxX : point.x < frame.minX {
            inOuterHit = true
          } else {
            inInnerHit = true
          }
        }
      }
      if stoppedAtScreenEdge == id {
        if watch.right ? point.x >= frame.maxX : point.x < frame.minX {
          inOuterHit = true
        } else {
          inInnerHit = true
        }
      }
    }
    return tracker.step(
      point: point,
      at: time,
      inInnerBand: inInnerHit,
      inOuterBand: inOuterHit,
      inWindow: inWindowHit,
      peeking: peeking,
      immediate: immediate,
      initial: initial
    )
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
    let limit = InterfaceScale.windowLength(fromRoot: reach)
    return (right ? screen.frame.maxX - window.frame.maxX : window.frame.minX - screen.frame.minX) <= limit
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
    trackers = [:]
    dwellWorkItem?.cancel()
    dwellWorkItem = nil
    stoppedAtScreenEdge = nil
    crossing.forget()
    overSince = [:]
    pointerOverride = nil
    backgroundPoint = nil
    stop()
  }

  private func stop() {
    lastPoint = nil
    dwellWorkItem?.cancel()
    dwellWorkItem = nil
    for monitor in [localMonitor, globalMonitor].compactMap({ $0 }) { NSEvent.removeMonitor(monitor) }
    localMonitor = nil
    globalMonitor = nil
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers = []
  }
}
