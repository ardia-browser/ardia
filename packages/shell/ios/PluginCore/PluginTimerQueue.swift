import Foundation

struct PluginTimerQueue {
  static let maxTimers = 10_000

  private struct Slot {
    let due: UInt64
    let seq: UInt64
    let id: Double

    func comesBefore(_ other: Slot) -> Bool {
      due != other.due ? due < other.due : seq < other.seq
    }
  }

  private var heap: [Slot] = []
  private var live: [Double: UInt64] = [:]
  private var seq: UInt64 = 0

  var count: Int { live.count }
  var storedSlots: Int { heap.count }

  mutating func schedule(_ id: Double, due: UInt64) -> Bool {
    live.removeValue(forKey: id)
    guard live.count < Self.maxTimers else {
      compactIfStale()
      return false
    }
    seq += 1
    live[id] = seq
    push(Slot(due: due, seq: seq, id: id))
    compactIfStale()
    return true
  }

  @discardableResult
  mutating func cancel(_ id: Double) -> Bool {
    guard live.removeValue(forKey: id) != nil else { return false }
    compactIfStale()
    return true
  }

  mutating func nextDue() -> UInt64? {
    dropStaleTop()
    return heap.first?.due
  }

  mutating func popDue(now: UInt64) -> Double? {
    dropStaleTop()
    guard let top = heap.first, top.due <= now else { return nil }
    popTop()
    live.removeValue(forKey: top.id)
    return top.id
  }

  private func isLive(_ slot: Slot) -> Bool {
    live[slot.id] == slot.seq
  }

  private mutating func dropStaleTop() {
    while let top = heap.first, !isLive(top) { popTop() }
  }

  private mutating func compactIfStale() {
    guard heap.count > 2 * live.count + 64 else { return }
    let alive = live
    heap = heap.filter { alive[$0.id] == $0.seq }.sorted { $0.comesBefore($1) }
  }

  private mutating func push(_ slot: Slot) {
    heap.append(slot)
    var child = heap.count - 1
    while child > 0 {
      let parent = (child - 1) / 2
      guard heap[child].comesBefore(heap[parent]) else { break }
      heap.swapAt(child, parent)
      child = parent
    }
  }

  private mutating func popTop() {
    let last = heap.removeLast()
    guard !heap.isEmpty else { return }
    heap[0] = last
    var parent = 0
    while true {
      let left = 2 * parent + 1
      let right = left + 1
      var first = parent
      if left < heap.count && heap[left].comesBefore(heap[first]) { first = left }
      if right < heap.count && heap[right].comesBefore(heap[first]) { first = right }
      if first == parent { return }
      heap.swapAt(parent, first)
      parent = first
    }
  }
}
