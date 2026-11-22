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
      guard let self else { return completionHandler([], nil) }
      let now = written ?? self.loaded[id]?.grants ?? .none
      let current = permissions.intersection(webExtension.requestedPermissions.union(webExtension.optionalPermissions.filter { now.apis.contains($0.rawValue) }))
      if let written { self.adoptGrants(written, for: id) }
      completionHandler(current, nil)
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
      guard let self else { return completionHandler([], nil) }
      let now = written ?? self.loaded[id]?.grants ?? .none
      let everything = self.allSites.contains(id)
      let current = matchPatterns.filter { now.hosts.contains($0.string) || (everything && webExtension.requestedPermissionMatchPatterns.contains($0)) }
      if let written { self.adoptGrants(written, for: id) }
      completionHandler(current, nil)
    }
  }

  private func hasGesture(_ tab: (any WKWebExtensionTab)?, _ context: WKWebExtensionContext) -> Bool {
    if let tab, context.hasActiveUserGesture(in: tab) { return true }
    return bridge.hasPageGesture(context.uniqueIdentifier)
  }

  private func adoptGrants(_ grants: WebKitExtensionGrants, for id: String) {
    guard var entry = loaded[id] else { return }
    let added = grants.apis.subtracting(entry.grants.apis)
    entry.grants = grants
    loaded[id] = entry
    guard !added.isEmpty else { return }
    let base = ArdiaHost.baseProfile(of: profile)
    DispatchQueue.main.async { ArdiaEvents.emit("webKit.extensionsWanted", data: ArdiaConsentStamp.begin().onto(["profile": base])) }
  }
}
