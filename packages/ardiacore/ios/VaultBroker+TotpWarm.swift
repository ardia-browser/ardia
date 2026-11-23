import Foundation

extension VaultBroker {
  func codes(for keys: [(provider: String, id: String)]) async -> [String: Any] {
    var codes: [String: Any] = [:]
    var none: [String] = []
    var wanted: [String: Set<String>] = [:]
    for key in keys { wanted[key.provider, default: []].insert(key.id) }
    for (id, ids) in wanted {
      if id == ArdiaVault.id {
        for item in ids {
          if let code = await ArdiaVaultIndex.shared.totp(id: item) { codes["\(id)/\(item)"] = code.jsonObject() } else { none.append("\(id)/\(item)") }
        }
        continue
      }
      guard isReady(id), let listed = cachedItems[id] else { continue }
      var missing: Set<String> = []
      for item in listed where ids.contains(item.id) {
        let cached = cachedTotps[id]?[item.id]
        switch VaultTotpWarmPlan.knowledge(of: item, cached: cached) {
        case .secret:
          if let code = cached.flatMap({ VaultTotpSecret($0.value) })?.totp() { codes["\(id)/\(item.id)"] = code.jsonObject() } else { missing.insert(item.id) }
        case .none:
          none.append("\(id)/\(item.id)")
        case .unknown:
          missing.insert(item.id)
        }
      }
      if !codes.isEmpty { storeUsedAt = Date() }
      if !missing.isEmpty, let provider = VaultRegistry.provider(id) {
        totpUrgent[id, default: []].formUnion(missing)
        startTotpWarm(provider)
      }
    }
    return ["codes": codes, "none": none]
  }

  func focusTotpWarm(on origin: String) {
    guard let host = VaultOriginMatch.host(of: origin) else { return }
    totpFocusSite = VaultOriginMatch.siteKey(host)
    for provider in VaultRegistry.providers where cachedItems[provider.id] != nil { startTotpWarm(provider) }
  }

  func startTotpWarm(_ provider: any VaultProvider) {
    let id = provider.id
    guard totpWarming[id] == nil, sessions.session(id) != nil, cachedItems[id] != nil, provider.capabilities.totp else { return }
    guard provider.readsOffline || !VaultNetwork.isOffline, staysQuiet(provider), let cli = VaultCLI.make(for: provider, sessions: sessions) else { return }
    let ticket = cli.ticket
    totpWarming[id] = Task(priority: .background) { await self.warmTotps(provider, cli: cli, ticket: ticket) }
  }

  func totpWarmQueue(_ id: String) -> [VaultItem] {
    guard let items = cachedItems[id] else { return [] }
    return VaultTotpWarmPlan.order(
      items, cached: cachedTotps[id] ?? [:], tried: totpWarmTried[id] ?? [], urgent: totpUrgent[id] ?? [], focusSite: totpFocusSite,
      sweepLeft: totpSweepLeft[id] ?? VaultTotpWarmPlan.sweepLimit, limit: .max)
  }

  func totpWarmShape(_ id: String) -> [String] { ["\(itemsRevision)", totpFocusSite ?? "", (totpUrgent[id] ?? []).sorted().joined(separator: ",")] }

  func warmTotps(_ provider: any VaultProvider, cli: VaultCLI, ticket: VaultLockEpoch.Ticket) async {
    let id = provider.id
    defer { totpWarming[id] = nil }
    var shape = totpWarmShape(id)
    var queue = totpWarmQueue(id)[...]
    var learned = false
    var persistedAt = ContinuousClock.now
    while let item = queue.popFirst() {
      guard !Task.isCancelled, isCurrent(ticket), sessions.session(id) != nil, staysQuiet(provider) else { return finishTotpPage(id, learned) }
      totpWarmTried[id, default: []].insert(item.id)
      let asked = totpUrgent[id]?.remove(item.id) != nil
      if !asked, item.hasTotp != true { totpSweepLeft[id] = (totpSweepLeft[id] ?? VaultTotpWarmPlan.sweepLimit) - 1 }
      let revealed = try? await lane(id).runBehindOthers { try await provider.revealed(cli, id: item.id) }
      if let revealed, keepWarmedTotp(id, item: item, revealed, ticket: ticket) {
        learned = true
        if asked { announceCodes(id) }
      }
      if learned, persistedAt.duration(to: .now) >= VaultTotpWarmPlan.persistEvery || (totpUrgent[id] ?? []).isEmpty && queue.isEmpty {
        finishTotpPage(id, learned)
        learned = false
        persistedAt = .now
      }
      try? await Task.sleep(for: VaultTotpWarmPlan.pause)
      if totpWarmShape(id) != shape {
        shape = totpWarmShape(id)
        queue = totpWarmQueue(id)[...]
      }
    }
    finishTotpPage(id, learned)
  }

  func keepWarmedTotp(_ id: String, item: VaultItem, _ revealed: VaultRevealed, ticket: VaultLockEpoch.Ticket) -> Bool {
    guard isCurrent(ticket), sessions.session(id) != nil, cachedItems[id] != nil, !(cachedItems[id]?.isEmpty ?? true) else { return false }
    cachedTotps[id, default: [:]][item.id] = VaultTotpWarmPlan.entry(for: revealed.totp, item: item)
    if let password = revealed.password {
      cachedPasswords[id, default: [:]][item.id] = VaultCacheSnapshot.Password(value: password, itemUpdatedAt: item.updatedAt)
    }
    return true
  }

  func finishTotpPage(_ id: String, _ learned: Bool) {
    guard learned, cachedItems[id] != nil else { return }
    persist(id, toCloud: false)
    announceCodes(id)
  }

  func forgetTotpWarm(_ id: String) {
    totpWarming.removeValue(forKey: id)?.cancel()
    totpWarmTried[id] = nil
    totpUrgent[id] = nil
  }

  func announceCodes(_ id: String) {
    let payload = ArdiaConsentStamp.begin().onto(["provider": id])
    DispatchQueue.main.async { ArdiaEvents.emit("vaults.codesWarmed", data: payload) }
  }
}
