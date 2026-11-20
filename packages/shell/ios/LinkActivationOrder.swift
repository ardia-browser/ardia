import AppKit

final class LinkActivationOrder: NSObject {
  private struct Placement {
    weak var window: NSWindow?
    let below: Int
  }

  private final class Hidden {
    weak var window: NSWindow?
    init(_ window: NSWindow) { self.window = window }
  }

  private enum Kept: String {
    case atActivation = "activation"
    case onArrival = "arrival"
    case onOpen = "open"
    case released = "released"
    case stageManager = "stageManager"
    case windowManager = "windowManager"
    case keyRestored = "keyRestored"
  }

  private static let pairing: TimeInterval = 3
  private static let arrivalPairing: TimeInterval = 1
  private static let hiddenLimit: TimeInterval = 0.5
  private static let holdLimit: TimeInterval = 0.8
  private var placements: [Placement] = []
  private var activatedAt: Date?
  private var littleLinkAt: Date?
  private var keptEarly = false
  private var holdPending = false
  private var holding = false
  private var holdGeneration = 0
  private var raisedGeneration = 0
  private var activation = 0
  private var holdMonitor: Any?
  private var hidden: [Hidden] = []
  private weak var opened: NSWindow?
  private var openedAt: Date?

  override init() {
    super.init()
    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(willBecomeActive(_:)), name: NSApplication.willBecomeActiveNotification, object: nil)
    center.addObserver(self, selector: #selector(didBecomeActive(_:)), name: NSApplication.didBecomeActiveNotification, object: nil)
    center.addObserver(self, selector: #selector(didResignActive(_:)), name: NSApplication.didResignActiveNotification, object: nil)
  }

  func linkArrived(_ urls: [URL]) {
    guard Self.opensInLittleArdia(urls) else { return release(raising: true) }
    if holding {
      release(raising: false)
      return Self.report(.atActivation)
    }
    guard NSApp.isActive else { return littleLinkAt = Date() }
    guard !keptEarly, let activatedAt, Date().timeIntervalSince(activatedAt) < Self.arrivalPairing else { return }
    keepEarly(.onArrival)
  }

  func reopened() {
    release(raising: true)
  }

  func openedFromLink(_ window: NSWindow) {
    guard !NSApp.isActive || activatedAt.map({ Date().timeIntervalSince($0) < Self.pairing }) == true else { return }
    littleLinkAt = nil
    opened = window
    openedAt = Date()
    if keptEarly, NSApp.isActive { window.orderFrontRegardless() }
    keepOthersWhereTheyWere()
  }

  @objc private func willBecomeActive(_ notification: Notification) {
    release(raising: false)
    activation += 1
    let onScreen = Self.onScreenWindows()
    placements = Self.placements(onScreen)
    activatedAt = nil
    keptEarly = false
    holdPending = !littleLinkExpected && activationMayCarryLink && !stageManagerOrdersWindows && !windowManagerActivated(onScreen)
    if littleLinkExpected || holdPending { hideBeforeRaise() }
  }

  @objc private func didBecomeActive(_ notification: Notification) {
    activatedAt = Date()
    if littleLinkExpected {
      littleLinkAt = nil
      keepEarly(.atActivation)
    } else if holdPending {
      hold()
    } else {
      showHidden()
    }
    holdPending = false
    keepOthersWhereTheyWere()
  }

  @objc private func didResignActive(_ notification: Notification) {
    release(raising: false)
  }

  private static let activatedWithoutWindowsFlag = 0x400

  private var activationMayCarryLink: Bool {
    MenuState.current.linksOpenInLittleArdia && !placements.isEmpty && Self.activatedWithoutWindows
  }

  private static var activatedWithoutWindows: Bool {
    guard let event = NSApp.currentEvent, event.type == .appKitDefined, event.subtype == .applicationActivated else { return false }
    return event.data2 & activatedWithoutWindowsFlag != 0
  }

  private var stageManagerOrdersWindows: Bool {
    guard Self.stageManagerOn else { return false }
    Self.report(.stageManager)
    return true
  }

  private static var stageManagerOn: Bool {
    let domain = "com.apple.WindowManager" as CFString
    CFPreferencesAppSynchronize(domain)
    return CFPreferencesGetAppBooleanValue("GloballyEnabled" as CFString, domain, nil)
  }

  private static let windowManagerBundles = ["com.apple.dock", "com.apple.WindowManager"]

  private func windowManagerActivated(_ onScreen: [[String: Any]]) -> Bool {
    guard Self.leftToWindowManager(onScreen) else { return false }
    Self.report(.windowManager)
    return true
  }

  private static func leftToWindowManager(_ onScreen: [[String: Any]]) -> Bool {
    let list = onScreen.compactMap { entry -> LinkActivationHold.Listed? in
      guard let number = (entry[kCGWindowNumber as String] as? NSNumber)?.intValue,
            let owner = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
            let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue,
            let bounds = (entry[kCGWindowBounds as String] as? NSDictionary).flatMap({ CGRect(dictionaryRepresentation: $0) })
      else { return nil }
      let windowServer = entry[kCGWindowOwnerName as String] as? String == "Window Server"
      return LinkActivationHold.Listed(number: number, owner: owner, layer: layer, bounds: bounds, windowServer: windowServer)
    }
    let managers = Set(windowManagerBundles.flatMap { NSRunningApplication.runningApplications(withBundleIdentifier: $0) }.map(\.processIdentifier))
    return LinkActivationHold.leftToWindowManager(
      pointer: CGEvent(source: nil)?.location, own: ProcessInfo.processInfo.processIdentifier, windowManagers: managers, frontToBack: list)
  }

  private var littleLinkExpected: Bool {
    littleLinkAt.map { Date().timeIntervalSince($0) < Self.arrivalPairing } == true
  }

  private func hold() {
    keptEarly = true
    pushBack()
    holding = true
    holdGeneration += 1
    let generation = holdGeneration
    holdMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown]) {
      [weak self] event in
      self?.release(raising: true, pickingKey: event.type == .keyDown)
      return event
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.holdLimit) { [weak self] in
      guard let self, self.holdGeneration == generation else { return }
      self.release(raising: true)
    }
  }

  private func release(raising: Bool, pickingKey: Bool = true) {
    guard holding else { return }
    holding = false
    if raising { raisedGeneration += 1 }
    if let holdMonitor { NSEvent.removeMonitor(holdMonitor) }
    holdMonitor = nil
    guard raising else { return }
    Self.raiseFrontWindow(placements.compactMap(\.window), pickingKey: pickingKey && NSApp.isActive)
    Self.report(.released)
  }

  private func keepEarly(_ kept: Kept) {
    keptEarly = true
    pushBack()
    if !placements.isEmpty { Self.report(kept) }
  }

  private func pushBack() {
    let placements = placements
    let generation = raisedGeneration
    let scheduledIn = activation
    Self.restore(placements, except: nil)
    DispatchQueue.main.async { [weak self] in
      guard let self, self.activation == scheduledIn else { return }
      if self.raisedGeneration == generation, NSApp.isActive { Self.restore(placements, except: nil) }
      self.showHidden()
    }
  }

  private func hideBeforeRaise() {
    showHidden()
    for placement in placements {
      guard let window = placement.window, window.isVisible, window.alphaValue == 1 else { continue }
      window.alphaValue = 0
      hidden.append(Hidden(window))
    }
    let scheduledIn = activation
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.hiddenLimit) { [weak self] in
      guard let self, self.activation == scheduledIn else { return }
      self.showHidden()
    }
  }

  private func showHidden() {
    let windows = hidden.compactMap(\.window)
    hidden = []
    for window in windows where window.alphaValue == 0 { window.alphaValue = 1 }
  }

  private func keepOthersWhereTheyWere() {
    guard let opened, let openedAt, let activatedAt, abs(openedAt.timeIntervalSince(activatedAt)) < Self.pairing else { return }
    self.openedAt = nil
    let placements = placements
    if !keptEarly, !placements.isEmpty { Self.report(.onOpen) }
    Self.restore(placements, except: opened)
    let scheduledIn = activation
    DispatchQueue.main.async { [weak self, weak opened] in
      guard self?.activation == scheduledIn else { return }
      Self.restore(placements, except: opened)
    }
  }

  private static func opensInLittleArdia(_ urls: [URL]) -> Bool {
    guard MenuState.current.linksOpenInLittleArdia, urls.count == 1, let scheme = urls[0].scheme?.lowercased() else { return false }
    return scheme == "http" || scheme == "https"
  }

  private static func report(_ kept: Kept) {
    ShellEvents.send(.app, ["type": "littleArdiaLinkKeptBehind", "when": kept.rawValue])
  }

  private static func restore(_ placements: [Placement], except opened: NSWindow?) {
    for placement in placements.reversed() {
      guard let window = placement.window, window !== opened, window.isVisible, !window.isMiniaturized else { continue }
      window.order(.below, relativeTo: placement.below)
    }
  }

  private static func raiseFrontWindow(_ placed: [NSWindow], pickingKey: Bool) {
    for window in [NSApp.mainWindow, NSApp.keyWindow].compactMap({ $0 }) where window.isVisible && !window.isMiniaturized {
      window.orderFront(nil)
    }
    let candidates = placed + NSApp.orderedWindows.filter { window in !placed.contains { $0 === window } }
    guard pickingKey else { return }
    let picked = HoldReleaseKey.pick(hasKey: NSApp.keyWindow != nil, frontToBack: candidates.map {
      HoldReleaseKey.Candidate(
        visible: $0.isVisible, miniaturized: $0.isMiniaturized, canBecomeKey: $0.canBecomeKey, normalLevel: $0.level == .normal,
        browser: WindowManager.shared.isSteadyBrowserWindow($0), onActiveSpace: $0.isOnActiveSpace)
    })
    guard let picked else { return }
    candidates[picked].makeKeyAndOrderFront(nil)
    report(.keyRestored)
  }

  private static func onScreenWindows() -> [[String: Any]] {
    CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  }

  private static func placements(_ list: [[String: Any]]) -> [Placement] {
    let pid = ProcessInfo.processInfo.processIdentifier
    var above: Int?
    var result: [Placement] = []
    for info in list where (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 {
      guard let number = (info[kCGWindowNumber as String] as? NSNumber)?.intValue else { continue }
      guard (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid else {
        above = number
        continue
      }
      if let above, let window = NSApp.window(withWindowNumber: number) { result.append(Placement(window: window, below: above)) }
    }
    return result
  }
}
