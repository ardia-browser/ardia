import Foundation

struct VaultFillValues: Sendable {
  let values: [String: String]
  let touched: Bool
}

actor VaultBroker {
  static let shared = VaultBroker()
  static let itemsLifetime: TimeInterval = 60
  static let offlineMessage = "You're offline. Saved logins still fill."
  static let codeReuseMargin: Double = 3000
  static let warmLimit = 3
  static let warmInterval: TimeInterval = 60
  static let warmedSitesLimit = 256
  static let missingRefetchInterval: TimeInterval = 30
  static let missingRefetchKey = "missingRefetchAt"

  let sessions = VaultSessionStore.shared
  var lanes: [String: VaultLane] = [:]
  var states: [String: VaultProviderState] = [:]
  var cachedItems: [String: [VaultItem]] = [:]
  var fetchedAt: [String: Date] = [:]
  var loading: [String: Task<Result<[VaultItem], Error>, Never>] = [:]
  var yieldingLoads: Set<String> = []
  var warming: [String: Task<Void, Never>] = [:]
  var warmedSites: [String: Date] = [:]
  var siteIndexes: [String: (items: [VaultItem], index: VaultSiteIndex)] = [:]
  var indexing: Set<String> = []
  var versions: [String: String] = [:]
  var refreshing: Task<Void, Never>?
  var ownerNeededForPasswords = true
  var cachedPasswords: [String: [String: VaultCacheSnapshot.Password]] = [:]
  var cachedTotps: [String: [String: VaultCacheSnapshot.Password]] = [:]
  var codeFetches: [String: Task<Result<VaultTotp, VaultFillError>, Never>] = [:]
  var recentCodes: [String: VaultTotp] = [:]
  var snapshotAccounts: [String: String] = [:]
  var gate = VaultStoreGate()
  var storeOpen: Bool { gate.open }
  var storeUsedAt = Date.distantPast
  var reconnecting: Task<Void, Never>?
  var reconnectGeneration = 0
  var authorizedAt: [String: Date] = [:]
  var resumedAtQuit: Set<String> = []
  var resumedStore = false
  let epochs = VaultLockEpochs.shared

  func providerStates() -> [VaultProviderState] {
    if refreshing == nil {
      refreshing = Task { await self.refreshAll() }
    }
    return VaultRegistry.providers.map { states[$0.id] ?? placeholder($0) } + [ArdiaVaultIndex.knownState]
  }

  func refresh(_ id: String, explicit: Bool = false) async -> VaultProviderState? {
    if id == ArdiaVault.id { return await ArdiaVaultIndex.shared.refreshState(explicit: explicit) }
    guard let provider = VaultRegistry.provider(id) else { return nil }
    if explicit {
      sessions.clearScratch(id)
      if sessions.session(id) != nil { fetchedAt[id] = nil }
    }
    return await currentState(provider)
  }

  func items(_ id: String?) async -> [VaultItem] {
    let ardia = id == nil || id == ArdiaVault.id ? await ArdiaVaultIndex.shared.items() : []
    return ardia + (await items(across: VaultRegistry.providers.filter { id == nil || $0.id == id }))
  }

  func items(across providers: [any VaultProvider]) async -> [VaultItem] {
    let lists = await withTaskGroup(of: (Int, [VaultItem]).self, returning: [[VaultItem]].self) { group in
      for (order, provider) in providers.enumerated() {
        group.addTask { (order, await self.items(of: provider)) }
      }
      var collected = Array(repeating: [VaultItem](), count: providers.count)
      for await (order, list) in group { collected[order] = list }
      return collected
    }
    return lists.flatMap { $0 }
  }

  func setOptions(idleLockMinutes: Int, touchID: Bool, askBeforeFilling: Bool, iCloudSync: Bool, lockOnQuit: Bool, lockOnScreenLock: Bool) {
    ownerNeededForPasswords = askBeforeFilling
    VaultCloud.shared.setEnabled(iCloudSync)
    VaultLockPolicy.set(lockOnQuit: lockOnQuit, lockOnScreenLock: lockOnScreenLock)
    sessions.setOptions(idleLockMinutes: idleLockMinutes, touchID: touchID)
    guard !touchID else { return }
    for provider in VaultRegistry.providers { sessions.dropStored(provider.id) }
  }

  func refreshAll() async {
    await withTaskGroup(of: Void.self) { group in
      for provider in VaultRegistry.providers {
        group.addTask { _ = await self.refresh(provider.id) }
      }
      group.addTask { _ = await ArdiaVaultIndex.shared.refreshState() }
    }
    refreshing = nil
  }

  func placeholder(_ provider: any VaultProvider) -> VaultProviderState {
    guard VaultBinaryLocator.locate(provider.binaryName) != nil else { return provider.makeState(.notInstalled) }
    var state = provider.makeState(.locked)
    state.touchUnlock = opensFromStore(provider.id) || sessions.hasStoredSession(provider.id)
    return state
  }

  func lane(_ id: String) -> VaultLane {
    if let lane = lanes[id] { return lane }
    let lane = VaultLane()
    lanes[id] = lane
    return lane
  }

  func isReady(_ id: String) -> Bool {
    if sessions.session(id) != nil { return true }
    return gate.admits(id) && cachedItems[id] != nil
  }

  func opensFromStore(_ id: String) -> Bool {
    guard sessions.touchID, !isReady(id) else { return false }
    return cachedItems[id] != nil || VaultCache.exists(id)
  }

  func currentState(_ provider: any VaultProvider) async -> VaultProviderState {
    guard let cli = VaultCLI.make(for: provider, sessions: sessions) else {
      if sessions.session(provider.id) != nil { sessions.forget(provider.id, keepStored: true) }
      dropItems(provider.id, announce: true)
      return publish(provider.makeState(.notInstalled))
    }
    if !provider.readsOffline, VaultNetwork.isOffline, var known = states[provider.id] {
      known.message = Self.offlineMessage
      return publish(known)
    }
    let installedVersion = await version(of: cli)
    let askedWith = sessions.session(provider.id)
    var state = await lane(provider.id).run { await provider.state(cli) }
    if state.state == .unavailable, VaultNetwork.isOffline { state.message = Self.offlineMessage }
    state.cliPath = cli.path
    state.cliVersion = installedVersion
    reconcile(provider.id, with: state.state, askedWith: askedWith)
    checkAccount(provider.id, state)
    switch state.state {
    case .unlocked, .unavailable:
      break
    case .locked where isReady(provider.id):
      state.state = .unlocked
    case .signedOut:
      forgetSnapshot(provider.id)
    default:
      dropItems(provider.id, announce: true)
    }
    return publish(state)
  }

  func reconcile(_ id: String, with state: VaultState, askedWith: String?) {
    guard let session = sessions.session(id), session == askedWith else { return }
    switch state {
    case .signedOut: sessions.signedOut(id)
    case .locked: sessions.forget(id, keepStored: false)
    default: break
    }
  }

  func version(of cli: VaultCLI) async -> String? {
    let key = (cli.path as NSString).resolvingSymlinksInPath
    if let known = versions[key] { return known }
    guard let found = await cli.version() else { return nil }
    versions[key] = found
    return found
  }

  func cacheAccount(_ state: VaultProviderState?) -> String { "\(state?.account ?? "")@\(state?.server ?? "")" }

  func publish(_ fresh: VaultProviderState) -> VaultProviderState {
    mirrorOpenProviders()
    var state = fresh
    state.touchUnlock = state.state == .locked && (opensFromStore(state.id) || sessions.hasStoredSession(state.id))
    guard states[state.id] != state else { return state }
    states[state.id] = state
    let payload = ArdiaConsentStamp.begin().onto(["provider": state.jsonObject()])
    DispatchQueue.main.async { ArdiaEvents.emit("vaults.changed", data: payload) }
    return state
  }

  func announceItems(_ id: String) {
    let payload = ArdiaConsentStamp.begin().onto(["provider": id])
    DispatchQueue.main.async { ArdiaEvents.emit("vaults.itemsChanged", data: payload) }
  }
}
