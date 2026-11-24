import Foundation
import Testing
import os

private final class Written: Sendable {
  let log = OSAllocatedUnfairLock(initialState: [(String, Double, Bool)]())
  let gate = DispatchSemaphore(value: 0)
  let started = DispatchSemaphore(value: 0)
  let held = OSAllocatedUnfairLock(initialState: false)

  var entries: [(String, Double, Bool)] { log.withLock { $0 } }
}

private func snapshot(_ savedAt: Double) -> VaultCacheSnapshot {
  VaultCacheSnapshot(account: "sam@example.com", savedAt: savedAt, entries: [], passwords: [:], totps: nil)
}

@Suite("Vault cache writer")
struct VaultCacheWriterTests {
  @Test func `saves made while a write is running collapse into one write of the newest snapshot`() {
    let written = Written()
    let writer = VaultCacheWriter { id, snapshot, toCloud in
      if written.held.withLock({ $0 }) {
        written.started.signal()
        written.gate.wait()
      }
      written.log.withLock { $0.append((id, snapshot.savedAt, toCloud)) }
    }
    written.held.withLock { $0 = true }
    writer.save("1password", snapshot(1), toCloud: false)
    written.started.wait()
    writer.save("1password", snapshot(2), toCloud: true)
    writer.save("1password", snapshot(3), toCloud: false)
    written.held.withLock { $0 = false }
    written.gate.signal()
    writer.settle("1password")
    #expect(written.entries.map(\.1) == [1, 3])
    #expect(written.entries.last?.2 == true, "a pending cloud copy isn't lost when a newer snapshot replaces it")
  }

  @Test func `forgetting a store drops its pending write and waits for the running one, so a delete after it wins`() {
    let written = Written()
    let writer = VaultCacheWriter { id, snapshot, _ in
      if written.held.withLock({ $0 }) {
        written.started.signal()
        written.gate.wait()
      }
      written.log.withLock { $0.append((id, snapshot.savedAt, false)) }
    }
    written.held.withLock { $0 = true }
    writer.save("bitwarden", snapshot(1), toCloud: false)
    written.started.wait()
    writer.save("bitwarden", snapshot(2), toCloud: false)
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) {
      written.held.withLock { $0 = false }
      written.gate.signal()
    }
    writer.forget("bitwarden")
    #expect(written.entries.map(\.1) == [1])
    writer.settle("bitwarden")
    #expect(written.entries.map(\.1) == [1])
  }

  @Test func `each store writes on its own and settling one leaves the others queued in order`() {
    let written = Written()
    let writer = VaultCacheWriter { id, snapshot, _ in written.log.withLock { $0.append((id, snapshot.savedAt, false)) } }
    writer.save("a", snapshot(1), toCloud: false)
    writer.save("b", snapshot(2), toCloud: false)
    writer.settle("b")
    writer.settle("a")
    #expect(Set(written.entries.map(\.0)) == ["a", "b"])
  }
}
