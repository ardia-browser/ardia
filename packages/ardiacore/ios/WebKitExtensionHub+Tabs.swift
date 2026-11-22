import AppKit
import WebKit

@available(macOS 15.4, *)
extension WebKitExtensionHub {
  func owns(_ tab: WebKitTab) -> Bool {
    guard tab.webView != nil, !tab.closed, tab.transferKey != nil else { return false }
    guard isPrivate else { return tab.profile == profile }
    return WebKitStores.isPrivate(tab.profile) && ArdiaHost.baseProfile(of: tab.profile) == ArdiaHost.baseProfile(of: profile)
  }

  func openTabs() -> [WebKitTab] { WebKitHub.shared.transfers.liveTabs.filter(owns) }

  var hasTabs: Bool { WebKitHub.shared.transfers.liveTabs.contains(where: owns) }

  func orderedWindows() -> [(window: NSWindow, tabs: [WebKitTab])] {
    let own = openTabs()
    var byKey: [String: WebKitTab] = [:]
    for tab in own { if let key = tab.transferKey { byKey[key] = tab } }
    var order: [(window: NSWindow, tabs: [WebKitTab])] = []
    var slots: [ObjectIdentifier: Int] = [:]
    var placed: Set<ObjectIdentifier> = []
    let add = { (tab: WebKitTab, host: NSWindow) in
      guard placed.insert(ObjectIdentifier(tab)).inserted else { return }
      let key = ObjectIdentifier(host)
      if let slot = slots[key] {
        order[slot].tabs.append(tab)
      } else {
        slots[key] = order.count
        order.append((host, [tab]))
      }
    }
    for entry in Self.tabLayout.windows {
      let tabs = entry.keys.compactMap { byKey[$0] }
      guard let host = tabs.lazy.compactMap(\.window).first else { continue }
      for tab in tabs { add(tab, tab.window ?? host) }
    }
    for tab in own {
      if let host = tab.window { add(tab, host) }
    }
    return order
  }

  func windowTabKeys() -> [[String]] { orderedWindows().map { $0.tabs.compactMap(\.transferKey) } }

  func resolve(_ description: [String: Any]?) -> WebKitTab? {
    guard let description else { return nil }
    let windows = orderedWindows()
    let url = description["url"] as? String ?? ""
    let shows = { (tab: WebKitTab) in url.isEmpty || tab.webView?.url?.absoluteString == url }
    if let w = description["window"] as? Int, let i = description["index"] as? Int, windows.indices.contains(w), windows[w].tabs.indices.contains(i),
      shows(windows[w].tabs[i])
    {
      return windows[w].tabs[i]
    }
    guard !url.isEmpty else { return nil }
    return windows.flatMap(\.tabs).first { $0.webView?.url?.absoluteString == url }
  }

  func host(of tab: WebKitTab) -> NSWindow? {
    if let window = tab.window { return window }
    return layoutWindow(of: tab)?.keys.lazy.compactMap { WebKitHub.shared.transfers.liveTab($0)?.window }.first
  }

  func extensionWindow(for host: NSWindow) -> WebKitExtensionWindow {
    let key = ObjectIdentifier(host)
    windows = windows.filter { $0.value.window != nil || announcedWindows.contains($0.key) }
    if let known = windows[key] { return known }
    let made = WebKitExtensionWindow(window: host, hub: self)
    windows[key] = made
    return made
  }

  func window(of tab: WebKitTab) -> WebKitExtensionWindow? { host(of: tab).map(extensionWindow(for:)) }

  func tabs(in window: NSWindow) -> [WebKitTab] { orderedWindows().first { $0.window === window }?.tabs ?? [] }

  func appWindowId(of window: NSWindow) -> String? { tabs(in: window).lazy.compactMap { self.layoutWindow(of: $0)?.id }.first }

  func lastShownTab(in window: NSWindow) -> WebKitTab? { activeTabs[ObjectIdentifier(window)]?.tab }

  func focusedHost() -> NSWindow? {
    let windows = orderedWindows()
    for id in Self.tabLayout.focusOrder {
      if let found = windows.first(where: { entry in entry.tabs.contains { self.layoutWindow(of: $0)?.id == id } }) { return found.window }
    }
    return windows.first { $0.window.isKeyWindow }?.window ?? windows.first?.window
  }

  func shownTab() -> WebKitTab? {
    guard let host = focusedHost() else { return openTabs().first }
    return activeTab(in: host)
  }

  func activeTab(in host: NSWindow) -> WebKitTab? {
    let tabs = tabs(in: host)
    let last = lastShownTab(in: host).flatMap { last in tabs.first { $0 === last } }
    if let last, last.visible { return last }
    return tabs.first(where: \.visible) ?? last ?? tabs.first
  }

  func tabOpened(_ tab: WebKitTab) {
    guard !loaded.isEmpty, tab.transferKey != nil else { return }
    if let window = window(of: tab) { announce(window) }
    openedTabs.insert(ObjectIdentifier(tab))
    if let replaced = takeLeaving(tab) { controller.didReplaceTab(replaced, with: tab) } else { controller.didOpenTab(tab) }
    if let placed = placement(of: tab) { placements[ObjectIdentifier(tab)] = placed }
    arrived(tab)
  }

  func tabClosed(_ tab: WebKitTab) {
    reportedTabs.removeValue(forKey: ObjectIdentifier(tab))
    if let key = tab.transferKey, !WebKitHub.shared.transfers.isPrepared(key) { for id in loaded.keys { loaded[id]?.sidePanel.forgetTab(key) } }
    guard !loaded.isEmpty else { return }
    noteLeaving(tab)
  }

  func tabShown(_ tab: WebKitTab) {
    guard !loaded.isEmpty, tab.visible, tab.webView != nil, tab.transferKey != nil else { return }
    if let host = host(of: tab) {
      let key = ObjectIdentifier(host)
      let previous = activeTabs[key]?.tab
      if previous !== tab {
        activeTabs = activeTabs.filter { $0.value.tab != nil }
        activeTabs[key] = ActiveTab(tab: tab)
        controller.didActivateTab(tab, previousActiveTab: previous.flatMap { owns($0) ? $0 : nil })
      }
    } else {
      controller.didActivateTab(tab, previousActiveTab: nil)
    }
    if let window = window(of: tab), window.window?.isKeyWindow == true { controller.didFocusWindow(window) }
    shown(tab)
  }

  func tabChanged(_ tab: WebKitTab) {
    guard !loaded.isEmpty, tab.transferKey != nil else { return }
    let now = ReportedTab(url: tab.webView?.url, title: tab.webView?.title, loading: tab.webView?.isLoading ?? false)
    let before = reportedTabs.updateValue(now, forKey: ObjectIdentifier(tab))
    var changed: WKWebExtension.TabChangedProperties = []
    if before?.url != now.url { changed.insert(.URL) }
    if before?.title != now.title { changed.insert(.title) }
    if before?.loading != now.loading { changed.insert(.loading) }
    guard !changed.isEmpty else { return }
    controller.didChangeTabProperties(changed, for: tab)
  }

  func focusChanged(from before: String?) {
    guard !loaded.isEmpty, let now = Self.tabLayout.focusOrder.first, now != before else { return }
    guard let host = focusedHost(), appWindowId(of: host) == now else { return }
    controller.didFocusWindow(extensionWindow(for: host))
  }

  func awaitHost(_ tab: WebKitTab, until deadline: Date, done: @escaping (WebKitExtensionWindow?) -> Void) {
    if let window = window(of: tab) { return done(window) }
    guard Date() < deadline, owns(tab) else { return done(nil) }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self, weak tab] in
      guard let self, let tab else { return done(nil) }
      self.awaitHost(tab, until: deadline, done: done)
    }
  }

  func offerPage(_ url: URL) -> String {
    let configuration = WebKitExtensions.shared.pageConfiguration(for: url.absoluteString, profile: profile) ?? WebKitHub.shared.configuration(profile: profile)
    let view = WebKitWebView(frame: .zero, configuration: configuration)
    view.navigationDelegate = WebKitPopupPolicy.shared
    let adoptId = WebKitHub.shared.transfers.offer(view)
    view.load(URLRequest(url: url))
    return adoptId
  }

  private func order(_ tabs: [WebKitTab]) -> [[String: Any]] {
    tabs.compactMap { tab in tab.transferKey.map { ["key": $0, "pinned": isPinned(tab)] } }
  }

  func close(_ tab: WebKitTab, completion: @escaping ((any Error)?) -> Void) {
    guard let key = tab.transferKey else { return completion(nil) }
    ArdiaEvents.emit("webKit.counted", data: ArdiaConsentStamp.begin().onto(["name": "extensionTabClose"]))
    ask("close", ["tabIds": [key]]) { completion(Self.failure($0)) }
  }

  func activate(_ tab: WebKitTab, completion: @escaping ((any Error)?) -> Void) {
    guard let key = tab.transferKey else { return completion(nil) }
    ArdiaEvents.emit("webKit.counted", data: ArdiaConsentStamp.begin().onto(["name": "extensionTabActivate"]))
    ask("activate", ["tabId": key]) { [weak self] reply in
      if let error = Self.failure(reply) { return completion(error) }
      guard let self else { return completion(nil) }
      self.awaitShown(tab) { completion(nil) }
    }
  }

  func setPinned(_ tab: WebKitTab, _ pinned: Bool, completion: @escaping ((any Error)?) -> Void) {
    guard let key = tab.transferKey, let host = host(of: tab), let windowId = appWindowId(of: host) else { return completion(nil) }
    guard isPinned(tab) != pinned else { return completion(nil) }
    ArdiaEvents.emit("webKit.counted", data: ArdiaConsentStamp.begin().onto(["name": "extensionTabPin"]))
    let before = order(tabs(in: host))
    var after = before.filter { $0["key"] as? String != key }
    let pinnedCount = after.prefix { $0["pinned"] as? Bool == true }.count
    after.insert(["key": key, "pinned": pinned], at: pinnedCount)
    ask("arrange", ["windowId": windowId, "before": before, "after": after]) { completion(Self.failure($0)) }
  }

  func setOpener(_ tab: WebKitTab, _ opener: WebKitTab?, completion: @escaping ((any Error)?) -> Void) {
    guard let key = tab.transferKey else { return completion(nil) }
    ask("opener", ["tabId": key, "openerId": opener?.transferKey ?? NSNull()]) { completion(Self.failure($0)) }
  }

  func duplicate(_ tab: WebKitTab, active: Bool, completion: @escaping ((any WKWebExtensionTab)?, (any Error)?) -> Void) {
    guard let key = tab.transferKey else { return completion(nil, nil) }
    ArdiaEvents.emit("webKit.counted", data: ArdiaConsentStamp.begin().onto(["name": "extensionTabDuplicate"]))
    ask("duplicate", ["tabId": key, "active": active]) { [weak self] reply in
      if let error = Self.failure(reply) { return completion(nil, error) }
      self?.awaitTab(reply["tabId"] as? String) { completion($0, nil) }
    }
  }

  func setZoom(_ tab: WebKitTab, _ factor: Double) {
    ArdiaEvents.emit("webKit.counted", data: ArdiaConsentStamp.begin().onto(["name": "extensionTabZoom"]))
    tab.setExtensionZoom(factor)
    guard !loaded.isEmpty else { return }
    controller.didChangeTabProperties(.zoomFactor, for: tab)
  }

  func webExtensionController(_ controller: WKWebExtensionController, openWindowsFor extensionContext: WKWebExtensionContext) -> [any WKWebExtensionWindow] {
    orderedWindows().map { extensionWindow(for: $0.window) }
  }

  func webExtensionController(_ controller: WKWebExtensionController, focusedWindowFor extensionContext: WKWebExtensionContext) -> (any WKWebExtensionWindow)? {
    focusedHost().map(extensionWindow(for:))
  }

  func webExtensionController(_ controller: WKWebExtensionController, openNewTabUsing configuration: WKWebExtension.TabConfiguration,
                              for extensionContext: WKWebExtensionContext, completionHandler: @escaping ((any WKWebExtensionTab)?, (any Error)?) -> Void) {
    if let url = configuration.url, !WebKitExtensionAccess.mayNavigate(to: url) {
      return completionHandler(nil, WebKitExtensionBridge.failure("Extensions can’t open this URL."))
    }
    ArdiaEvents.emit("webKit.counted", data: ArdiaConsentStamp.begin().onto(["name": "extensionTabCreate"]))
    let parent = configuration.parentTab as? WebKitTab
    let source = parent ?? shownTab()
    let host = (configuration.window as? WebKitExtensionWindow)?.window ?? source.flatMap(host(of:))
    var payload: [String: Any] = ["active": configuration.shouldBeActive, "pinned": configuration.shouldBePinned]
    if let url = configuration.url {
      payload["url"] = url.absoluteString
      payload["adoptId"] = offerPage(url)
    }
    if let host, let windowId = appWindowId(of: host) {
      payload["windowId"] = windowId
      let keys = tabs(in: host).compactMap(\.transferKey)
      if configuration.index < keys.count { payload["beforeId"] = keys[configuration.index] }
      if let last = keys.last { payload["afterId"] = last }
    }
    if let near = source?.transferKey { payload["nearTabId"] = near }
    if let opener = parent?.transferKey { payload["openerId"] = opener }
    let muted = configuration.shouldBeMuted
    ask("create", payload) { [weak self] reply in
      if let error = Self.failure(reply) { return completionHandler(nil, error) }
      guard configuration.url != nil || reply["webKit"] as? Bool == true else { return completionHandler(nil, Self.openedInChromium) }
      self?.awaitTab(reply["tabId"] as? String) { tab in
        if muted { tab?.setMuted(true) }
        completionHandler(tab, nil)
      }
    }
  }

  func webExtensionController(_ controller: WKWebExtensionController, openNewWindowUsing configuration: WKWebExtension.WindowConfiguration,
                              for extensionContext: WKWebExtensionContext, completionHandler: @escaping ((any WKWebExtensionWindow)?, (any Error)?) -> Void) {
    guard configuration.tabURLs.allSatisfy(WebKitExtensionAccess.mayNavigate(to:)) else {
      return completionHandler(nil, WebKitExtensionBridge.failure("Extensions can’t open this URL."))
    }
    ArdiaEvents.emit("webKit.counted", data: ArdiaConsentStamp.begin().onto(["name": "extensionWindowCreate"]))
    let movedTabs = configuration.tabs.compactMap { $0 as? WebKitTab }
    let moved = movedTabs.compactMap(\.transferKey)
    let urls = configuration.tabURLs
    var payload: [String: Any] = [
      "focused": configuration.shouldBeFocused, "tabIds": moved, "urls": urls.map(\.absoluteString), "adoptIds": urls.map(offerPage),
    ]
    if let near = shownTab()?.transferKey { payload["nearTabId"] = near }
    let frame = configuration.frame
    let state = configuration.windowState
    ask("createWindow", payload) { [weak self] reply in
      if let error = Self.failure(reply) { return completionHandler(nil, error) }
      guard let self else { return completionHandler(nil, nil) }
      guard !moved.isEmpty || !urls.isEmpty || reply["webKit"] as? Bool == true else { return completionHandler(nil, Self.openedInChromium) }
      self.awaitTab(reply["tabId"] as? String, replacing: movedTabs) { tab in
        guard let tab else { return completionHandler(nil, nil) }
        self.awaitHost(tab, until: Date().addingTimeInterval(Self.shownDeadline)) { window in
          guard let window else { return completionHandler(nil, nil) }
          self.announce(window)
          window.place(frame: frame, state: state)
          if let host = self.focusedHost() { self.controller.didFocusWindow(self.extensionWindow(for: host)) }
          completionHandler(window, nil)
        }
      }
    }
  }
}
