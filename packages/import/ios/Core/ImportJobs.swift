import Foundation

public final class ImportJobs: @unchecked Sendable {
  public static let earlyCancelLifetime: TimeInterval = 60
  public static let earlyCancelLimit = 64

  private let lock = NSLock()
  private let now: () -> Date
  private var running: [String: Cancellation] = [:]
  private var cancelledEarly: [(id: String, at: Date)] = []

  public init(now: @escaping () -> Date = Date.init) {
    self.now = now
  }

  public func start(_ id: String) -> Cancellation {
    let c = Cancellation()
    let early = lock.withLock { () -> Bool in
      forgetOldCancels()
      running[id] = c
      guard let index = cancelledEarly.firstIndex(where: { $0.id == id }) else { return false }
      cancelledEarly.remove(at: index)
      return true
    }
    if early { c.cancel() }
    return c
  }

  public func cancel(_ id: String) {
    let found = lock.withLock { () -> Cancellation? in
      if let c = running[id] { return c }
      forgetOldCancels()
      cancelledEarly.append((id, now()))
      if cancelledEarly.count > Self.earlyCancelLimit { cancelledEarly.removeFirst(cancelledEarly.count - Self.earlyCancelLimit) }
      return nil
    }
    found?.cancel()
  }

  public func finish(_ id: String) { lock.withLock { running[id] = nil } }

  private func forgetOldCancels() {
    let cutoff = now().addingTimeInterval(-Self.earlyCancelLifetime)
    cancelledEarly.removeAll { $0.at < cutoff }
  }
}
