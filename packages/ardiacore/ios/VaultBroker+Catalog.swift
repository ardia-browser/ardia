import Foundation
import os

enum VaultItemsRevision {
  private static let counter = OSAllocatedUnfairLock(initialState: 0)

  static func next() -> Int { counter.withLock { $0 += 1; return $0 } }
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

  func searchItems(_ query: String, limit: Int, filter: VaultCatalog.ProfileFilter) async -> [[String: Any]] {
    await currentCatalog().search(query, limit: limit, filter: filter).map { $0.jsonObject() }
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
