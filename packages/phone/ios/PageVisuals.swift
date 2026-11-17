import Foundation
import QuartzCore

final class PageVisuals: @unchecked Sendable {
  enum Change: String {
    case state = "changed state"
    case scrolled
    case resized
    case laidOut = "laid out"
  }

  private struct Record {
    var generation = 0
    var captured: Int?
    var capturedAt: CFTimeInterval = 0
    var reported = false
  }

  private var pages: [String: Record] = [:]
  private let lock = NSLock()
  private let clock: @Sendable () -> CFTimeInterval
  private let onNoLongerCurrent: (@Sendable (_ pageID: String, _ change: Change, _ millisecondsAfterCapture: Int) -> Void)?

  init(clock: @escaping @Sendable () -> CFTimeInterval = { CACurrentMediaTime() }, onNoLongerCurrent: (@Sendable (String, Change, Int) -> Void)? = nil) {
    self.clock = clock
    self.onNoLongerCurrent = onNoLongerCurrent
  }

  func changed(_ pageID: String, _ change: Change) {
    let lateness: Int? = lock.withLock {
      var record = pages[pageID] ?? Record()
      record.generation += 1
      var lateness: Int?
      if record.captured != nil, !record.reported {
        record.reported = true
        lateness = Int(((clock() - record.capturedAt) * 1000).rounded())
      }
      pages[pageID] = record
      return lateness
    }
    if let lateness { onNoLongerCurrent?(pageID, change, lateness) }
  }

  func generation(_ pageID: String) -> Int {
    lock.withLock { pages[pageID]?.generation ?? 0 }
  }

  func captured(_ pageID: String, generation: Int) {
    lock.withLock {
      var record = pages[pageID] ?? Record()
      record.captured = generation
      record.capturedAt = clock()
      record.reported = record.generation != generation
      pages[pageID] = record
    }
  }

  func isCurrent(_ pageID: String) -> Bool? {
    lock.withLock {
      guard let record = pages[pageID], let captured = record.captured else { return nil }
      return captured == record.generation
    }
  }

  func forget(_ pageID: String) {
    lock.withLock { pages[pageID] = nil }
  }
}
