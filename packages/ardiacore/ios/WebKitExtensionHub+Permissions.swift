import WebKit

@available(macOS 15.4, *)
extension WebKitExtensionHub {
  func webExtensionController(_ controller: WKWebExtensionController, promptForPermissions permissions: Set<WKWebExtension.Permission>,
                              in tab: (any WKWebExtensionTab)?, for extensionContext: WKWebExtensionContext,
                              completionHandler: @escaping (Set<WKWebExtension.Permission>, Date?) -> Void) {
    let id = extensionContext.uniqueIdentifier
    let granted = loaded[id]?.grants.apis ?? []
    let webExtension = extensionContext.webExtension
    let allowed = permissions.intersection(webExtension.requestedPermissions.union(webExtension.optionalPermissions.filter { granted.contains($0.rawValue) }))
    let asking = permissions.subtracting(allowed).intersection(webExtension.optionalPermissions)
    guard !asking.isEmpty, hasGesture(tab, extensionContext) else { return completionHandler(allowed, nil) }
    WebKitExtensionGrants.request(profile: profile, extensionId: id, apis: asking.map(\.rawValue), hosts: []) { [weak self] written in
      guard let written else { return completionHandler(allowed, nil) }
      self?.adoptGrants(written, for: id)
      completionHandler(allowed.union(asking.filter { written.apis.contains($0.rawValue) }), nil)
    }
  }

  func webExtensionController(_ controller: WKWebExtensionController, promptForPermissionToAccess urls: Set<URL>, in tab: (any WKWebExtensionTab)?,
                              for extensionContext: WKWebExtensionContext, completionHandler: @escaping (Set<URL>, Date?) -> Void) {
    let id = extensionContext.uniqueIdentifier
    let grants = loaded[id]?.grants ?? .none
    let requested = allSites.contains(id) ? extensionContext.webExtension.requestedPermissionMatchPatterns : []
    completionHandler(urls.filter { url in grants.allows(url) || requested.contains { $0.matches(url) } }, nil)
  }

  func webExtensionController(_ controller: WKWebExtensionController, promptForPermissionMatchPatterns matchPatterns: Set<WKWebExtension.MatchPattern>,
                              in tab: (any WKWebExtensionTab)?, for extensionContext: WKWebExtensionContext,
                              completionHandler: @escaping (Set<WKWebExtension.MatchPattern>, Date?) -> Void) {
    let id = extensionContext.uniqueIdentifier
    let granted = loaded[id]?.grants.hosts ?? []
    let webExtension = extensionContext.webExtension
    let everything = allSites.contains(id)
    let allowed = matchPatterns.filter { granted.contains($0.string) || (everything && webExtension.requestedPermissionMatchPatterns.contains($0)) }
    let asking: Set<WKWebExtension.MatchPattern> = matchPatterns.subtracting(allowed).filter { webExtension.optionalPermissionMatchPatterns.contains($0) || webExtension.requestedPermissionMatchPatterns.contains($0) }
    guard !asking.isEmpty, hasGesture(tab, extensionContext) else { return completionHandler(allowed, nil) }
    WebKitExtensionGrants.request(profile: profile, extensionId: id, apis: [], hosts: asking.map(\.string)) { [weak self] written in
      guard let written else { return completionHandler(allowed, nil) }
      self?.adoptGrants(written, for: id)
      completionHandler(allowed.union(asking.filter { written.hosts.contains($0.string) }), nil)
    }
  }

  private func hasGesture(_ tab: (any WKWebExtensionTab)?, _ context: WKWebExtensionContext) -> Bool {
    if let tab, context.hasActiveUserGesture(in: tab) { return true }
    return bridge.hasPageGesture(context.uniqueIdentifier)
  }

  private func adoptGrants(_ grants: WebKitExtensionGrants, for id: String) {
    guard var entry = loaded[id] else { return }
    entry.grants = grants
    loaded[id] = entry
  }
}
