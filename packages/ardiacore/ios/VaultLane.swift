import os

actor VaultLane {
  enum Turn: Sendable {
    case first
    case inTurn
    case behindOthers
  }

  private var busy = false
  private var waitingFirst: [CheckedContinuation<Void, Never>] = []
  private var waiting: [CheckedContinuation<Void, Never>] = []
  private var waitingBehind: [CheckedContinuation<Void, Never>] = []
  private nonisolated let stopCurrent = OSAllocatedUnfairLock<(@Sendable () -> Void)?>(initialState: nil)

  func run<T: Sendable>(_ work: @escaping @Sendable () async -> T) async -> T { await run(.inTurn, work) }

  func run<T: Sendable>(_ work: @escaping @Sendable () async throws -> T) async throws -> T { try await run(.inTurn, work) }

  func runFirst<T: Sendable>(_ work: @escaping @Sendable () async -> T) async -> T { await run(.first, work) }

  func runBehindOthers<T: Sendable>(_ work: @escaping @Sendable () async -> T) async -> T { await run(.behindOthers, work) }

  func runBehindOthers<T: Sendable>(_ work: @escaping @Sendable () async throws -> T) async throws -> T { try await run(.behindOthers, work) }

  func run<T: Sendable>(_ turn: Turn, _ work: @escaping @Sendable () async -> T) async -> T {
    await enter(turn)
    defer { leave() }
    let task = Task { await work() }
    stopCurrent.withLock { $0 = { task.cancel() } }
    return await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
  }

  func run<T: Sendable>(_ turn: Turn, _ work: @escaping @Sendable () async throws -> T) async throws -> T {
    await enter(turn)
    defer { leave() }
    let task = Task { try await work() }
    stopCurrent.withLock { $0 = { task.cancel() } }
    return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
  }

  nonisolated func interrupt() { stopCurrent.withLock { $0 }?() }

  var waitingCount: Int { waitingFirst.count + waiting.count + waitingBehind.count }

  private func enter(_ turn: Turn) async {
    guard busy else {
      busy = true
      return
    }
    await withCheckedContinuation { continuation in
      switch turn {
      case .first: waitingFirst.append(continuation)
      case .inTurn: waiting.append(continuation)
      case .behindOthers: waitingBehind.append(continuation)
      }
    }
  }

  private func leave() {
    stopCurrent.withLock { $0 = nil }
    if !waitingFirst.isEmpty {
      waitingFirst.removeFirst().resume()
    } else if !waiting.isEmpty {
      waiting.removeFirst().resume()
    } else if !waitingBehind.isEmpty {
      waitingBehind.removeFirst().resume()
    } else {
      busy = false
    }
  }
}
