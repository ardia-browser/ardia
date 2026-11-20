import Foundation

extension VaultBroker {
  func configure(_ id: String, server: String?) async -> VaultProviderState? {
    if id == ArdiaVault.id { return await ArdiaVaultIndex.shared.refreshState() }
    guard let provider = VaultRegistry.provider(id) else { return nil }
    guard let cli = VaultCLI.make(for: provider, sessions: sessions) else { return await currentState(provider) }
    let problem = await lane(id).run { await provider.configure(cli, server: server) }
    var state = await currentState(provider)
    if let problem { state.message = problem }
    return state
  }

  func signIn(_ id: String, fields: VaultSignInFields) async -> VaultSignInResult? {
    if id == ArdiaVault.id { return await ArdiaVaultIndex.shared.signInResult() }
    guard let provider = VaultRegistry.provider(id) else { return nil }
    let ticket = epochs.ticket(id)
    guard let cli = VaultCLI.make(for: provider, sessions: sessions) else { return await missingTool(provider) }
    let epochs = self.epochs
    let result = await lane(id).run {
      guard epochs.isCurrent(ticket) else { return provider.stopped(state: .signedOut) }
      return await provider.signIn(cli, fields: fields)
    }
    guard epochs.isCurrent(ticket) else { return await stoppedResult(provider, state: .signedOut) }
    return await settle(provider, result, ticket: ticket, kind: .signIn)
  }

  func unlock(_ id: String, password: String?, handOn: VaultHandOn? = nil) async -> VaultSignInResult? {
    if id == ArdiaVault.id { return await ArdiaVaultIndex.shared.signInResult() }
    guard let provider = VaultRegistry.provider(id) else { return nil }
    let ticket = epochs.ticket(id)
    if password == nil, opensFromStore(id) { return await unlockFromStore(provider, ticket: ticket, handOn: handOn) }
    guard let cli = VaultCLI.make(for: provider, sessions: sessions) else { return await missingTool(provider) }
    let confirmedBefore = VaultOwnerCheck.lastConfirmed
    let epochs = self.epochs
    let result = await lane(id).run {
      guard epochs.isCurrent(ticket) else { return provider.stopped(state: .locked) }
      return await provider.unlock(cli, password: password)
    }
    guard epochs.isCurrent(ticket) else { return await stoppedResult(provider, state: .locked) }
    let settled = await settle(provider, result, ticket: ticket, kind: .unlock)
    if settled.ok, password == nil, VaultOwnerCheck.lastConfirmed != confirmedBefore { VaultOwnerCheck.passOn(handOn, provider: id) }
    return settled
  }

  func stoppedResult(_ provider: any VaultProvider, state: VaultState) async -> VaultSignInResult {
    var result = provider.stopped(state: state)
    result.state = await currentState(provider)
    return result
  }

  func typedPasswordExpired(_ id: String) async -> VaultSignInResult? {
    if id == ArdiaVault.id { return await ArdiaVaultIndex.shared.signInResult() }
    guard let provider = VaultRegistry.provider(id) else { return nil }
    return provider.typedPasswordExpired(states[id] ?? placeholder(provider))
  }

  func cancelSignIn(_ id: String) async -> VaultProviderState? {
    if id == ArdiaVault.id { return await ArdiaVaultIndex.shared.refreshState() }
    guard let provider = VaultRegistry.provider(id) else { return nil }
    if !isReady(id) {
      epochs.advance(id)
      lanes[id]?.interrupt()
    }
    sessions.cancelRunning(id)
    return await currentState(provider)
  }

  func missingTool(_ provider: any VaultProvider) async -> VaultSignInResult {
    let state = await currentState(provider)
    return VaultSignInResult(ok: false, state: state, error: "\(provider.name)'s command-line tool isn't installed.")
  }

  func settle(_ provider: any VaultProvider, _ outcome: VaultSignInResult, ticket: VaultLockEpoch.Ticket, kind: VaultSettle) async
    -> VaultSignInResult
  {
    guard epochs.isCurrent(ticket) else { return await stoppedResult(provider, state: .locked) }
    var result = outcome
    if result.ok {
      sessions.touch(provider.id)
      noteAuthorized(provider.id)
      openStore(kind, provider: provider.id, ticket: ticket)
      fetchedAt[provider.id] = nil
    }
    result.state = await currentState(provider)
    result.ok = result.ok && result.state.state == .unlocked && epochs.isCurrent(ticket)
    if result.ok, cachedItems[provider.id] != nil {
      announceItems(provider.id)
      Task { _ = await self.fetchItems(provider) }
    }
    return result
  }
}
