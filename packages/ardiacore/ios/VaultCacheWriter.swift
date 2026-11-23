import Foundation

final class VaultCacheWriter: @unchecked Sendable {
  private struct Pending {
    var snapshot: VaultCacheSnapshot
    var toCloud: Bool
  }

  private let queue = DispatchQueue(label: "dev.ardia.vaults.cache-writer", qos: .utility)
  private let lock = NSLock()
  private var pending: [String: Pending] = [:]
  private let write: @Sendable (String, VaultCacheSnapshot, Bool) -> Void

  init(write: @escaping @Sendable (String, VaultCacheSnapshot, Bool) -> Void) {
    self.write = write
  }

  func save(_ id: String, _ snapshot: VaultCacheSnapshot, toCloud: Bool) {
    let schedule = lock.withLock { () -> Bool in
      let earlier = pending[id]
      pending[id] = Pending(snapshot: snapshot, toCloud: toCloud || earlier?.toCloud == true)
      return earlier == nil
    }
    guard schedule else { return }
    queue.async { self.flush(id) }
  }

  func settle(_ id: String) {
    queue.sync { flush(id) }
  }

  func forget(_ id: String) {
    lock.withLock { pending[id] = nil }
    queue.sync {}
  }

  private func flush(_ id: String) {
    guard let next = lock.withLock({ pending.removeValue(forKey: id) }) else { return }
    write(id, next.snapshot, next.toCloud)
  }
}
