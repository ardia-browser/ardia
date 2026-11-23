import Foundation

protocol VaultSecretBackend: Sendable {
  func listAccounts() -> Set<String>?
  func exists(_ account: String) -> Bool?
  func value(_ account: String) -> String?
  func store(_ account: String, _ secret: String) -> Bool
  func remove(_ account: String) -> Bool
}

enum VaultSecretLookup: Equatable, Sendable {
  case found(String)
  case missing
  case failed

  var value: String? {
    if case .found(let value) = self { return value }
    return nil
  }
}

struct VaultSecretCounts: Equatable, Sendable {
  var backendReads = 0
  var memoryReads = 0
  var skippedWrites = 0
  var listings = 0
}

final class VaultSecretShelf: @unchecked Sendable {
  private let backend: any VaultSecretBackend
  private let lock = NSLock()
  private var listed = false
  private var present: [String: Bool] = [:]
  private var values: [String: String] = [:]
  private var counts = VaultSecretCounts()

  init(_ backend: any VaultSecretBackend) { self.backend = backend }

  func contains(_ account: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return knownPresence(account) ?? false
  }

  func read(_ account: String, keep: Bool = true) -> String? { lookup(account, keep: keep).value }

  func lookup(_ account: String, keep: Bool = true) -> VaultSecretLookup {
    lock.lock()
    defer { lock.unlock() }
    if let value = values[account] {
      counts.memoryReads += 1
      return .found(value)
    }
    switch knownPresence(account) {
    case false?: return .missing
    case nil: return .failed
    case true?: break
    }
    counts.backendReads += 1
    guard let value = backend.value(account) else { return .failed }
    if keep { values[account] = value }
    return .found(value)
  }

  func write(_ account: String, _ secret: String, keep: Bool = true) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if keep, values[account] == secret {
      counts.skippedWrites += 1
      return true
    }
    guard backend.store(account, secret) else { return false }
    values[account] = keep ? secret : nil
    present[account] = true
    return true
  }

  func noteStoredElsewhere(_ account: String) {
    lock.lock()
    values[account] = nil
    present[account] = true
    lock.unlock()
  }

  func delete(_ account: String) {
    lock.lock()
    defer { lock.unlock() }
    values[account] = nil
    guard knownPresence(account) != false else { return }
    guard backend.remove(account) else { return }
    present[account] = false
  }

  func forgetValues() {
    lock.lock()
    values.removeAll()
    lock.unlock()
  }

  func accounts() -> Set<String>? {
    lock.lock()
    defer { lock.unlock() }
    guard let all = backend.listAccounts() else { return nil }
    counts.listings += 1
    for name in all { present[name] = true }
    return all
  }

  func takeCounts() -> VaultSecretCounts {
    lock.lock()
    defer { lock.unlock() }
    let taken = counts
    counts = VaultSecretCounts()
    return taken
  }

  private func knownPresence(_ account: String) -> Bool? {
    if values[account] != nil { return true }
    if let known = present[account] { return known }
    if !listed, let all = backend.listAccounts() {
      counts.listings += 1
      listed = true
      for name in all where present[name] == nil { present[name] = true }
    }
    if listed {
      let found = present[account] ?? false
      present[account] = found
      return found
    }
    guard let found = backend.exists(account) else { return nil }
    present[account] = found
    return found
  }
}
