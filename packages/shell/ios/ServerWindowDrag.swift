import AppKit
import ArdiaCore
import Carbon.HIToolbox
import ExpoModulesCore

enum ServerWindowDrag {
  private static let regions = NSHashTable<NSView>.weakObjects()
  private static let opaqueRectSelector = NSSelectorFromString("_opaqueRectForWindowMoveWhenInTitlebar")
  private static let refreshSelector = NSSelectorFromString("_updateDragRegionForHiddenStateChange")
  private static let enabled = LaunchConfig.shared.switchOn("serverWindowDrag") || allOpen
  private static let allOpen = LaunchConfig.shared.experimentOn("serverWindowDragAllOpen")
  private static let everyMount = LaunchConfig.shared.experimentOn("dragRegionEveryMount")

  private static let refreshEvery: CFTimeInterval = 0.1
  private static var targets: [ObjectIdentifier: (blocking: [ObjectIdentifier: Bool], open: [NSRect])] = [:]
  private static var refreshedAt: [ObjectIdentifier: CFTimeInterval] = [:]
  private static let staleAtMost: TimeInterval = 2
  private static var stale: [ObjectIdentifier: DispatchWorkItem] = [:]
  private(set) static var counts = (rebuilds: 0, deferred: 0, stalePresses: 0, scrollWaits: 0)
  private static let scrollQuiet: CFTimeInterval = 0.25
  private static var scrolledAt: CFTimeInterval = -.infinity
  private static var scrollMonitor: Any?
  #if DEBUG
  static var pointerOverride: NSPoint?
  #endif
  private static let watchers = NSMapTable<NSWindow, PointerWatcher>.weakToStrongObjects()

  private static let lastWindow = NSMapTable<NSView, NSWindow>.weakToWeakObjects()

  private static let scaleChanges: NSObjectProtocol = NotificationCenter.default.addObserver(
    forName: .ArdiaInterfaceScaleDidChange, object: nil, queue: .main
  ) { _ in
    for window in trackedWindows() {
      refresh(window)
      scheduleRefresh(window)
    }
  }

  static func track(_ region: NSView, bridge: AnyObject? = nil) {
    guard enabled, capable else { return }
    _ = scaleChanges
    if let bridge { observeMounting(bridge) }
    if let old = lastWindow.object(forKey: region), old !== region.window { refresh(old) }
    if let window = region.window {
      regions.add(region)
      lastWindow.setObject(window, forKey: region)
      watch(window)
      refresh(window)
    } else {
      regions.remove(region)
      lastWindow.removeObject(forKey: region)
    }
  }

  static func refresh(_ view: NSView) {
    if let window = view.window { refresh(window) }
  }

  static func refresh(_ window: NSWindow) {
    guard enabled, capable, let content = window.contentView else { return }
    let key = ObjectIdentifier(window)
    targets[key] = nil
    stale.removeValue(forKey: key)?.cancel()
    refreshedAt[key] = CACurrentMediaTime()
    counts.rebuilds += 1
    content.perform(refreshSelector)
  }

  private static func markStale(_ window: NSWindow) {
    guard stale[ObjectIdentifier(window)] == nil else { return }
    counts.deferred += 1
    armStale(window, after: staleAtMost)
  }

  private static func armStale(_ window: NSWindow, after delay: TimeInterval, waited: Bool = false) {
    let key = ObjectIdentifier(window)
    let work = DispatchWorkItem { [weak window] in
      guard let window, stale[key] != nil else { return }
      let wait = untilScrollQuiet(for: window)
      guard wait > 0 else { return refresh(window) }
      if !waited { counts.scrollWaits += 1 }
      armStale(window, after: wait, waited: true)
    }
    stale[key] = work
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
  }

  private static func untilScrollQuiet(for window: NSWindow) -> CFTimeInterval {
    let at = pointer()
    let under = NSWindow.windowNumber(at: at, belowWindowWithWindowNumber: 0) == window.windowNumber
    return under && inBand(window, at) ? 0 : scrollQuiet - (CACurrentMediaTime() - scrolledAt)
  }

  private static let pointerArrives: [Notification.Name] = [
    NSWindow.didMoveNotification, NSWindow.didResizeNotification, NSWindow.didChangeScreenNotification,
    NSWindow.didEnterFullScreenNotification, NSWindow.didExitFullScreenNotification, NSWindow.didDeminiaturizeNotification,
    NSWindow.didBecomeKeyNotification, NSWindow.didBecomeMainNotification, NSWindow.didChangeOcclusionStateNotification,
  ]

  private static func watch(_ window: NSWindow) {
    guard watchers.object(forKey: window) == nil, let frame = window.contentView?.superview else { return }
    watchers.setObject(PointerWatcher(frame), forKey: window)
    let key = ObjectIdentifier(window)
    let arrivals = pointerArrives.map { name in
      NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak window] _ in
        if let window, stale[key] != nil, inBand(window, pointer()) { refresh(window) }
      }
    }
    var closing: NSObjectProtocol?
    closing = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { _ in
      targets[key] = nil
      refreshedAt[key] = nil
      stale.removeValue(forKey: key)?.cancel()
      pending[key]?.cancel()
      pending[key] = nil
      arrivals.forEach(NotificationCenter.default.removeObserver)
      if let closing { NotificationCenter.default.removeObserver(closing) }
    }
  }

  private static func pointer() -> NSPoint {
    #if DEBUG
    if let pointerOverride { return pointerOverride }
    #endif
    return NSEvent.mouseLocation
  }

  private static func inBand(_ window: NSWindow, _ screenPoint: NSPoint) -> Bool {
    let frame = window.frame
    return screenPoint.x >= frame.minX && screenPoint.x <= frame.maxX && screenPoint.y >= frame.maxY - band(window) && screenPoint.y <= frame.maxY
  }

  private static func catchUpAll() {
    guard !stale.isEmpty else { return }
    let at = pointer()
    for window in trackedWindows() where stale[ObjectIdentifier(window)] != nil && inBand(window, at) { refresh(window) }
  }

  private static func trackedWindows() -> [NSWindow] {
    var seen = Set<ObjectIdentifier>()
    return regions.allObjects.compactMap { region in
      guard let window = region.window, seen.insert(ObjectIdentifier(window)).inserted else { return nil }
      return window
    }
  }

  static func pointerMoved(in window: NSWindow, at point: NSPoint) {
    guard point.y >= window.frame.height - band(window) else { return }
    scheduleRefresh(window)
    let key = ObjectIdentifier(window)
    if stale[key] == nil, let last = refreshedAt[key], CACurrentMediaTime() - last < refreshEvery { return }
    refresh(window)
  }

  private static var pending: [ObjectIdentifier: DispatchWorkItem] = [:]

  static func scheduleRefresh(_ window: NSWindow, after delay: CFTimeInterval = refreshEvery, waited: Bool = false) {
    let key = ObjectIdentifier(window)
    pending[key]?.cancel()
    let work = DispatchWorkItem { [weak window] in
      pending[key] = nil
      guard let window else { return }
      let wait = untilScrollQuiet(for: window)
      guard wait > 0 else { return refresh(window) }
      if !waited { counts.scrollWaits += 1 }
      scheduleRefresh(window, after: wait, waited: true)
    }
    pending[key] = work
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
  }

  static func mounted() {
    let at = pointer()
    for window in trackedWindows() {
      if everyMount || inBand(window, at) { scheduleRefresh(window) } else { markStale(window) }
    }
  }

  private static var mounting: MountWatcher?
  private static var eventMonitor: Any?

  private static func observeMounting(_ bridge: AnyObject) {
    guard mounting == nil,
          let manager = bridge.value(forKey: "uiManager") as AnyObject?,
          let coordinator = manager.value(forKey: "observerCoordinator") as AnyObject?
    else { return }
    let watcher = MountWatcher()
    let add = NSSelectorFromString("addObserver:")
    guard coordinator.responds(to: add) else { return }
    _ = coordinator.perform(add, with: watcher)
    mounting = watcher
    eventMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp, .rightMouseUp, .otherMouseUp, .keyUp, .flagsChanged]) { event in
      guard let window = event.window else { return event }
      if event.type != .leftMouseDown {
        scheduleRefresh(window)
      } else if event.locationInWindow.y >= window.frame.height - band(window) {
        let key = ObjectIdentifier(window)
        let isStale = stale[key] != nil
        guard isStale || pending[key] != nil else { return event }
        if isStale { counts.stalePresses += 1 }
        refresh(window)
      }
      return event
    }
    scrollMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { event in
      if let window = event.window, event.locationInWindow.y < window.frame.height - band(window) { scrolledAt = CACurrentMediaTime() }
      return event
    }
    NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in catchUpAll() }
  }

  static func band(_ window: NSWindow) -> CGFloat {
    max(0, window.frame.height - window.contentLayoutRect.height)
  }

  private static func openRects(_ window: NSWindow) -> [NSRect] {
    let height = window.frame.height
    let strip = NSRect(x: 0, y: height - band(window), width: window.frame.width, height: band(window))
    return regions.allObjects.filter { $0.window === window && !$0.isHiddenOrHasHiddenAncestor }
      .map { windowRect($0).intersection(strip) }
      .filter { !$0.isEmpty }
  }

  private static func topLayer(_ window: NSWindow?) -> CALayer? { window?.contentView?.superview?.layer }

  static func windowRect(_ view: NSView) -> NSRect {
    if let layer = view.layer, let top = topLayer(view.window) { return layer.convert(layer.bounds, to: top) }
    return view.convert(view.bounds, to: nil)
  }

  private static func transformed(_ view: NSView) -> Bool {
    guard let layer = view.layer else { return false }
    let boundsScale = CATransform3DMakeScale(
      view.bounds.width > 0 ? view.frame.width / view.bounds.width : 1, view.bounds.height > 0 ? view.frame.height / view.bounds.height : 1, 1)
    return !nearlyEqual(layer.transform, boundsScale)
  }

  private static func nearlyEqual(_ a: CATransform3D, _ b: CATransform3D) -> Bool {
    let lhs = [a.m11, a.m12, a.m13, a.m14, a.m21, a.m22, a.m23, a.m24, a.m31, a.m32, a.m33, a.m34, a.m41, a.m42, a.m43, a.m44]
    let rhs = [b.m11, b.m12, b.m13, b.m14, b.m21, b.m22, b.m23, b.m24, b.m31, b.m32, b.m33, b.m34, b.m41, b.m42, b.m43, b.m44]
    return zip(lhs, rhs).allSatisfy { abs($0 - $1) < 0.0001 }
  }

  private static func zOrdered(_ view: NSView) -> [NSView] {
    let sorted = NSSelectorFromString("reactZIndexSortedSubviews")
    if view.responds(to: sorted), let subviews = view.perform(sorted)?.takeUnretainedValue() as? [NSView] { return subviews }
    return view.subviews
  }

  private enum Layer { case region, beneath, above, inert }

  private static func classify(_ window: NSWindow) -> (blocking: [ObjectIdentifier: Bool], open: [NSRect]) {
    let key = ObjectIdentifier(window)
    if let cached = targets[key] { return cached }
    let open = openRects(window)
    var blocking: [ObjectIdentifier: Bool] = [:]
    let rn: AnyClass? = NSClassFromString("RCTView")
    func pointerEvents(_ view: NSView) -> Int {
      guard let rn, view.isKind(of: rn) else { return 0 }
      return (view.value(forKey: "pointerEvents") as? NSNumber)?.intValue ?? 0
    }
    var moving = false
    func visit(_ view: NSView, _ layer: Layer) {
      let frame = windowRect(view)
      guard !moving, !view.isHidden, open.contains(where: { $0.intersects(frame) }) else { return }
      if transformed(view) {
        moving = true
        return
      }
      var children = layer
      switch leadsToRegion(view) ? .region : layer {
      case .region:
        blocking[ObjectIdentifier(view)] = false
        var passed = false
        for child in zOrdered(view) {
          if leadsToRegion(child) {
            passed = true
            visit(child, .region)
          } else {
            visit(child, passed ? .above : .beneath)
          }
        }
        return
      case .beneath, .inert:
        blocking[ObjectIdentifier(view)] = false
      case .above:
        if pointerEvents(view) == 1 {
          blocking[ObjectIdentifier(view)] = false
          children = .inert
        } else if takesPresses(view, in: frame, open) {
          blocking[ObjectIdentifier(view)] = view.alphaValue > 0
          return
        } else {
          blocking[ObjectIdentifier(view)] = false
        }
      }
      for child in zOrdered(view) { visit(child, children) }
    }
    if let root = embeddedRoot(window), leadsToRegion(root) { visit(root, .region) }
    if moving {
      targets[key] = ([:], [])
      return ([:], [])
    }
    targets[key] = (blocking, open)
    return (blocking, open)
  }

  private static func takesPresses(_ view: NSView, in frame: NSRect, _ open: [NSRect]) -> Bool {
    guard let parent = view.superview else { return true }
    for rect in open {
      let area = rect.intersection(frame)
      if area.isEmpty { continue }
      for i in 0..<5 {
        for j in 0..<3 {
          let point = NSPoint(x: area.minX + area.width * (CGFloat(i) + 0.5) / 5, y: area.minY + area.height * (CGFloat(j) + 0.5) / 3)
          let local = parent.layer.flatMap { layer in topLayer(view.window).map { layer.convert(point, from: $0) } } ?? parent.convert(point, from: nil)
          if view.hitTest(local) === view { return true }
        }
      }
    }
    return false
  }

  static func blocks(_ view: NSView) -> Bool {
    guard let window = view.window else { return true }
    return classify(window).blocking[ObjectIdentifier(view)] ?? true
  }

  static func leadsToRegion(_ view: NSView) -> Bool {
    regions.allObjects.contains { $0 === view || $0.isDescendant(of: view) }
  }

  static func embeddedRoot(_ window: NSWindow?) -> NSView? {
    window.flatMap { ArdiaChromeWindowHost.embeddedRoot(of: $0) }
  }

  static func hostsRoot(_ view: NSView) -> Bool {
    embeddedRoot(view.window) != nil && view === view.window?.contentView
  }

  static func inRoot(_ view: NSView) -> Bool {
    guard let root = embeddedRoot(view.window) else { return false }
    return view === root || view.isDescendant(of: root)
  }

  private typealias BlockingRegion = @convention(c) (AnyObject, Selector, NSRect) -> OpaquePointer?
  private typealias EnumerateRegion = @convention(c) (OpaquePointer) -> OpaquePointer?
  private typealias NextRect = @convention(c) (OpaquePointer) -> UnsafePointer<CGRect>?
  private typealias ReleaseRegion = @convention(c) (OpaquePointer) -> Int32
  private static let blockingRegionSelector = NSSelectorFromString("_regionForOpaqueViewsBlockingDraggableFrame:")

  private static let skyLight: (enumerate: EnumerateRegion, next: NextRect, release: ReleaseRegion)? = {
    guard let sky = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW),
          let enumerate = dlsym(sky, "CGSRegionEnumerator"), let next = dlsym(sky, "CGSNextRect"),
          let release = dlsym(sky, "CGSReleaseRegionEnumerator")
    else { return nil }
    return (unsafeBitCast(enumerate, to: EnumerateRegion.self), unsafeBitCast(next, to: NextRect.self), unsafeBitCast(release, to: ReleaseRegion.self))
  }()

  private static func blockingRects(_ window: NSWindow, in rect: NSRect) -> [NSRect]? {
    guard let sky = skyLight, let method = class_getInstanceMethod(type(of: window), blockingRegionSelector),
          method_getNumberOfArguments(method) == 3, let types = method_getTypeEncoding(method), String(cString: types).hasPrefix("^")
    else { return nil }
    guard let region = unsafeBitCast(method_getImplementation(method), to: BlockingRegion.self)(window, blockingRegionSelector, rect),
          let rects = sky.enumerate(region)
    else { return nil }
    defer { _ = sky.release(rects) }
    var out: [NSRect] = []
    while let r = sky.next(rects) { out.append(r.pointee) }
    return out
  }

  static func serverOwnsPress(_ window: NSWindow, at point: NSPoint) -> Bool {
    guard let frame = window.contentView?.superview else { return false }
    let titlebar = NSRect(x: 0, y: frame.bounds.height - band(window), width: frame.bounds.width, height: band(window))
    guard titlebar.contains(point), let blocking = blockingRects(window, in: frame.bounds) else { return false }
    return !blocking.contains { $0.contains(point) }
  }

  #if DEBUG
  static func isStale(_ window: NSWindow) -> Bool { stale[ObjectIdentifier(window)] != nil }

  static func blockedRects(_ window: NSWindow, rebuilt: Bool = true) -> [[Double]] {
    if rebuilt { targets[ObjectIdentifier(window)] = nil }
    guard let frame = window.contentView?.superview, let rects = blockingRects(window, in: frame.bounds) else { return [] }
    return rects.map { [$0.minX, frame.bounds.height - $0.maxY, $0.width, $0.height] }
  }
  #endif

  private typealias OpaqueRect = @convention(c) (AnyObject, Selector) -> NSRect

  private typealias CanMove = @convention(c) (AnyObject, Selector) -> Bool
  private static let canMoveSelector = #selector(getter: NSView.mouseDownCanMoveWindow)

  private static func matches(_ cls: AnyClass, _ selector: Selector, _ encoding: (String) -> Bool) -> Bool {
    guard let method = class_getInstanceMethod(cls, selector), let types = method_getTypeEncoding(method) else { return false }
    return encoding(String(cString: types))
  }

  private static let capable: Bool = {
    let noArguments = { (types: String) in types.hasSuffix("@0:8") }
    let host: AnyClass = ArdiaChromeWindowHost.contentViewClass
    guard NSClassFromString("RCTView") != nil,
          matches(NSView.self, opaqueRectSelector, { $0.hasPrefix("{CGRect=") && noArguments($0) }),
          matches(host, opaqueRectSelector, { $0.hasPrefix("{CGRect=") && noArguments($0) }),
          matches(NSView.self, refreshSelector, { $0.hasPrefix("v") && noArguments($0) }),
          matches(NSView.self, canMoveSelector, { ($0.hasPrefix("B") || $0.hasPrefix("c")) && noArguments($0) })
    else { return false }
    install(host)
    return true
  }()

  private static func install(_ host: AnyClass) {
    replaceRect(host) { view, original in hostsRoot(view) ? .zero : original() }
    replaceCanMove(host) { view, original in hostsRoot(view) ? true : original() }
    replaceRect(NSView.self) { view, original in
      guard inRoot(view) else { return original() }
      return !allOpen && blocks(view) ? view.bounds : .zero
    }
    for name in ["NSView", "RCTUIView", "RCTView"] {
      guard let cls = NSClassFromString(name) else { continue }
      replaceCanMove(cls) { view, original in
        if inRoot(view) { return allOpen || !blocks(view) ? true : original() }
        return hostsRoot(view) ? true : original()
      }
    }
  }

  private static func replaceRect(_ cls: AnyClass, _ body: @escaping (NSView, () -> NSRect) -> NSRect) {
    guard let method = class_getInstanceMethod(cls, opaqueRectSelector) else { return }
    let original = unsafeBitCast(method_getImplementation(method), to: OpaqueRect.self)
    let block: @convention(block) (NSView) -> NSRect = { view in body(view) { original(view, opaqueRectSelector) } }
    let imp = imp_implementationWithBlock(block)
    if !class_addMethod(cls, opaqueRectSelector, imp, method_getTypeEncoding(method)) { method_setImplementation(method, imp) }
  }

  private static func replaceCanMove(_ cls: AnyClass, _ body: @escaping (NSView, () -> Bool) -> Bool) {
    guard let method = class_getInstanceMethod(cls, canMoveSelector) else { return }
    let original = unsafeBitCast(method_getImplementation(method), to: CanMove.self)
    let block: @convention(block) (NSView) -> Bool = { view in body(view) { original(view, canMoveSelector) } }
    let imp = imp_implementationWithBlock(block)
    if !class_addMethod(cls, canMoveSelector, imp, method_getTypeEncoding(method)) { method_setImplementation(method, imp) }
  }
}
