import Foundation

final class CategoryLedger {
  private let lock = NSRecursiveLock()
  private var writes = 0

  var mark: Int {
    lock.lock()
    defer { lock.unlock() }
    return writes
  }

  func write(_ apply: () -> Void) {
    lock.lock()
    defer { lock.unlock() }
    writes += 1
    apply()
  }

  @discardableResult
  func writeUnlessWritten(since mark: Int, _ apply: () -> Void) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard writes == mark else { return false }
    apply()
    return true
  }

  static func merged<Category>(_ given: [Category], keeping own: [Category], id: (Category) -> String) -> [Category] {
    let taken = Set(given.map(id))
    return given + own.filter { !taken.contains(id($0)) }
  }
}
