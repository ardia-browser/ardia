import AppKit
import WebKit

@available(macOS 15.4, *)
extension WebKitExtensionHub {
  struct TabLayout {
    struct Window {
      let id: String
      let keys: [String]
      let pinned: Set<String>
      let shown: String?
    }

    private(set) var windows: [Window] = []
    private(set) var openers: [String: String] = [:]
    private(set) var focusOrder: [String] = []
    private(set) var chromiumTabs: [String: [String]] = [:]
    private var windowOfKey: [String: Int] = [:]

    init() {}

    init(_ payload: [String: Any]) {
      for entry in payload["windows"] as? [[String: Any]] ?? [] {
        guard let id = entry["id"] as? String else { continue }
        let keys = entry["tabs"] as? [String] ?? []
        for key in keys { windowOfKey[key] = windows.count }
        windows.append(Window(id: id, keys: keys, pinned: Set(entry["pinned"] as? [String] ?? []), shown: entry["shown"] as? String))
      }
      openers = payload["openers"] as? [String: String] ?? [:]
      focusOrder = payload["focus"] as? [String] ?? []
      chromiumTabs = payload["chromiumTabs"] as? [String: [String]] ?? [:]
    }

    func window(of key: String) -> Window? { windowOfKey[key].map { windows[$0] } }

    func contains(window id: String) -> Bool { windows.contains { $0.id == id } }
  }

  struct Placement {
    let window: WebKitExtensionWindow?
    let index: Int
    let pinned: Bool
  }

  struct Leaving {
    let tab: WebKitTab
    let windowId: String?
    let moving: Bool
    let since: Date
  }

  struct Request {
    let done: ([String: Any]) -> Void
    let timeout: DispatchWorkItem
  }

  struct Arrival {
    let done: (WebKitTab?) -> Void
    let timeout: DispatchWorkItem
  }

  static let requestDeadline: TimeInterval = 10
  static let movingGrace: TimeInterval = 3
  static let shownDeadline: TimeInterval = 2

  @MainActor static func applyLayout(_ payload: [String: Any]) { tabLayout = TabLayout(payload) }

  func layoutWindow(of tab: WebKitTab) -> TabLayout.Window? { tab.transferKey.flatMap { Self.tabLayout.window(of: $0) } }

  func isPinned(_ tab: WebKitTab) -> Bool {
    guard let key = tab.transferKey else { return false }
    return Self.tabLayout.window(of: key)?.pinned.contains(key) ?? false
  }

  func opener(of tab: WebKitTab) -> WebKitTab? {
    guard let key = tab.transferKey, let opener = Self.tabLayout.openers[key], let found = WebKitHub.shared.transfers.liveTab(opener) else { return nil }
    return owns(found) ? found : nil
  }

  func layoutChanged() {
    guard !loaded.isEmpty else {
      placements = [:]
      return
    }
    var seen = Set<ObjectIdentifier>()
    for (host, tabs) in orderedWindows() {
      let window = extensionWindow(for: host)
      announce(window)
      let stayed = tabs.compactMap { tab -> (ObjectIdentifier, Int)? in
        guard let old = placements[ObjectIdentifier(tab)], old.window === window else { return nil }
        return (ObjectIdentifier(tab), old.index)
      }
      let kept = Self.keptInOrder(stayed)
      for (index, tab) in tabs.enumerated() {
        let id = ObjectIdentifier(tab)
        seen.insert(id)
        let pinned = isPinned(tab)
        let old = placements.updateValue(Placement(window: window, index: index, pinned: pinned), forKey: id)
        guard let old else { continue }
        if old.pinned != pinned { controller.didChangeTabProperties(.pinned, for: tab) }
        if old.window !== window || (!kept.contains(id) && old.index != index) { controller.didMoveTab(tab, from: old.index, in: old.window) }
      }
    }
    placements = placements.filter { seen.contains($0.key) }
    closeEmptyWindows()
  }

  static func keptInOrder(_ items: [(ObjectIdentifier, Int)]) -> Set<ObjectIdentifier> {
    guard !items.isEmpty else { return [] }
    var best = Array(repeating: 1, count: items.count)
    var back = Array(repeating: -1, count: items.count)
    var end = 0
    for i in items.indices {
      for j in 0..<i where items[j].1 < items[i].1 && best[j] + 1 > best[i] {
        best[i] = best[j] + 1
        back[i] = j
      }
      if best[i] > best[end] { end = i }
    }
    var kept = Set<ObjectIdentifier>()
    var at = end
    while at >= 0 {
      kept.insert(items[at].0)
      at = back[at]
    }
    return kept
  }

  func placement(of tab: WebKitTab) -> Placement? {
    guard let host = window(of: tab)?.window else { return nil }
    let tabs = tabs(in: host)
    guard let index = tabs.firstIndex(where: { $0 === tab }) else { return nil }
    return Placement(window: extensionWindow(for: host), index: index, pinned: isPinned(tab))
  }

  func announce(_ window: WebKitExtensionWindow) {
    guard let host = window.window, announcedWindows.insert(ObjectIdentifier(host)).inserted else { return }
    controller.didOpenWindow(window)
  }

  func closeEmptyWindows() {
    let live = Set(orderedWindows().map { ObjectIdentifier($0.window) })
    for key in announcedWindows where !live.contains(key) {
      announcedWindows.remove(key)
      if let window = windows.removeValue(forKey: key) { controller.didCloseWindow(window) }
    }
  }

  func noteLeaving(_ tab: WebKitTab) {
    placements.removeValue(forKey: ObjectIdentifier(tab))
    guard let key = tab.transferKey, openedTabs.remove(ObjectIdentifier(tab)) != nil else { return }
    let moving = WebKitHub.shared.transfers.isPrepared(key)
    leaving[key] = Leaving(tab: tab, windowId: layoutWindow(of: tab)?.id, moving: moving, since: Date())
    let wait = moving ? Self.movingGrace : 0.05
    DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in self?.flushLeaving() }
  }

  func flushLeaving() {
    let now = Date()
    for (key, gone) in leaving where !gone.moving || now.timeIntervalSince(gone.since) >= Self.movingGrace - 0.01 {
      leaving.removeValue(forKey: key)
      let windowClosing = gone.windowId.map { !Self.tabLayout.contains(window: $0) } ?? false
      controller.didCloseTab(gone.tab, windowIsClosing: windowClosing)
    }
    closeEmptyWindows()
  }

  func takeLeaving(_ tab: WebKitTab) -> WebKitTab? {
    guard let key = tab.transferKey, let gone = leaving.removeValue(forKey: key), gone.tab !== tab else { return nil }
    return gone.tab
  }

  func ask(_ op: String, _ payload: [String: Any], done: @escaping ([String: Any]) -> Void) {
    Self.nextRequest += 1
    let id = "wk-tabs-\(Self.nextRequest)"
    let timeout = DispatchWorkItem { [weak self] in
      MainActor.assumeIsolated {
        ArdiaEvents.emit("webKit.counted", data: ArdiaConsentStamp.begin().onto(["name": "extensionTabRequestFailed"]))
        self?.answered(id, ["error": "Ardia didn't answer in time."])
      }
    }
    requests[id] = Request(done: done, timeout: timeout)
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.requestDeadline, execute: timeout)
    var data = payload
    data["action"] = "webKit"
    data["op"] = op
    data["request"] = id
    data["profile"] = ArdiaHost.baseProfile(of: profile)
    data["private"] = isPrivate
    ArdiaEvents.emit("extensions.tabs", data: ArdiaConsentStamp.begin().onto(data))
  }

  @discardableResult
  func answered(_ id: String, _ reply: [String: Any]) -> Bool {
    guard let request = requests.removeValue(forKey: id) else { return false }
    request.timeout.cancel()
    request.done(reply)
    return true
  }

  func awaitTab(_ key: String?, replacing old: [WebKitTab] = [], done: @escaping (WebKitTab?) -> Void) {
    guard let key, !key.isEmpty else { return done(nil) }
    if let tab = WebKitHub.shared.transfers.liveTab(key), owns(tab), openedTabs.contains(ObjectIdentifier(tab)), !old.contains(where: { $0 === tab }) { return done(tab) }
    if let displaced = arrivals.removeValue(forKey: key) {
      displaced.timeout.cancel()
      displaced.done(nil)
    }
    let timeout = DispatchWorkItem { [weak self] in
      MainActor.assumeIsolated { self?.arrivals.removeValue(forKey: key)?.done(nil) }
    }
    arrivals[key] = Arrival(done: done, timeout: timeout)
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.requestDeadline, execute: timeout)
  }

  func arrived(_ tab: WebKitTab) {
    guard let key = tab.transferKey, let arrival = arrivals.removeValue(forKey: key) else { return }
    arrival.timeout.cancel()
    arrival.done(tab)
  }

  func awaitShown(_ tab: WebKitTab, done: @escaping () -> Void) {
    guard !isActive(tab) else { return done() }
    let key = "shown:\(ObjectIdentifier(tab).hashValue)"
    if let displaced = arrivals[key] {
      arrivals[key] = Arrival(done: { tab in
        displaced.done(tab)
        done()
      }, timeout: displaced.timeout)
      return
    }
    let timeout = DispatchWorkItem { [weak self] in
      MainActor.assumeIsolated { self?.arrivals.removeValue(forKey: key)?.done(nil) }
    }
    arrivals[key] = Arrival(done: { _ in done() }, timeout: timeout)
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.shownDeadline, execute: timeout)
  }

  func isActive(_ tab: WebKitTab) -> Bool { tab.visible && host(of: tab).map { activeTab(in: $0) === tab } == true }

  func shown(_ tab: WebKitTab) {
    guard isActive(tab), let arrival = arrivals.removeValue(forKey: "shown:\(ObjectIdentifier(tab).hashValue)") else { return }
    arrival.timeout.cancel()
    arrival.done(tab)
  }

  static let openedInChromium = WebKitExtensionBridge.failure("The new tab opened on the start page in Chromium, which the extension's WebKit copy can't see.")

  static func failure(_ reply: [String: Any]) -> NSError? {
    (reply["error"] as? String).map(WebKitExtensionBridge.failure)
  }
}
