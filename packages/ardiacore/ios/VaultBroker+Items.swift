import Foundation

extension VaultBroker {
  func items(of provider: any VaultProvider) async -> [VaultItem] {
    let id = provider.id
    guard isReady(id) || (sessions.session(id) == nil && gate.admits(id)) else { return [] }
    restoreFromDisk(id)
    if let cached = cachedItems[id] {
      let stale = Date().timeIntervalSince(fetchedAt[id] ?? .distantPast) >= Self.itemsLifetime
      if stale, sessions.session(id) != nil { refreshInBackground(provider) }
      return cached
    }
    guard sessions.session(id) != nil else { return [] }
    return await fetchItems(provider)
  }

  func refreshInBackground(_ provider: any VaultProvider) {
    guard loading[provider.id] == nil, provider.readsOffline || !VaultNetwork.isOffline, staysQuiet(provider) else { return }
    Task { _ = await self.fetchItems(provider, yieldsToFills: true) }
  }

  func staysQuiet(_ provider: any VaultProvider) -> Bool { provider.staysQuiet(lastAuthorized: authorizedAt[provider.id]) }

  func noteAuthorized(_ id: String) {
    guard sessions.session(id) != nil else { return }
    authorizedAt[id] = Date()
  }

  func yieldLaneToFill(_ id: String) {
    stopWarming(id)
    guard yieldingLoads.contains(id), cachedItems[id] != nil, let pending = loading[id] else { return }
    yieldingLoads.remove(id)
    pending.cancel()
  }

  func fetchItems(_ provider: any VaultProvider, yieldsToFills: Bool = false) async -> [VaultItem] {
    switch await fetchResult(provider, yieldsToFills: yieldsToFills) {
    case .success(let items): return items
    case .failure: return cachedItems[provider.id] ?? []
    }
  }

  func fetchResult(_ provider: any VaultProvider, yieldsToFills: Bool = false) async -> Result<[VaultItem], Error> {
    let id = provider.id
    if let pending = loading[id] {
      if !yieldsToFills { yieldingLoads.remove(id) }
      return await pending.value
    }
    guard let cli = VaultCLI.make(for: provider, sessions: sessions) else { return .failure(VaultError.locked) }
    let queue = lane(id)
    let task = Task { () -> Result<[VaultItem], Error> in
      do {
        let fresh = try await queue.run { try await provider.items(cli) }
        return self.apply(provider, fresh, ticket: cli.ticket)
      } catch {
        await self.fail(provider, error, ticket: cli.ticket)
        return .failure(error)
      }
    }
    loading[id] = task
    if yieldsToFills { yieldingLoads.insert(id) }
    let result = await task.value
    if loading[id] == task {
      loading[id] = nil
      yieldingLoads.remove(id)
    }
    return result
  }

  func apply(_ provider: any VaultProvider, _ fresh: VaultItemList, ticket: VaultLockEpoch.Ticket) -> Result<[VaultItem], Error> {
    let id = provider.id
    guard isCurrent(ticket), sessions.session(id) != nil else { return .failure(VaultError.locked) }
    let previous = cachedItems[id]
    let previousSecrets = (cachedPasswords[id] ?? [:]).mapValues(\.value)
    cachedItems[id] = fresh.items
    fetchedAt[id] = Date()
    if states[id]?.account != nil { snapshotAccounts[id] = cacheAccount(states[id]) }
    noteAuthorized(id)
    mergeSecrets(id, fresh)
    persist(id, toCloud: previous != fresh.items || previousSecrets != (cachedPasswords[id] ?? [:]).mapValues(\.value))
    sessions.touch(id)
    if previous != fresh.items { announceItems(id) }
    startTotpWarm(provider)
    return .success(fresh.items)
  }

  func freshItem(_ provider: any VaultProvider, _ itemId: String) async -> VaultItem? {
    if let found = await items(of: provider).first(where: { $0.id == itemId }) { return found }
    guard sessions.session(provider.id) != nil else { return nil }
    return await fetchItems(provider).first { $0.id == itemId }
  }

  func isCurrent(_ ticket: VaultLockEpoch.Ticket) -> Bool {
    guard epochs.isCurrent(ticket) else {
      VaultStoreCounts.note(\.staleWorkDropped)
      return false
    }
    return true
  }

  func fail(_ provider: any VaultProvider, _ error: Error, ticket: VaultLockEpoch.Ticket? = nil) async {
    guard let error = error as? VaultError else { return }
    if let ticket, !isCurrent(ticket) { return }
    switch error {
    case .locked:
      sessions.forget(provider.id, keepStored: sessions.touchID)
      if !isReady(provider.id) { dropItems(provider.id, announce: true) }
      _ = await currentState(provider)
    case .signedOut:
      sessions.signedOut(provider.id)
      forgetSnapshot(provider.id)
      _ = await currentState(provider)
    case .notFound:
      refetchAfterMissing(provider)
    default:
      break
    }
  }

  func refetchAfterMissing(_ provider: any VaultProvider) {
    let id = provider.id
    guard sessions.session(id) != nil, loading[id] == nil else { return }
    let now = Date().timeIntervalSince1970
    let last = sessions.value(id, Self.missingRefetchKey).flatMap(Double.init) ?? 0
    guard now - last >= Self.missingRefetchInterval else { return }
    sessions.setValue(id, Self.missingRefetchKey, String(now))
    sessions.setValue(id, VaultSessionStore.syncedAtKey, nil)
    NSLog("[vaults] %@ no longer has an item Ardia listed; refetching its list", id)
    Task { _ = await self.fetchItems(provider) }
  }

  func dropItems(_ id: String, announce: Bool) {
    stopWarming(id)
    forgetTotpWarm(id)
    siteIndexes[id] = nil
    cachedPasswords[id] = nil
    cachedTotps[id] = nil
    let had = !(cachedItems.removeValue(forKey: id) ?? []).isEmpty
    fetchedAt[id] = nil
    if announce && had { announceItems(id) }
  }
}
