import AppKit
import WebKit

@available(macOS 15.4, *)
extension WebKitExtensionHub {
  func actionStates(_ ids: [String], tab: WebKitTab) -> [String: Any] {
    let colours = chromiumBadgeColours(ids)
    var states: [String: Any] = [:]
    for id in ids {
      guard let action = loaded[id]?.context.action(for: tab) else { continue }
      let colour = colours[id] as? [String: Any]
      states[id] = [
        "title": action.label,
        "badgeText": action.badgeText,
        "badgeColor": colour?["badgeColor"] ?? NSNull(),
        "badgeTextColor": colour?["badgeTextColor"] ?? NSNull(),
        "popup": "",
        "enabled": action.isEnabled,
        "icon": action.icon(for: CGSize(width: 16, height: 16))?.pngDataURL(points: 16, scale: 2) ?? "",
      ]
    }
    return states
  }

  private func chromiumBadgeColours(_ ids: [String]) -> [String: Any] {
    guard !isPrivate, !ids.isEmpty else { return [:] }
    for key in Self.tabLayout.chromiumTabs[profile] ?? [] {
      let states = ArdiaHost.actionStates(tabId: key, extensions: ids)
      if !states.isEmpty { return states }
    }
    return [:]
  }

  func performAction(_ id: String, tab: WebKitTab) -> String? {
    guard let entry = loaded[id] else { return nil }
    ArdiaEvents.emit("webKit.counted", data: ArdiaConsentStamp.begin().onto(["name": "extensionAction"]))
    if entry.sidePanel.opensOnAction, entry.sidePanel.page(tab: tab.transferKey) != nil { return "sidePanel" }
    entry.context.userGesturePerformed(in: tab)
    entry.context.performAction(for: tab)
    return "none"
  }

  func sidePanelURL(_ id: String, tab: WebKitTab) -> String? {
    guard let entry = loaded[id], let page = entry.sidePanel.page(tab: tab.transferKey) else { return nil }
    return entry.context.baseURL.absoluteString + page
  }

  func pageConfiguration(for url: URL) -> WKWebViewConfiguration? {
    guard url.scheme == "webkit-extension", let host = url.host, let entry = loaded[host] else { return nil }
    return entry.context.webViewConfiguration
  }

  private func panelChanged(_ id: String) {
    ArdiaEvents.emit("extensions.action", data: ArdiaConsentStamp.begin().onto(["profile": ArdiaHost.baseProfile(of: profile), "id": id, "kind": "sidePanel"]))
  }

  func sidePanelCall(_ method: String, args: [Any], tabs: [WebKitTab?], extensionId: String) -> [String: Any] {
    guard var entry = loaded[extensionId] else { return ["error": "The extension isn't loaded."] }
    let options = args.first as? [String: Any] ?? [:]
    let asksTab = options["tabId"] != nil
    let tab = ((options["tabId"] as? [String: Any])?["__tab"] as? Int).flatMap { tabs.indices.contains($0) ? tabs[$0] : nil }
    if asksTab, tab == nil { return ["error": "No tab with the given id."] }
    let windows = orderedWindows()
    let windowTab = ((options["windowId"] as? [String: Any])?["__window"] as? Int).flatMap { at -> WebKitTab? in
      guard windows.indices.contains(at) else { return nil }
      return windows[at].tabs.first { $0.visible } ?? windows[at].tabs.first
    }
    switch method {
    case "getOptions":
      let shown = entry.sidePanel.options(tab: tab?.transferKey)
      var result: [String: Any] = ["enabled": shown.enabled ?? true]
      if let path = shown.path { result["path"] = path }
      return ["result": result]
    case "setOptions":
      entry.sidePanel.set(options, tab: tab?.transferKey)
      loaded[extensionId] = entry
      panelChanged(extensionId)
      return ["result": NSNull()]
    case "setPanelBehavior":
      if let opens = options["openPanelOnActionClick"] as? Bool { entry.sidePanel.opensOnAction = opens }
      loaded[extensionId] = entry
      return ["result": NSNull()]
    case "getPanelBehavior":
      return ["result": ["openPanelOnActionClick": entry.sidePanel.opensOnAction]]
    case "getLayout":
      return ["result": ["side": "right"]]
    case "open", "close":
      guard let target = tab ?? windowTab ?? shownTab(), let key = target.transferKey else { return ["error": "No window to show the side panel in."] }
      if method == "open", entry.sidePanel.page(tab: key) == nil { return ["error": "No active side panel for this tab."] }
      ArdiaEvents.emit("extensions.sidePanel", data: ArdiaConsentStamp.begin().onto(["tabId": key, "extensionId": extensionId, "open": method == "open"]))
      return ["result": NSNull()]
    default:
      return ["error": "sidePanel.\(method) isn't supported."]
    }
  }

  func webExtensionController(_ controller: WKWebExtensionController, openOptionsPageFor extensionContext: WKWebExtensionContext,
                              completionHandler: @escaping ((any Error)?) -> Void) {
    if let url = extensionContext.optionsPageURL, let source = shownTab() {
      source.emit("openWindow", ["url": url.absoluteString, "disposition": "foreground", "userGesture": true])
    }
    completionHandler(nil)
  }

  func webExtensionController(_ controller: WKWebExtensionController, didUpdate action: WKWebExtension.Action,
                              forExtensionContext context: WKWebExtensionContext) {
    ArdiaEvents.emit("extensions.action", data: ArdiaConsentStamp.begin().onto(["profile": ArdiaHost.baseProfile(of: profile), "id": context.uniqueIdentifier, "kind": "action"]))
  }

  func webExtensionController(_ controller: WKWebExtensionController, presentActionPopup action: WKWebExtension.Action,
                              for context: WKWebExtensionContext, completionHandler: @escaping ((any Error)?) -> Void) {
    let tab = (action.associatedTab as? WebKitTab) ?? shownTab()
    let page = action.popupWebView?.url ?? (context.webExtension.manifest["action"] as? [String: Any])?["default_popup"].flatMap { path in
      (path as? String).flatMap { URL(string: $0, relativeTo: context.baseURL)?.absoluteURL }
    }
    action.closePopup()
    guard let key = tab?.transferKey, let page else { return completionHandler(nil) }
    ArdiaEvents.emit("webKit.counted", data: ArdiaConsentStamp.begin().onto(["name": "extensionPopup"]))
    ArdiaEvents.emit("extensions.actionPopup", data: ArdiaConsentStamp.begin().onto(["tabId": key, "extensionId": context.uniqueIdentifier, "url": page.absoluteString, "engine": "webkit"]))
    completionHandler(nil)
  }
}
