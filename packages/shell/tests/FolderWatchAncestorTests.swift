import Foundation
import Testing
@testable import ArdiaUpdaterCore

@Suite(.timeLimit(.minutes(1)))
struct FolderWatchAncestorTests {
  let scratch: URL
  let queue = DispatchQueue(label: "folder-watch-ancestor-tests")

  init() throws {
    scratch = FileManager.default.temporaryDirectory.appendingPathComponent("folder-watch-ancestor-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
  }

  final class Changes: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func bump() { lock.withLock { count += 1 } }
    var value: Int { lock.withLock { count } }
  }

  func start(_ url: URL, _ changes: Changes) -> FolderWatch {
    let watch = FolderWatch(path: url.path, queue: queue, waitsForAbsentFolder: true) { changes.bump() }
    queue.sync { watch.start() }
    return watch
  }

  func eventually(_ condition: () -> Bool) async throws -> Bool {
    for _ in 0..<200 {
      if condition() { return true }
      try await Task.sleep(for: .milliseconds(10))
    }
    return condition()
  }

  func binding(_ watch: FolderWatch) -> FolderWatch.Binding { queue.sync { watch.binding } }

  @Test func `a folder missing at start is watched once it appears`() async throws {
    let downloads = scratch.appendingPathComponent("Downloads", isDirectory: true)
    let changes = Changes()
    let watch = start(downloads, changes)
    #expect(try await eventually { changes.value >= 1 })
    #expect(binding(watch) == .absent)
    #expect(queue.sync { watch.watchedAncestor } == scratch.standardizedFileURL.path)
    try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
    #expect(try await eventually { binding(watch) == .watching })
    let seen = changes.value
    try Data().write(to: downloads.appendingPathComponent("photo.png"))
    #expect(try await eventually { changes.value > seen })
    queue.sync { watch.stop() }
  }

  @Test func `a deleted folder is watched again when it is recreated`() async throws {
    let downloads = scratch.appendingPathComponent("Downloads", isDirectory: true)
    try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
    let changes = Changes()
    let watch = start(downloads, changes)
    #expect(try await eventually { binding(watch) == .watching && changes.value >= 1 })
    try FileManager.default.removeItem(at: downloads)
    #expect(try await eventually { binding(watch) == .absent })
    try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
    #expect(try await eventually { binding(watch) == .watching })
    let seen = changes.value
    try Data().write(to: downloads.appendingPathComponent("clip.mov"))
    #expect(try await eventually { changes.value > seen })
    queue.sync { watch.stop() }
  }

  @Test func `a folder two levels down waits on the nearest folder that exists`() async throws {
    let volume = scratch.appendingPathComponent("Volume", isDirectory: true)
    let inbox = volume.appendingPathComponent("Inbox", isDirectory: true)
    let changes = Changes()
    let watch = start(inbox, changes)
    #expect(try await eventually { queue.sync { watch.watchedAncestor } == scratch.standardizedFileURL.path })
    try FileManager.default.createDirectory(at: volume, withIntermediateDirectories: true)
    #expect(try await eventually { queue.sync { watch.watchedAncestor } == volume.standardizedFileURL.path })
    try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
    #expect(try await eventually { binding(watch) == .watching })
    #expect(queue.sync { watch.watchedAncestor } == nil)
    queue.sync { watch.stop() }
  }

  @Test func `activity beside a missing folder reports nothing`() async throws {
    let downloads = scratch.appendingPathComponent("Downloads", isDirectory: true)
    let changes = Changes()
    let watch = start(downloads, changes)
    #expect(try await eventually { changes.value >= 1 })
    let seen = changes.value
    try Data().write(to: scratch.appendingPathComponent("notes.txt"))
    try FileManager.default.createDirectory(at: scratch.appendingPathComponent("Other"), withIntermediateDirectories: true)
    try await Task.sleep(for: .milliseconds(300))
    #expect(changes.value == seen)
    #expect(binding(watch) == .absent)
    queue.sync { watch.stop() }
  }

  @Test func `a plain watch still reports absence without waiting`() async throws {
    let changes = Changes()
    let watch = FolderWatch(path: scratch.appendingPathComponent("Gone").path, queue: queue) { changes.bump() }
    queue.sync { watch.start() }
    #expect(try await eventually { changes.value >= 1 })
    #expect(queue.sync { watch.watchedAncestor } == nil)
  }
}
