import os

struct VaultLockEpoch: Sendable, Equatable {
  struct Ticket: Sendable, Equatable {
    let provider: String
    let everyone: Int
    let own: Int
  }

  private var everyone = 0
  private var own: [String: Int] = [:]

  func ticket(_ provider: String) -> Ticket { Ticket(provider: provider, everyone: everyone, own: own[provider, default: 0]) }

  func isCurrent(_ ticket: Ticket) -> Bool { ticket == self.ticket(ticket.provider) }

  mutating func advance(_ provider: String) { own[provider, default: 0] += 1 }

  mutating func advanceAll() { everyone += 1 }
}

final class VaultLockEpochs: Sendable {
  static let shared = VaultLockEpochs()

  private let state = OSAllocatedUnfairLock(initialState: VaultLockEpoch())

  func ticket(_ provider: String) -> VaultLockEpoch.Ticket { state.withLock { $0.ticket(provider) } }

  func isCurrent(_ ticket: VaultLockEpoch.Ticket) -> Bool { state.withLock { $0.isCurrent(ticket) } }

  func advance(_ provider: String, while closing: () -> Void = {}) {
    state.withLockUnchecked { epoch in
      epoch.advance(provider)
      closing()
    }
  }

  func advanceAll(while closing: () -> Void = {}) {
    state.withLockUnchecked { epoch in
      epoch.advanceAll()
      closing()
    }
  }

  @discardableResult
  func ifCurrent(_ ticket: VaultLockEpoch.Ticket, _ work: () -> Void) -> Bool {
    state.withLockUnchecked { epoch in
      guard epoch.isCurrent(ticket) else { return false }
      work()
      return true
    }
  }
}

enum VaultSettle: Sendable {
  case signIn
  case unlock
}

struct VaultStoreGate: Sendable, Equatable {
  private(set) var open = false
  var closed: Set<String> = []

  func admits(_ provider: String) -> Bool { open && !closed.contains(provider) }

  mutating func settled(_ kind: VaultSettle, provider: String) -> Bool {
    closed.remove(provider)
    guard kind == .unlock, !open else { return false }
    open = true
    return true
  }

  mutating func lock(_ provider: String) {
    if open { closed.insert(provider) }
  }

  mutating func lockAll() { self = VaultStoreGate() }

  mutating func resume(keeping providers: Set<String>, of all: [String]) {
    open = true
    closed = Set(all).subtracting(providers)
  }
}
