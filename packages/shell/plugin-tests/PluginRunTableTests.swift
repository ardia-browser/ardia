import Darwin
import XCTest

@testable import ArdiaPluginCore

final class PluginRunTableTests: XCTestCase {
  final class Box {
    let label: String
    init(_ label: String) { self.label = label }
  }

  func testCancelThenReuseOfTheSameStreamIdLeavesTheReplacementAlone() {
    let table = PluginRunTable<Box>()
    guard case .admitted(let first) = table.admit("p", 1, "s", cap: 8, make: { _ in Box("first") }) else { return XCTFail("first stream refused") }
    XCTAssertEqual(table.take("p", 1, "s")?.value?.label, "first")
    guard case .admitted(let second) = table.admit("p", 1, "s", cap: 8, make: { _ in Box("second") }) else { return XCTFail("replacement refused") }
    XCTAssertNotEqual(first, second)
    XCTAssertFalse(table.remove("p", 1, "s", token: first), "the cancelled stream's late completion doesn't remove its replacement")
    XCTAssertNil(table.removeValue("p", 1, "s", token: first), "a late backpressure callback doesn't cancel the replacement")
    XCTAssertFalse(table.current("p", 1, "s", token: first))
    XCTAssertTrue(table.current("p", 1, "s", token: second))
    XCTAssertEqual(table.value("p", 1, "s")?.label, "second")
    XCTAssertTrue(table.remove("p", 1, "s", token: second))
    XCTAssertNil(table.value("p", 1, "s"))
  }

  func testAStreamThatFailsWhileStartingIsNotRegistered() {
    let table = PluginRunTable<Box>()
    let admission = table.admit("p", 1, "s", cap: 8) { token in
      table.remove("p", 1, "s", token: token)
      return Box("gone")
    }
    XCTAssertEqual(admission, .failed)
    XCTAssertNil(table.value("p", 1, "s"))
  }

  func testAClosedRunAdmitsNothingAndCapsHold() {
    let table = PluginRunTable<Box>()
    for i in 0..<2 { _ = table.admit("p", 1, "s\(i)", cap: 2, make: { _ in Box("\(i)") }) }
    XCTAssertEqual(table.admit("p", 1, "s9", cap: 2, make: { _ in Box("x") }), .full)
    XCTAssertEqual(table.admit("p", 1, "s0", cap: 8, make: { _ in Box("x") }), .taken)
    XCTAssertEqual(table.admit("p", 2, "s0", cap: 8, live: { false }, make: { _ in Box("x") }), .closed)
    XCTAssertEqual(table.closeRun("p", run: 1).count, 2)
    XCTAssertEqual(table.admit("p", 1, "s0", cap: 8, make: { _ in Box("late") }), .closed, "a stopped run can't open anything after teardown")
    XCTAssertEqual(table.count("p"), 0)
  }

  func testAnEventQueuedForACancelledStreamCantLandOnItsReplacement() {
    let table = PluginRunTable<Box>()
    guard case .admitted(let first) = table.admit("p", 1, "s", cap: 8, make: { _ in Box("first") }) else { return XCTFail("refused") }
    XCTAssertTrue(table.untaken("p", 1, "s", by: first))
    _ = table.take("p", 1, "s")
    XCTAssertTrue(table.untaken("p", 1, "s", by: first), "a free id takes the cancelled stream's last event")
    guard case .admitted = table.admit("p", 1, "s", cap: 8, make: { _ in Box("second") }) else { return XCTFail("refused") }
    XCTAssertFalse(table.current("p", 1, "s", token: first), "a chunk queued by the first stream is dropped at write time")
    XCTAssertFalse(table.untaken("p", 1, "s", by: first), "and so is its end or error")
  }

  func testAdmissionAndExitOnTheHostQueueNeverDeadlock() {
    let live = PluginLiveRuns()
    let table = PluginRunTable<Box>()
    let handles = PluginFileHandles()
    let host = DispatchQueue(label: "test.host")
    let path = FileManager.default.temporaryDirectory.appendingPathComponent("live-\(UUID().uuidString)").path
    FileManager.default.createFile(atPath: path, contents: Data(repeating: 1, count: 16))
    defer { unlink(path) }
    let work = DispatchGroup()
    for run in 1...200 {
      live.replace(with: [(name: "p", run: run)])
      for i in 0..<8 {
        DispatchQueue.global().async(group: work) {
          _ = table.admit("p", run, "s\(i)", cap: 8, live: { live.contains("p", run: run) }) { _ in Box("\(i)") }
          if case .success(let file) = PluginBoundedFile.openRegular(path) {
            _ = handles.addRead("p", run, fd: file.fd, size: file.size, live: { live.contains("p", run: run) })
          }
        }
      }
      host.async(group: work) {
        live.markClosed("p", run: run)
        _ = table.closeRun("p", run: run)
        handles.closeAll("p", run: run)
        _ = table.untaken("p", run, "s0", by: 0)
      }
    }
    XCTAssertEqual(work.wait(timeout: .now() + 20), .success, "admission and exit finish: nothing waits on the host queue while holding a table lock")
    for run in 1...200 { XCTAssertEqual(handles.count("p", run), 0) }
    XCTAssertEqual(table.count("p"), 0)
  }

  func testAStaleTerminalEventIsRefusedAfterItsIdWasReusedAndReleased() {
    let table = PluginRunTable<Box>()
    guard case .admitted(let first) = table.admit("p", 1, "s", cap: 8, make: { _ in Box("a") }) else { return XCTFail("refused") }
    _ = table.take("p", 1, "s")
    guard case .admitted(let second) = table.admit("p", 1, "s", cap: 8, make: { _ in Box("b") }) else { return XCTFail("refused") }
    XCTAssertTrue(table.remove("p", 1, "s", token: second))
    XCTAssertFalse(table.untaken("p", 1, "s", by: first), "A's queued end can't pass once B claimed and released the id")
    XCTAssertTrue(table.untaken("p", 1, "s", by: second), "B's own last event still goes")
  }

  func testAdmissionIsRefusedTheMomentARunIsRetiredOrItsChannelCloses() throws {
    let live = PluginLiveRuns()
    let table = PluginRunTable<Box>()
    let handles = PluginFileHandles()
    live.replace(with: [(name: "p", run: 4), (name: "q", run: 9)])
    XCTAssertEqual(table.admit("p", 4, "s", cap: 8, live: { live.contains("p", run: 4) }, make: { _ in Box("ok") }), .admitted(1))
    live.replace(with: [(name: "q", run: 9)])
    XCTAssertEqual(table.admit("p", 4, "t", cap: 8, live: { live.contains("p", run: 4) }, make: { _ in Box("late") }), .closed, "a removed plugin's run is out of the live set at once")
    live.markClosed("q", run: 9)
    XCTAssertEqual(table.admit("q", 9, "s", cap: 8, live: { live.contains("q", run: 9) }, make: { _ in Box("late") }), .closed, "and so is one whose control channel closed")
    let path = FileManager.default.temporaryDirectory.appendingPathComponent("closed-\(UUID().uuidString)").path
    FileManager.default.createFile(atPath: path, contents: Data([1]))
    defer { unlink(path) }
    guard case .success(let file) = PluginBoundedFile.openRegular(path) else { return XCTFail("couldn't open") }
    XCTAssertNil(handles.addRead("q", 9, fd: file.fd, size: file.size, live: { live.contains("q", run: 9) }))
    let host = try String(contentsOfFile: #filePath.replacingOccurrences(of: "plugin-tests/PluginRunTableTests.swift", with: "ios/PluginHost.swift"), encoding: .utf8)
    XCTAssertTrue(host.contains("onClose: { [weak self] process in"), "the host hears a closed control channel")
    XCTAssertTrue(host.contains("for process in retiring { live.markClosed(process.name, run: process.run) }"), "and remove retires its runs from the live set")
  }

  func testAFallingBehindSocketSaysSoBeforeClosing() {
    XCTAssertEqual(PluginWebSocketCodec.fellBehind.code, "backpressure")
    XCTAssertEqual(PluginWebSocketCodec.fellBehind.close, 1008)
    XCTAssertFalse(PluginWebSocketCodec.fellBehind.message.isEmpty)
    XCTAssertEqual(PluginWebSocketCodec.tooBig.close, 1009)
  }
}

final class PluginFileHandleTests: XCTestCase {
  private var folder: URL!

  override func setUpWithError() throws {
    folder = FileManager.default.temporaryDirectory.appendingPathComponent("plugin-files-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: folder)
  }

  private func file(_ name: String, bytes: Int, fill: UInt8 = 0x41) throws -> String {
    let url = folder.appendingPathComponent(name)
    try Data(repeating: fill, count: bytes).write(to: url)
    return url.path
  }

  private func isOpen(_ fd: Int32) -> Bool { fcntl(fd, F_GETFD) != -1 }

  func testCloseAllWaitsForAnInFlightReadBeforeClosingItsDescriptor() throws {
    let handles = PluginFileHandles()
    let path = try file("big.bin", bytes: 2 << 20)
    guard case .success(let opened) = PluginBoundedFile.openRegular(path), let id = handles.addRead("p", 1, fd: opened.fd, size: opened.size) else { return XCTFail("couldn't open") }
    let reads = DispatchGroup()
    var failures = 0
    let counting = NSLock()
    for i in 0..<64 {
      DispatchQueue.global().async(group: reads) {
        let answer = handles.readChunk("p", 1, id, offset: (i % 4) * 512 * 1024, length: 512 * 1024)
        if answer["ok"] as? Bool == true, let data = answer["data"] as? String, Data(base64Encoded: data)?.allSatisfy({ $0 == 0x41 }) == true { return }
        counting.lock()
        failures += 1
        counting.unlock()
      }
      if i == 32 { handles.closeAll("p", run: 1) }
    }
    reads.wait()
    XCTAssertGreaterThan(failures, 0, "reads after closeAll are refused")
    XCTAssertFalse(handles.isOpen("p", 1, id))
    XCTAssertFalse(isOpen(opened.fd), "the descriptor is closed once the last read ends")
    XCTAssertEqual(handles.readChunk("p", 1, id, offset: 0, length: 10)["ok"] as? Bool, false)
  }

  func testConcurrentSaveChunksEachLandAtTheirOwnOffset() throws {
    let handles = PluginFileHandles()
    let destination = folder.appendingPathComponent("saved.bin")
    let temporary = folder.appendingPathComponent(".saved.part").path
    let fd = Darwin.open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o644)
    XCTAssertGreaterThanOrEqual(fd, 0)
    guard let id = handles.addWrite("p", 1, fd: fd, temporary: temporary, destination: destination) else { return XCTFail("no handle") }
    let chunk = 4096
    let count = 128
    DispatchQueue.concurrentPerform(iterations: count) { i in
      let answer = handles.writeChunk("p", 1, id, data: Data(repeating: UInt8(i % 251), count: chunk))
      XCTAssertEqual(answer["ok"] as? Bool, true)
    }
    XCTAssertEqual(handles.finish("p", 1, id, commit: true)["saved"] as? Bool, true)
    let saved = try Data(contentsOf: destination)
    XCTAssertEqual(saved.count, chunk * count, "no chunk overwrote another")
    var blocks: [UInt8] = []
    for start in stride(from: 0, to: saved.count, by: chunk) {
      let block = saved[start..<(start + chunk)]
      XCTAssertTrue(block.allSatisfy { $0 == block.first }, "every reserved range holds exactly one chunk")
      blocks.append(block.first!)
    }
    XCTAssertEqual(blocks.sorted(), (0..<count).map { UInt8($0 % 251) }.sorted())
  }

  func testAFailedSaveChunkPoisonsTheFileSoNoHoleyFileIsCommitted() throws {
    let handles = PluginFileHandles()
    let destination = folder.appendingPathComponent("holey.bin")
    let temporary = folder.appendingPathComponent(".holey.part").path
    FileManager.default.createFile(atPath: temporary, contents: Data())
    let fd = Darwin.open(temporary, O_RDONLY | O_CLOEXEC)
    XCTAssertGreaterThanOrEqual(fd, 0)
    guard let id = handles.addWrite("p", 1, fd: fd, temporary: temporary, destination: destination) else { return XCTFail("no handle") }
    XCTAssertEqual(handles.writeChunk("p", 1, id, data: Data(repeating: 1, count: 16))["ok"] as? Bool, false, "the write fails on a read-only descriptor")
    let retry = handles.writeChunk("p", 1, id, data: Data(repeating: 2, count: 16))
    XCTAssertEqual(retry["ok"] as? Bool, false, "a later chunk is refused instead of writing past the hole")
    let finished = handles.finish("p", 1, id, commit: true)
    XCTAssertEqual(finished["ok"] as? Bool, false)
    XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path), "nothing is committed")
    XCTAssertFalse(FileManager.default.fileExists(atPath: temporary), "and the part file is removed")
  }

  func testADropSkipsARefusedCandidateAndKeepsTheValidOne() throws {
    let handles = PluginFileHandles()
    let big = try file("oversized.txt", bytes: 4096)
    let valid = try file("valid.png", bytes: 64)
    let result = PluginFileBatch.open([big, valid], maxBytes: 1024, skipRefused: true, textual: { _ in false }, mimeType: { $0.hasSuffix(".png") ? "image/png" : "text/plain" }) { fd, size in
      handles.addRead("p", 1, fd: fd, size: size)
    } discard: { handles.discard("p", 1, $0) }
    guard case .success(let opened) = result else { return XCTFail("the drop failed") }
    XCTAssertEqual(opened.files.map { $0["name"] as? String }, ["valid.png"])
    let strict = PluginFileBatch.open([big, valid], maxBytes: 1024, textual: { _ in false }, mimeType: { _ in "x" }) { fd, size in
      handles.addRead("p", 1, fd: fd, size: size)
    } discard: { handles.discard("p", 1, $0) }
    guard case .failure = strict else { return XCTFail("a picker batch still refuses") }
    let none = PluginFileBatch.open([big], maxBytes: 1024, skipRefused: true, textual: { _ in false }, mimeType: { _ in "x" }) { _, _ in nil } discard: { _ in }
    guard case .failure = none else { return XCTFail("a drop where nothing opens still says why") }
  }

  func testAStoppedRunCantRegisterAHandleAndTheDescriptorIsClosed() throws {
    let handles = PluginFileHandles()
    handles.closeAll("p", run: 3)
    let path = try file("late.bin", bytes: 1024)
    guard case .success(let opened) = PluginBoundedFile.openRegular(path) else { return XCTFail("couldn't open") }
    XCTAssertNil(handles.addRead("p", 3, fd: opened.fd, size: opened.size))
    XCTAssertFalse(isOpen(opened.fd))
    guard case .success(let other) = PluginBoundedFile.openRegular(path) else { return XCTFail("couldn't open") }
    XCTAssertNil(handles.addRead("p", 4, fd: other.fd, size: other.size, live: { false }), "a run the host no longer runs can't register either")
    XCTAssertFalse(isOpen(other.fd))
  }

  func testAFailedBatchClosesTheHandlesItAlreadyOpened() throws {
    let handles = PluginFileHandles()
    let big = try file("one.bin", bytes: 300 * 1024)
    let missing = folder.appendingPathComponent("missing.bin").path
    var fds: [Int32] = []
    let result = PluginFileBatch.open([big, missing], maxBytes: 64 << 20, textual: { _ in false }, mimeType: { _ in "application/octet-stream" }) { fd, size in
      fds.append(fd)
      return handles.addRead("p", 1, fd: fd, size: size)
    } discard: { handles.discard("p", 1, $0) }
    guard case .failure = result else { return XCTFail("a missing file fails the batch") }
    XCTAssertEqual(fds.count, 1)
    XCTAssertFalse(isOpen(fds[0]), "the first file's handle is closed when the batch fails")
    XCTAssertEqual(handles.count("p", 1), 0)
  }

  func testFourFilesJustUnderTheInlineLimitStayUnderTheChannelLine() throws {
    let handles = PluginFileHandles()
    let paths = try (0..<4).map { try file("f\($0).bin", bytes: 220 * 1024, fill: UInt8($0)) }
    let result = PluginFileBatch.open(paths, maxBytes: 64 << 20, textual: { _ in false }, mimeType: { _ in "application/octet-stream" }) { fd, size in
      handles.addRead("p", 1, fd: fd, size: size)
    } discard: { handles.discard("p", 1, $0) }
    guard case .success(let opened) = result else { return XCTFail("the batch failed") }
    let reply = try JSONSerialization.data(withJSONObject: ["ok": true, "files": opened.files])
    XCTAssertLessThan(reply.count, 768 * 1024, "the whole reply fits the 1 MB channel line with room to spare")
    XCTAssertEqual(opened.files.count, 4)
    XCTAssertGreaterThan(opened.handles.count, 0, "files past the batch budget come back as handles")
    XCTAssertEqual(opened.files.filter { ($0["handle"] as? String) != nil }.count, opened.handles.count)
    handles.discard("p", 1, opened.handles)
  }

  func testEscapedTextCountsAgainstTheBudgetAtItsEncodedSize() throws {
    let handles = PluginFileHandles()
    let quotes = folder.appendingPathComponent("quotes.txt")
    try Data(String(repeating: "\"", count: 200 * 1024).utf8).write(to: quotes)
    let paths = [quotes.path, quotes.path, quotes.path, quotes.path]
    let result = PluginFileBatch.open(paths, maxBytes: 64 << 20, textual: { _ in true }, mimeType: { _ in "text/plain" }) { fd, size in
      handles.addRead("p", 1, fd: fd, size: size)
    } discard: { handles.discard("p", 1, $0) }
    guard case .success(let opened) = result else { return XCTFail("the batch failed") }
    let reply = try JSONSerialization.data(withJSONObject: ["ok": true, "files": opened.files])
    XCTAssertLessThan(reply.count, 768 * 1024)
    handles.discard("p", 1, opened.handles)
  }
}

final class PluginPageStoresTests: XCTestCase {
  func testProfileStoresAreRememberedSoRemovingThePluginClearsEveryOne() throws {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("page-stores-\(UUID().uuidString)/page-stores.json")
    defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
    let stores = PluginPageStores(file: file)
    stores.record("notes", key: "profile-a")
    stores.record("notes", key: "profile-b")
    stores.record("notes", key: "profile-a")
    stores.record("notes", key: "../escape")
    XCTAssertEqual(stores.keys("notes"), ["profile-a", "profile-b"])
    XCTAssertEqual(PluginPageStores(file: file).keys("notes"), ["profile-a", "profile-b"], "the keys survive a relaunch")
    stores.forget("notes", key: "profile-a")
    XCTAssertEqual(PluginPageStores(file: file).keys("notes"), ["profile-b"], "only a key whose store was removed leaves the index")
    stores.forget("notes", key: "profile-b")
    XCTAssertEqual(PluginPageStores(file: file).keys("notes"), [])
    for i in 0..<70 { stores.record("many", key: "p\(i)") }
    XCTAssertEqual(stores.keys("many").count, 70, "no cap evicts an older profile's store from cleanup")
    XCTAssertEqual(stores.keys("many").first, "p0")
  }
}
