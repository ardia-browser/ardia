import Foundation

final class FieldBlurLog {
  static let defaultCap = 32

  private struct Queue {
    var windowId: String
    var causes: [Bool] = []
    var overflow = 0
    var isLive: () -> Bool
  }

  let cap: Int
  private let lock = NSLock()
  private var watched: Set<Int> = []
  private var queues: [Int: Queue] = [:]

  init(cap: Int = FieldBlurLog.defaultCap) {
    self.cap = max(1, cap)
  }

  var pending: Int {
    lock.lock()
    defer { lock.unlock() }
    return queues.values.reduce(0) { $0 + $1.causes.count + $1.overflow }
  }

  var fields: Int {
    lock.lock()
    defer { lock.unlock() }
    return queues.count
  }

  var stored: Int {
    lock.lock()
    defer { lock.unlock() }
    return queues.values.reduce(0) { $0 + $1.causes.count }
  }

  func watch(field: Int) {
    lock.lock()
    defer { lock.unlock() }
    watched.insert(field)
  }

  func unwatch(field: Int) {
    lock.lock()
    defer { lock.unlock() }
    watched.remove(field)
    queues[field] = nil
  }

  func record(field: Int, windowId: String, keyLoss: Bool, isLive: @escaping () -> Bool) {
    lock.lock()
    defer { lock.unlock() }
    guard watched.contains(field) else { return }
    queues = queues.filter { $0.key == field || $0.value.isLive() }
    var queue = queues[field] ?? Queue(windowId: windowId, isLive: isLive)
    queue.windowId = windowId
    queue.isLive = isLive
    if queue.overflow > 0 || queue.causes.count >= cap {
      queue.causes = queue.causes.map { _ in false }
      queue.overflow += 1
    } else {
      queue.causes.append(keyLoss)
    }
    queues[field] = queue
  }

  func take(field: Int) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard var queue = queues[field] else { return false }
    let keyLoss: Bool
    if !queue.causes.isEmpty {
      keyLoss = queue.causes.removeFirst()
    } else {
      queue.overflow = max(0, queue.overflow - 1)
      keyLoss = false
    }
    queues[field] = queue.causes.isEmpty && queue.overflow == 0 ? nil : queue
    return keyLoss
  }

  func settle(where matches: (String) -> Bool) {
    lock.lock()
    defer { lock.unlock() }
    for (field, var queue) in queues where matches(queue.windowId) {
      queue.causes = queue.causes.map { _ in false }
      queues[field] = queue
    }
  }

  func forget(where matches: (String) -> Bool) {
    lock.lock()
    defer { lock.unlock() }
    queues = queues.filter { !matches($0.value.windowId) }
  }
}
