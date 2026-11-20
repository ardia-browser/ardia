import Foundation

extension VaultOriginMatch {
  static func matches(_ item: VaultItem, origin: String) -> Bool {
    tier(item.urls, modes: item.urlMatch, origin: origin) >= .subdomain
  }
}

extension VaultBroker {
  func warm(origin: String) {
    guard VaultOriginMatch.isSecure(origin) else { return }
    for provider in VaultRegistry.providers { warm(provider, origin: origin) }
  }

  func hasSecrets(_ id: String, _ item: VaultItem) -> Bool {
    cachedPasswords[id]?[item.id]?.itemUpdatedAt == item.updatedAt
  }

  func warm(_ provider: any VaultProvider, origin: String) {
    let id = provider.id
    guard sessions.session(id) != nil, warming[id] == nil, provider.readsOffline || !VaultNetwork.isOffline, staysQuiet(provider) else { return }
    let site = "\(id)\n\(origin)"
    if let at = warmedSites[site], Date().timeIntervalSince(at) < Self.warmInterval { return }
    guard let indexed = siteIndex(id, warming: origin) else { return }
    let near = indexed.index.entries(near: origin).map { indexed.items[$0] }
    let wanted = Array(near.filter { VaultOriginMatch.matches($0, origin: origin) && !hasSecrets(id, $0) }.prefix(Self.warmLimit))
    guard !wanted.isEmpty, let cli = VaultCLI.make(for: provider, sessions: sessions) else { return }
    if warmedSites.count >= Self.warmedSitesLimit { warmedSites.removeAll() }
    warmedSites[site] = Date()
    let queue = lane(id)
    warming[id] = Task {
      for item in wanted {
        guard !Task.isCancelled else { break }
        guard let revealed = try? await queue.runBehindOthers({ try await provider.revealed(cli, id: item.id) }) else { continue }
        self.keepRevealed(id, item: item, revealed, ticket: cli.ticket)
      }
      self.finishWarming(id, site: site)
    }
  }

  func siteIndex(_ id: String, warming origin: String) -> (items: [VaultItem], index: VaultSiteIndex)? {
    guard let items = cachedItems[id] else { return nil }
    if let known = siteIndexes[id], known.items == items { return known }
    guard !indexing.contains(id) else { return nil }
    indexing.insert(id)
    Task.detached(priority: .utility) {
      let index = VaultSiteIndex(items.map(\.urls))
      await self.adoptIndex(id, items: items, index: index, warming: origin)
    }
    return nil
  }

  func adoptIndex(_ id: String, items: [VaultItem], index: VaultSiteIndex, warming origin: String) {
    indexing.remove(id)
    guard cachedItems[id] == items else { return }
    siteIndexes[id] = (items, index)
    warm(origin: origin)
  }

  func keepRevealed(_ id: String, item: VaultItem, _ revealed: VaultRevealed, ticket: VaultLockEpoch.Ticket) {
    guard !Task.isCancelled, isCurrent(ticket), sessions.session(id) != nil, cachedItems[id]?.first(where: { $0.id == item.id })?.updatedAt == item.updatedAt else { return }
    if let password = revealed.password {
      cachedPasswords[id, default: [:]][item.id] = VaultCacheSnapshot.Password(value: password, itemUpdatedAt: item.updatedAt)
    }
    if let totp = revealed.totp {
      cachedTotps[id, default: [:]][item.id] = VaultCacheSnapshot.Password(value: totp, itemUpdatedAt: item.updatedAt)
    }
    if revealed.password != nil || revealed.totp != nil { persist(id) }
  }

  func finishWarming(_ id: String, site: String) {
    guard !Task.isCancelled else {
      warmedSites[site] = nil
      return
    }
    warming[id] = nil
  }

  func stopWarming(_ id: String) {
    warming.removeValue(forKey: id)?.cancel()
  }
}
