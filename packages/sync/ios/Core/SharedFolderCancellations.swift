import Foundation

public final class SharedFolderCancellations: @unchecked Sendable {
  private let lock = NSLock()
  private var cancelled: Set<String> = []

  public init() {}

  public func cancel(_ token: String) {
    lock.lock()
    cancelled.insert(token)
    lock.unlock()
  }

  public func isCancelled(_ token: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return cancelled.contains(token)
  }

  public func forget(_ token: String) {
    lock.lock()
    cancelled.remove(token)
    lock.unlock()
  }
}
