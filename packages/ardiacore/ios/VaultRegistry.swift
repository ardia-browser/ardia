import os

protocol VaultProviderSource: AnyObject, Sendable {
  var vaultProviders: [any VaultProvider] { get }
}

enum VaultRegistry {
  static let reservedIds: Set<String> = ["ardia"]
  private static let sources = OSAllocatedUnfairLock(initialState: [any VaultProviderSource]())

  static var providers: [any VaultProvider] {
    var seen: Set<String> = []
    return sources.withLock { Array($0) }.flatMap(\.vaultProviders).filter { seen.insert($0.id).inserted && !reservedIds.contains($0.id) }
  }

  static func provider(_ id: String) -> (any VaultProvider)? { providers.first { $0.id == id } }

  static func add(_ source: any VaultProviderSource) {
    sources.withLock { held in
      if !held.contains(where: { $0 === source }) { held.append(source) }
    }
  }

  static func remove(_ source: any VaultProviderSource) {
    sources.withLock { held in held.removeAll { $0 === source } }
  }
}
