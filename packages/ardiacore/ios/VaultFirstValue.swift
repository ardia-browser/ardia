import Foundation
import os

final class VaultFirstValue: Sendable {
  private struct State {
    var settled = false
    var value: String?
    var waiter: CheckedContinuation<String?, Never>?
  }

  private let state = OSAllocatedUnfairLock(initialState: State())

  func offer(_ candidate: String?) {
    let waiter = state.withLock { state -> CheckedContinuation<String?, Never>? in
      guard !state.settled else { return nil }
      state.settled = true
      state.value = candidate
      defer { state.waiter = nil }
      return state.waiter
    }
    waiter?.resume(returning: candidate)
  }

  func wait(timeout: TimeInterval) async -> String? {
    DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + timeout) { self.offer(nil) }
    return await withCheckedContinuation { continuation in
      let settled = state.withLock { state -> String?? in
        guard state.settled else {
          state.waiter = continuation
          return nil
        }
        return .some(state.value)
      }
      if let value = settled { continuation.resume(returning: value) }
    }
  }
}
