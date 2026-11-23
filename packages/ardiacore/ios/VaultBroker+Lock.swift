import Foundation

extension VaultBroker {
  struct PendingLock: Sendable {
    let provider: any VaultProvider
    let cli: VaultCLI
    let session: String
  }

  func lock(_ id: String) async -> VaultProviderState? {
    if id == ArdiaVault.id { return await ArdiaVaultIndex.shared.refreshState() }
    guard let provider = VaultRegistry.provider(id) else { return nil }
    VaultLockPolicy.forgetUnlockedAtQuit()
    let pending = closeNow(provider)
    if let pending { await finishLock(pending) }
    return await currentState(provider)
  }

  func closeNow(_ provider: any VaultProvider) -> PendingLock? {
    let id = provider.id
    gate.lock(id)
    let session = sessions.session(id)
    let cli = session == nil ? nil : VaultCLI.make(for: provider, sessions: sessions)
    let keepStored = sessions.touchID
    epochs.advance(id) { sessions.forget(id, keepStored: keepStored) }
    authorizedAt[id] = nil
    dropItems(id, announce: true)
    stopWork(id)
    guard let cli, let session else { return nil }
    return PendingLock(provider: provider, cli: cli, session: session)
  }

  func finishLock(_ pending: PendingLock) async {
    await lane(pending.provider.id).runFirst {
      guard pending.cli.session == nil else { return }
      await pending.provider.lock(pending.cli, session: pending.session)
    }
  }

  func stopWork(_ id: String) {
    loading.removeValue(forKey: id)?.cancel()
    yieldingLoads.remove(id)
    stopWarming(id)
    for key in codeFetches.keys where key.hasPrefix("\(id)/") { codeFetches.removeValue(forKey: key)?.cancel() }
    recentCodes = recentCodes.filter { !$0.key.hasPrefix("\(id)/") }
    lanes[id]?.interrupt()
  }

  func lockAll() async {
    let open = Set(sessions.unlockedProviders).union(states.values.filter { $0.state == .unlocked }.map(\.id))
    let ids = VaultRegistry.providers.map(\.id)
    let keepStored = sessions.touchID
    var pending: [PendingLock] = []
    for provider in VaultRegistry.providers where open.contains(provider.id) && sessions.session(provider.id) != nil {
      if let cli = VaultCLI.make(for: provider, sessions: sessions), let session = sessions.session(provider.id) {
        pending.append(PendingLock(provider: provider, cli: cli, session: session))
      }
    }
    epochs.advanceAll { for id in ids { sessions.forget(id, keepStored: keepStored) } }
    gate.lockAll()
    reconnectGeneration += 1
    reconnecting?.cancel()
    reconnecting = nil
    for id in ids {
      authorizedAt[id] = nil
      dropItems(id, announce: true)
      stopWork(id)
    }
    VaultLockPolicy.forgetUnlockedAtQuit()
    mirrorOpenProviders()
    VaultOwnerCheck.reset()
    VaultKeychain.forgetValues()
    VaultSecretEntries.dropAll()
    VaultTotpSetup.forgetAll()
    await ArdiaVaultBackup.shared.dropSecrets()
    await MainActor.run {
      ArdiaWebView.wipeVaultCaptures()
      VaultPasswordDrafts.dropAll()
    }
    await withTaskGroup(of: Void.self) { group in
      for waiting in pending { group.addTask { await self.finishLock(waiting) } }
    }
    for provider in VaultRegistry.providers where open.contains(provider.id) { _ = await currentState(provider) }
  }

  func lockIdle() async {
    if storeOpen, sessions.isIdle(since: storeUsedAt) { return await lockAll() }
    for id in sessions.idleProviders() where !storeOpen { _ = await lock(id) }
  }

  func signOut(_ id: String) async -> VaultProviderState? {
    if id == ArdiaVault.id { return await ArdiaVaultIndex.shared.refreshState() }
    guard let provider = VaultRegistry.provider(id) else { return nil }
    sessions.cancelRunning(id)
    let cli = VaultCLI.make(for: provider, sessions: sessions)
    epochs.advance(id) { sessions.forget(id, keepStored: true) }
    authorizedAt[id] = nil
    dropItems(id, announce: true)
    stopWork(id)
    if let cli { await lane(id).runFirst { await provider.signOut(cli) } }
    sessions.signedOut(id)
    forgetSnapshot(id, everywhere: true)
    return await currentState(provider)
  }
}
