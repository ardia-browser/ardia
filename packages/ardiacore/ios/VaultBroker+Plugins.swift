import Foundation

extension VaultBroker {
  func providerAdded(_ id: String) async {
    guard let provider = VaultRegistry.provider(id) else { return }
    if resumedStore, !resumedAtQuit.contains(id), !isReady(id) { gate.lock(id) }
    restoreFromDisk(id)
    if resumedAtQuit.contains(id), isReady(id) { _ = publishOpened(provider, states[id] ?? placeholder(provider)) }
    _ = await refresh(id)
  }

  func providerRemoved(_ provider: any VaultProvider, forget: Bool) {
    let id = provider.id
    gate.lock(id)
    provider.locked()
    epochs.advance(id) { sessions.forget(id, keepStored: !forget) }
    authorizedAt[id] = nil
    stopWork(id)
    dropItems(id, announce: true)
    loading[id] = nil
    versions = versions.filter { !$0.key.hasSuffix("/\(provider.binaryName)") }
    if forget {
      sessions.signedOut(id)
      sessions.dropStored(id)
      forgetSnapshot(id)
    }
    var gone = states.removeValue(forKey: id) ?? provider.makeState(.unavailable)
    gone.state = .unavailable
    gone.unavailable = VaultProviderUnavailable(reason: .off, canRestart: false)
    lanes[id] = nil
    mirrorOpenProviders()
    let payload = ArdiaConsentStamp.begin().onto(["provider": gone.jsonObject(), "removed": true])
    DispatchQueue.main.async { ArdiaEvents.emit("vaults.changed", data: payload) }
  }

  func forgetProviderData(_ id: String) {
    guard !VaultRegistry.reservedIds.contains(id), VaultRegistry.provider(id) == nil else { return }
    epochs.advance(id) { sessions.signedOut(id) }
    sessions.dropStored(id)
    forgetSnapshot(id)
    guard var gone = states.removeValue(forKey: id) else { return }
    gone.state = .unavailable
    gone.unavailable = VaultProviderUnavailable(reason: .off, canRestart: false)
    let payload = ArdiaConsentStamp.begin().onto(["provider": gone.jsonObject(), "removed": true])
    DispatchQueue.main.async { ArdiaEvents.emit("vaults.changed", data: payload) }
  }

  func announceApproval(_ id: String, url: String) {
    let payload = ArdiaConsentStamp.begin().onto(["provider": id, "url": url])
    DispatchQueue.main.async { ArdiaEvents.emit("vaults.openApproval", data: payload) }
  }
}
