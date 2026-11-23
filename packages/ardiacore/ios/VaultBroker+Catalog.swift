import Foundation
import os

enum VaultItemsRevision {
  private static let counter = OSAllocatedUnfairLock(initialState: 0)

  static func next() -> Int { counter.withLock { $0 += 1; return $0 } }
}

final class VaultSearchLanes: @unchecked Sendable {
  static let shared = VaultSearchLanes()
  private let lock = NSLock()
  private var newest: [String: Int] = [:]

  func begin(_ channel: String) -> Int {
    lock.withLock {
      let next = (newest[channel] ?? 0) + 1
      newest[channel] = next
      return next
    }
  }

  func isCurrent(_ channel: String, _ ticket: Int) -> Bool { lock.withLock { newest[channel] == ticket } }
}

extension VaultUsage {
  static let shared = VaultUsage(
    read: { VaultCache.readSealed(VaultUsage.name).plain },
    write: { data in _ = VaultCache.changeSealed(VaultUsage.name) { _ in (data, true) } })
}

extension VaultCatalog.ProfileFilter {
  var usageProfile: String? {
    if case .profile(let name) = self { return name }
    return nil
  }
}

struct VaultCatalogKey: Equatable, Sendable {
  let ardia: Int
  let managers: Int
  let ready: [String]
}

extension VaultBroker {
  var listedProviders: [String] { VaultRegistry.providers.map(\.id).filter { isReady($0) && cachedItems[$0] != nil } }

  func currentCatalog() async -> VaultCatalog {
    let ardia = await ArdiaVaultIndex.shared.snapshot()
    for provider in VaultRegistry.providers where isReady(provider.id) || (sessions.session(provider.id) == nil && gate.admits(provider.id)) {
      _ = await items(of: provider)
    }
    let listed = listedProviders
    let key = VaultCatalogKey(ardia: ardia.revision, managers: itemsRevision, ready: listed)
    if let catalog, catalog.key == key { return catalog.catalog }
    if let catalogBuild, catalogBuild.key == key { return await catalogBuild.task.value }
    let items = ardia.items + listed.flatMap { cachedItems[$0] ?? [] }
    let started = ContinuousClock.now
    let task = Task.detached(priority: .userInitiated) { VaultCatalog(items, ownProvider: ArdiaVault.id) }
    catalogBuild = (key, task)
    let built = await task.value
    if catalogBuild?.key == key {
      catalogBuild = nil
      catalog = (key, built)
      VaultUsage.shared.prune(listed: items, providers: Set(listed + [ArdiaVault.id]))
      VaultStoreCounts.note(\.catalogBuilds)
      if started.duration(to: .now) > VaultCatalog.slowBuild { VaultStoreCounts.note(\.catalogBuildsSlow) }
    }
    return built
  }

  func dropCatalog() {
    catalog = nil
    catalogBuild = nil
  }

  func siteItems(origin: String) async -> [String: Any] {
    let catalog = await currentCatalog()
    return ["items": catalog.near(origin).map { $0.jsonObject() }, "listed": listedProviders, "revision": itemsRevision]
  }

  func searchItems(_ query: String, origin: String, limit: Int, filter: VaultCatalog.ProfileFilter, channel: String?) async -> [String: Any] {
    let ticket = channel.map { VaultSearchLanes.shared.begin($0) }
    let catalog = await currentCatalog()
    let revision = itemsRevision
    if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return ["items": catalog.search(query, limit: limit, filter: filter).map { $0.jsonObject() }, "revision": revision]
    }
    let found = await Task.detached(priority: .userInitiated) { () -> [VaultItem]? in
      catalog.smartSearch(query, origin: origin, limit: limit, filter: filter) {
        guard let channel, let ticket else { return false }
        return !VaultSearchLanes.shared.isCurrent(channel, ticket)
      }
    }.value
    guard let found else { return ["items": [Any](), "revision": revision, "cancelled": true] }
    return ["items": found.map { $0.jsonObject() }, "revision": revision]
  }

  func recommend(origin: String, filter: VaultCatalog.ProfileFilter, pageUsername: String?, remembered: String?) async -> [String: Any] {
    let catalog = await currentCatalog()
    let listed = listedProviders
    let revision = itemsRevision
    let ranked = await Task.detached(priority: .userInitiated) { () -> [VaultRanked] in
      let usage = VaultUsage.shared.signals(profile: filter.usageProfile, origin: origin)
      return catalog.recommend(origin: origin, filter: filter, usage: usage, pageUsername: pageUsername, remembered: remembered)
    }.value
    return ["items": ranked.map { $0.jsonObject() }, "listed": listed, "revision": revision]
  }

  func listItems(query: String, offset: Int, limit: Int, filter: VaultCatalog.ProfileFilter) async -> [String: Any] {
    let page = await currentCatalog().page(query: query, offset: offset, limit: limit, filter: filter)
    return ["total": page.total, "items": page.items.map { $0.jsonObject() }, "revision": itemsRevision]
  }

  func usernames(email: Bool, limit: Int, filter: VaultCatalog.ProfileFilter) async -> [[String: Any]] {
    await currentCatalog().usernames(email: email, limit: limit, filter: filter).map { $0.jsonObject() }
  }

  func itemsStatus() async -> [String: Any] {
    let catalog = await currentCatalog()
    var counts: [String: Int] = [:]
    for item in catalog.items { counts[item.provider, default: 0] += 1 }
    return ["revision": itemsRevision, "listed": listedProviders, "counts": counts]
  }
}
