import Foundation

extension VaultBroker {
  func sync() async -> VaultSyncResult {
    var result = VaultSyncResult()
    for provider in VaultRegistry.providers {
      let id = provider.id
      guard sessions.session(id) != nil || (gate.admits(id) && cachedItems[id] != nil) else { continue }
      await pullFromCloud(id)
      if sessions.session(id) == nil { await reconnect(provider) }
      guard sessions.session(id) != nil else { continue }
      sessions.setValue(id, VaultSessionStore.syncedAtKey, nil)
      switch await fetchResult(provider) {
      case .success:
        await pullFromCloud(id)
        result.synced.append(id)
      case .failure:
        result.failed.append(id)
      }
    }
    await ArdiaVaultBackup.shared.backUp()
    result.syncedAt = lastSyncedAt
    result.iCloud = VaultCloud.shared.isOn
    result.backup = await ArdiaVaultBackup.shared.status(profiles: nil)
    return result
  }

  func syncStatus() async -> VaultSyncResult {
    VaultSyncResult(syncedAt: lastSyncedAt, iCloud: VaultCloud.shared.isOn, backup: await ArdiaVaultBackup.shared.status(profiles: nil))
  }

  func itemsJSON(_ id: String?) async -> String? {
    guard id == nil || id == ArdiaVault.id else { return nil }
    let ardia = await ArdiaVaultIndex.shared.itemsJSON()
    guard id == nil else { return ardia }
    let rest = await items(across: VaultRegistry.providers)
    guard !rest.isEmpty, let data = VaultJSON.data(rest.map { $0.jsonObject() }), let others = String(data: data, encoding: .utf8) else { return ardia }
    guard ardia != "[]" else { return others }
    return String(ardia.dropLast()) + "," + String(others.dropFirst())
  }

  func cloudChanged(_ id: String, fromHere: Bool) async {
    if gate.admits(id), cloudAccepts(id) != nil, cachedItems[id] != nil || sessions.session(id) != nil {
      return await pullFromCloud(id)
    }
    guard fromHere, cloudAccepts(id) != nil else { return }
    _ = await VaultCloud.perform { VaultCache.reconcile(id, account: nil) }
  }

  var lastSyncedAt: Double? {
    fetchedAt.values.max().map { $0.timeIntervalSince1970 * 1000 }
  }

  func unlockFromStore(_ provider: any VaultProvider, ticket: VaultLockEpoch.Ticket, handOn: VaultHandOn?) async -> VaultSignInResult {
    let id = provider.id
    let current = states[id] ?? placeholder(provider)
    guard await VaultOwnerCheck.confirm("unlock your passwords", touchScope: VaultTouchGrants.unlock(provider: id)) else {
      return VaultSignInResult(ok: false, state: current, error: "\(provider.name) stayed locked.")
    }
    guard openStore(.unlock, provider: id, ticket: ticket) else { return await stoppedResult(provider, state: .locked) }
    restoreFromDisk(id)
    guard cachedItems[id] != nil else {
      guard let cli = VaultCLI.make(for: provider, sessions: sessions) else { return await missingTool(provider) }
      let epochs = self.epochs
      let result = await lane(id).run {
        guard epochs.isCurrent(ticket) else { return provider.stopped(state: .locked) }
        return await provider.unlock(cli, password: nil)
      }
      let settled = await settle(provider, result, ticket: ticket, kind: .unlock)
      if settled.ok { VaultOwnerCheck.passOn(handOn, provider: id) }
      return settled
    }
    VaultOwnerCheck.passOn(handOn, provider: id)
    let state = publishOpened(provider, current)
    for other in VaultRegistry.providers where other.id != id && isReady(other.id) {
      if let known = states[other.id], known.state == .locked { _ = publishOpened(other, known) }
    }
    reconnectInBackground()
    return VaultSignInResult(ok: true, state: state)
  }

  func resumeAfterQuit() {
    let open = Set(VaultLockPolicy.takeUnlockedAtQuit())
    guard !open.isEmpty, sessions.touchID, !gate.open else { return }
    gate.resume(keeping: open, of: VaultRegistry.providers.map(\.id))
    storeOpened()
    for provider in VaultRegistry.providers where open.contains(provider.id) && isReady(provider.id) {
      _ = publishOpened(provider, states[provider.id] ?? placeholder(provider))
    }
    reconnectInBackground()
  }

  func mirrorOpenProviders() {
    VaultLockPolicy.noteOpen(storeOpen ? VaultRegistry.providers.map(\.id).filter { isReady($0) } : [])
    VaultAutoLock.shared.watchIdle(sessions.locksWhenIdle && (storeOpen || !sessions.unlockedProviders.isEmpty))
  }

  func publishOpened(_ provider: any VaultProvider, _ known: VaultProviderState) -> VaultProviderState {
    var state = known
    state.state = .unlocked
    let published = publish(state)
    announceItems(provider.id)
    return published
  }

  @discardableResult
  func openStore(_ kind: VaultSettle, provider: String, ticket: VaultLockEpoch.Ticket) -> Bool {
    guard epochs.isCurrent(ticket) else { return false }
    let opening = gate.settled(kind, provider: provider)
    if gate.open { storeUsedAt = Date() }
    if opening { storeOpened() }
    return true
  }

  func storeOpened() {
    storeUsedAt = Date()
    for provider in VaultRegistry.providers { restoreFromDisk(provider.id) }
    mirrorOpenProviders()
    guard VaultCloud.shared.isOn else { return }
    let wanted = VaultRegistry.providers.map(\.id).filter { cloudAccepts($0) != nil }
    Task { for id in wanted { await self.pullFromCloud(id) } }
  }

  func cloudAccepts(_ id: String) -> String? {
    let known = states[id]
    return VaultCloudAccount.accepted(state: known?.state, account: known?.account, server: known?.server, saved: snapshotAccounts[id])
      .map(VaultCacheSnapshot.normalizedAccount)
  }

  func reconnectInBackground() {
    guard reconnecting == nil else { return }
    let generation = reconnectGeneration
    reconnecting = Task {
      for provider in VaultRegistry.providers where self.isReady(provider.id) {
        guard !Task.isCancelled, self.storeOpen, generation == self.reconnectGeneration, VaultOwnerCheck.recentlyConfirmed else { break }
        if self.sessions.session(provider.id) == nil, self.reconnectsQuietly(provider) { await self.reconnect(provider) }
        guard self.storeOpen, generation == self.reconnectGeneration else {
          self.sessions.forget(provider.id, keepStored: self.sessions.touchID)
          break
        }
        if self.sessions.session(provider.id) != nil { _ = await self.currentState(provider) }
      }
      if generation == self.reconnectGeneration { self.reconnecting = nil }
    }
  }

  func reconnectsQuietly(_ provider: any VaultProvider) -> Bool {
    sessions.hasStoredSession(provider.id) || !provider.capabilities.masterPassword && provider.id != "1password"
  }

  func reconnect(_ provider: any VaultProvider) async {
    guard sessions.session(provider.id) == nil, let cli = VaultCLI.make(for: provider, sessions: sessions) else { return }
    guard sessions.hasStoredSession(provider.id) || !provider.capabilities.masterPassword else { return }
    _ = await lane(provider.id).run { await provider.unlock(cli, password: nil) }
    if sessions.session(provider.id) != nil, Date().timeIntervalSince(fetchedAt[provider.id] ?? .distantPast) >= Self.itemsLifetime {
      Task { _ = await self.fetchItems(provider) }
    }
  }

  func checkAccount(_ id: String, _ state: VaultProviderState) {
    guard state.state == .unlocked || state.state == .locked, state.account != nil else { return }
    let account = cacheAccount(state)
    guard let saved = snapshotAccounts[id], !saved.hasPrefix("@") else {
      if cachedItems[id] != nil { snapshotAccounts[id] = account }
      return
    }
    if VaultCacheSnapshot.normalizedAccount(saved) != VaultCacheSnapshot.normalizedAccount(account) { forgetSnapshot(id) }
  }

  func persist(_ id: String, toCloud: Bool = true) {
    guard cachedItems[id] != nil else { return }
    snapshotAccounts[id] = snapshotAccounts[id] ?? cacheAccount(states[id])
    guard let snapshot = memorySnapshot(id) else { return }
    VaultCache.save(id, snapshot, toCloud: toCloud)
  }

  func restoreFromDisk(_ id: String) {
    guard storeOpen || sessions.session(id) != nil, cachedItems[id] == nil, let snapshot = VaultCache.load(id) else { return }
    adopt(id, snapshot)
  }

  func pullFromCloud(_ id: String) async {
    let ticket = epochs.ticket(id)
    guard VaultCloud.shared.isOn, let account = cloudAccepts(id) else { return }
    let pulled = await VaultCloud.perform { VaultCache.reconcile(id, account: account).adopted }
    guard let pulled, epochs.isCurrent(ticket), !gate.closed.contains(id), storeOpen || sessions.session(id) != nil,
      cloudAccepts(id) == account
    else { return }
    let merged = memorySnapshot(id).map { VaultCacheSnapshot.merged($0, pulled) } ?? pulled
    let changed = cachedItems[id] != merged.items
    adopt(id, merged)
    if changed { announceItems(id) }
  }

  func memorySnapshot(_ id: String) -> VaultCacheSnapshot? {
    guard let items = cachedItems[id] else { return nil }
    return VaultCacheSnapshot(
      account: snapshotAccounts[id] ?? cacheAccount(states[id]), savedAt: (fetchedAt[id] ?? Date()).timeIntervalSince1970,
      entries: items.map { VaultCacheSnapshot.Entry(item: $0, totpPeriod: $0.totpPeriod) }, passwords: cachedPasswords[id] ?? [:],
      totps: cachedTotps[id] ?? [:])
  }

  func adopt(_ id: String, _ snapshot: VaultCacheSnapshot) {
    cachedItems[id] = snapshot.items
    cachedPasswords[id] = snapshot.passwords
    cachedTotps[id] = snapshot.totps ?? [:]
    fetchedAt[id] = Date(timeIntervalSince1970: snapshot.savedAt)
    snapshotAccounts[id] = snapshot.account
  }

  func mergeSecrets(_ id: String, _ fresh: VaultItemList) {
    cachedPasswords[id] = Self.merged(fresh.items, fresh.passwords, old: cachedPasswords[id] ?? [:])
    cachedTotps[id] = Self.merged(fresh.items, fresh.totps, old: cachedTotps[id] ?? [:])
  }

  static func merged(_ items: [VaultItem], _ values: [String: String], old: [String: VaultCacheSnapshot.Password])
    -> [String: VaultCacheSnapshot.Password]
  {
    var kept: [String: VaultCacheSnapshot.Password] = [:]
    for item in items {
      if let value = values[item.id] {
        kept[item.id] = VaultCacheSnapshot.Password(value: value, itemUpdatedAt: item.updatedAt)
      } else if let cached = old[item.id], cached.itemUpdatedAt == item.updatedAt {
        kept[item.id] = cached
      }
    }
    return kept
  }

  func remember(_ item: VaultItem, password: String) {
    let id = item.provider
    guard cachedItems[id] != nil else { return }
    cachedItems[id]?.removeAll { $0.id == item.id }
    cachedItems[id]?.append(item)
    cachedPasswords[id, default: [:]][item.id] = VaultCacheSnapshot.Password(value: password, itemUpdatedAt: item.updatedAt)
    persist(id)
    announceItems(id)
  }

  func localTotp(_ id: String, item: String) -> VaultTotpSecret? {
    guard isReady(id), let listed = cachedItems[id]?.first(where: { $0.id == item }), let hit = cachedTotps[id]?[item],
      hit.itemUpdatedAt == listed.updatedAt
    else { return nil }
    storeUsedAt = Date()
    return VaultTotpSecret(hit.value)
  }

  func forgetSnapshot(_ id: String, everywhere: Bool = false) {
    dropItems(id, announce: true)
    snapshotAccounts[id] = nil
    VaultCache.delete(id, fromCloud: everywhere)
  }
}
