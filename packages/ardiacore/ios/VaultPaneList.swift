import Foundation

actor VaultPaneList {
  static let shared = VaultPaneList()
  static let pageLimit = 500
  static let ordersKept = 4
  static let profilesKept = 2

  private struct Merged {
    let key: String
    let order: VaultPaneOrder
  }

  private var saved: [String: VaultSavedIndex] = [:]
  private var savedUse: [String] = []
  private var loads: [String: Task<VaultSavedIndex, Never>] = [:]
  private var merged: [Merged] = []
  private var merging: [String: Task<VaultPaneOrder, Never>] = [:]

  func rows(profile: String, query: String, offset: Int, limit: Int, managers: Bool, reload: Bool, channel: String?) async -> [String: Any] {
    let ticket = channel.map { VaultSearchLanes.shared.begin($0) }
    let index = await savedIndex(profile, reload: reload)
    let catalog = managers ? await VaultBroker.shared.currentCatalog() : nil
    let key = "\(profile)\n\(index.generation)\n\(catalog?.built ?? 0)\n\(query)"
    let order = await order(key, saved: index, catalog: catalog, query: query)
    if let channel, let ticket, !VaultSearchLanes.shared.isCurrent(channel, ticket) { return ["cancelled": true] }
    let start = min(max(offset, 0), order.rows.count)
    let end = min(start + min(max(limit, 0), Self.pageLimit), order.rows.count)
    let rows: [[String: Any]] = order.rows[start..<end].map { encoded in
      if encoded >= 0 {
        let login = index.logins[Int(encoded)]
        return ["saved": ["origin": login.origin, "username": login.username, "created": 0, "modified": 0]]
      }
      return ["item": catalog!.items[Int(-encoded - 1)].jsonObject()]
    }
    return ["total": order.rows.count, "listed": order.listed, "offset": start, "rows": rows, "revision": "\(index.generation).\(catalog?.built ?? 0)"]
  }

  func savedOn(profile: String, origin: String) async -> [[String: Any]] {
    await savedIndex(profile, reload: false).on(origin).map { ["origin": $0.origin, "username": $0.username, "created": 0, "modified": 0] }
  }

  private func order(_ key: String, saved index: VaultSavedIndex, catalog: VaultCatalog?, query: String) async -> VaultPaneOrder {
    if let known = merged.first(where: { $0.key == key }) { return known.order }
    if let running = merging[key] { return await running.value }
    let task = Task.detached(priority: .userInitiated) { VaultPaneOrder.merge(saved: index, catalog: catalog, query: query) }
    merging[key] = task
    let order = await task.value
    merging[key] = nil
    merged.removeAll { $0.key == key }
    merged.insert(Merged(key: key, order: order), at: 0)
    if merged.count > Self.ordersKept { merged.removeLast(merged.count - Self.ordersKept) }
    return order
  }

  private func savedIndex(_ profile: String, reload: Bool) async -> VaultSavedIndex {
    if !reload, let known = saved[profile] { return known }
    let running = loads[profile]
    if !reload, let running { return await running.value }
    let task = Task {
      _ = await running?.value
      return await Self.read(profile)
    }
    loads[profile] = task
    let index = await task.value
    if loads[profile] == task { loads[profile] = nil }
    if let known = saved[profile], known.generation > index.generation { return known }
    saved[profile] = index
    savedUse.removeAll { $0 == profile }
    savedUse.insert(profile, at: 0)
    for dropped in savedUse.dropFirst(Self.profilesKept) { saved[dropped] = nil }
    savedUse = Array(savedUse.prefix(Self.profilesKept))
    merged.removeAll { $0.key.hasPrefix("\(profile)\n") && !$0.key.hasPrefix("\(profile)\n\(index.generation)\n") }
    return index
  }

  private static func read(_ profile: String) async -> VaultSavedIndex {
    let json = await withCheckedContinuation { (done: CheckedContinuation<String?, Never>) in
      DispatchQueue.main.async { ArdiaServices.listPasswordsJSON(profile) { done.resume(returning: $0) } }
    }
    return await Task.detached(priority: .userInitiated) { VaultSavedIndex(json.flatMap(VaultSavedIndex.parse) ?? []) }.value
  }
}
