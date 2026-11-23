import Network
import XCTest

@testable import ArdiaPluginCore

final class DroppingServer {
  enum Mode {
    case dropsOnceThenResumes
    case dropsOnceWithoutRanges
    case dropsOnceThenRefusesRanges
    case dropsOnceThenStalls
  }

  let body: Data
  let mode: Mode
  private let listener: NWListener
  private let queue = DispatchQueue(label: "dropping-server")
  private let lock = NSLock()
  private var seen: [String] = []

  init(body: Data, mode: Mode) throws {
    self.body = body
    self.mode = mode
    listener = try NWListener(using: .tcp, on: .any)
    listener.newConnectionHandler = { [weak self] connection in self?.serve(connection) }
    let ready = DispatchSemaphore(value: 0)
    listener.stateUpdateHandler = { state in
      if case .ready = state { ready.signal() }
    }
    listener.start(queue: queue)
    _ = ready.wait(timeout: .now() + 5)
  }

  var url: URL { URL(string: "http://127.0.0.1:\(listener.port!.rawValue)/tool.tar.br")! }

  var requests: [String] {
    lock.lock()
    defer { lock.unlock() }
    return seen
  }

  func stop() { listener.cancel() }

  private func serve(_ connection: NWConnection) {
    connection.start(queue: queue)
    read(connection, Data())
  }

  private func read(_ connection: NWConnection, _ so: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, _ in
      guard let self else { return }
      var head = so
      if let data { head.append(data) }
      guard let end = head.range(of: Data("\r\n\r\n".utf8)) else {
        if done { connection.cancel() } else { self.read(connection, head) }
        return
      }
      self.answer(connection, String(decoding: head[..<end.lowerBound], as: UTF8.self))
    }
  }

  private func answer(_ connection: NWConnection, _ head: String) {
    let range = head.split(separator: "\r\n").first { $0.lowercased().hasPrefix("range:") }.map { String($0.split(separator: "=").last ?? "") }
    lock.lock()
    seen.append(range.map { "range \($0)" } ?? "full")
    let first = seen.count == 1
    lock.unlock()
    let validators = "ETag: \"tool-1\"\r\nLast-Modified: Mon, 23 Nov 2026 00:00:00 GMT\r\n"
    if first {
      let ranges = mode == .dropsOnceWithoutRanges ? "" : "Accept-Ranges: bytes\r\n\(validators)"
      let header = "HTTP/1.1 200 OK\r\nContent-Length: \(body.count)\r\nContent-Type: application/octet-stream\r\n\(ranges)\r\n"
      send(connection, Data(header.utf8) + body.prefix(body.count / 2), close: true)
      return
    }
    if let range, mode == .dropsOnceThenResumes, let from = Int(range.split(separator: "-").first ?? "") {
      let rest = body.dropFirst(from)
      let header = "HTTP/1.1 206 Partial Content\r\nContent-Length: \(rest.count)\r\nContent-Range: bytes \(from)-\(body.count - 1)/\(body.count)\r\nAccept-Ranges: bytes\r\n\(validators)Connection: close\r\n\r\n"
      send(connection, Data(header.utf8) + rest, close: true)
      return
    }
    if mode == .dropsOnceThenStalls { return }
    if range != nil, mode == .dropsOnceThenRefusesRanges {
      send(connection, Data("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8), close: true)
      return
    }
    let header = "HTTP/1.1 200 OK\r\nContent-Length: \(body.count)\r\nAccept-Ranges: bytes\r\n\(validators)Connection: close\r\n\r\n"
    send(connection, Data(header.utf8) + body, close: true)
  }

  private func send(_ connection: NWConnection, _ data: Data, close: Bool) {
    connection.send(content: data, completion: .contentProcessed { _ in
      if close { connection.cancel() }
    })
  }
}

final class OfficialDownloadTests: XCTestCase {
  var root = ""
  let body = Data((0..<(3 << 20)).map { UInt8(truncatingIfNeeded: $0 &* 2_654_435_761 >> 7) })

  override func setUpWithError() throws {
    let made = FileManager.default.temporaryDirectory.appendingPathComponent("official-download-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
    root = made.path
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(atPath: root)
  }

  func fetch(_ url: URL, deadline: TimeInterval = 60, waits: [TimeInterval] = [0.05, 0.05, 0.05], progress: @escaping (Int64, Int64) -> Void = { _, _ in }, isCancelled: @escaping () -> Bool = { false }) -> (Result<OfficialDownload.Fetched, OfficialDownload.Failure>, URL) {
    let download = OfficialDownload(idleTimeout: 10, deadline: 60) { _, received, total in progress(received, total) }
    let archive = URL(fileURLWithPath: "\(root)/\(UUID().uuidString).tar.br")
    let result = download.fetch("tool", from: url, to: archive, deadline: deadline, waits: waits, isCancelled: isCancelled, started: { _ in true })
    return (result, archive)
  }

  func testADroppedDownloadResumesWhereItStopped() throws {
    let server = try DroppingServer(body: body, mode: .dropsOnceThenResumes)
    defer { server.stop() }
    let lock = NSLock()
    var reports: [(Int64, Int64)] = []
    let (result, archive) = fetch(server.url) { received, total in
      lock.lock()
      reports.append((received, total))
      lock.unlock()
    }
    let fetched = try result.get()
    XCTAssertEqual(try Data(contentsOf: archive), body)
    XCTAssertEqual(fetched.resumes, 1)
    XCTAssertEqual(fetched.bytes, Int64(body.count))
    XCTAssertEqual(server.requests.count, 2)
    XCTAssertTrue(server.requests[1].hasPrefix("range "), "the second request asks only for what's missing: \(server.requests)")
    lock.lock()
    defer { lock.unlock() }
    XCTAssertTrue(reports.allSatisfy { $0.0 <= Int64(body.count) && $0.1 == Int64(body.count) }, "the total stays the whole size after resuming: \(reports)")
    XCTAssertEqual(reports.map(\.0), reports.map(\.0).sorted(), "progress never goes back when the download resumes: \(reports)")
    XCTAssertGreaterThan(reports.last?.0 ?? 0, Int64(body.count / 2))
  }

  func testAServerThatCannotResumeIsAskedForTheWholeFileAgain() throws {
    let server = try DroppingServer(body: body, mode: .dropsOnceWithoutRanges)
    defer { server.stop() }
    let (result, archive) = fetch(server.url)
    let fetched = try result.get()
    XCTAssertEqual(try Data(contentsOf: archive), body)
    XCTAssertEqual(fetched.resumes, 0)
    XCTAssertEqual(server.requests, ["full", "full"])
  }

  func testAResumeTheServerRefusesStartsOver() throws {
    let server = try DroppingServer(body: body, mode: .dropsOnceThenRefusesRanges)
    defer { server.stop() }
    let (result, archive) = fetch(server.url)
    _ = try result.get()
    XCTAssertEqual(try Data(contentsOf: archive), body)
    XCTAssertEqual(server.requests.count, 3)
    XCTAssertEqual(server.requests.last, "full")
  }

  func testNoConnectionAtAllFailsAtOnceWithoutRetrying() throws {
    let server = try DroppingServer(body: body, mode: .dropsOnceThenResumes)
    let url = server.url
    server.stop()
    Thread.sleep(forTimeInterval: 0.2)
    let started = Date()
    let (result, _) = fetch(url, waits: [5, 5, 5])
    guard case .failure(let failure) = result else { return XCTFail("a server that isn't there was downloaded from") }
    XCTAssertEqual(failure.code, "offline")
    XCTAssertLessThan(Date().timeIntervalSince(started), 4, "nothing was received, so it isn't a dropped download to resume")
  }

  func testCancellingWhileWaitingToResumeStops() throws {
    let server = try DroppingServer(body: body, mode: .dropsOnceThenResumes)
    defer { server.stop() }
    let lock = NSLock()
    var cancelled = false
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) {
      lock.lock()
      cancelled = true
      lock.unlock()
    }
    let started = Date()
    let (result, _) = fetch(server.url, waits: [10, 10, 10]) {
      lock.lock()
      defer { lock.unlock() }
      return cancelled
    }
    guard case .failure(let failure) = result else { return XCTFail("it kept going after it was cancelled") }
    XCTAssertEqual(failure.code, "cancelled")
    XCTAssertLessThan(Date().timeIntervalSince(started), 5)
    XCTAssertEqual(server.requests.count, 1)
  }

  func testOnlyADroppedDownloadIsResumed() {
    let offline = OfficialDownload.Failure(code: "offline", reason: "")
    XCTAssertTrue(OfficialDownload.shouldResume(offline, resumeData: Data([1]), received: 0))
    XCTAssertTrue(OfficialDownload.shouldResume(offline, resumeData: nil, received: 10))
    XCTAssertFalse(OfficialDownload.shouldResume(offline, resumeData: nil, received: 0))
    XCTAssertFalse(OfficialDownload.shouldResume(OfficialDownload.Failure(code: "failed", reason: ""), resumeData: Data([1]), received: 10))
    XCTAssertFalse(OfficialDownload.shouldResume(OfficialDownload.Failure(code: "verify", reason: ""), resumeData: Data([1]), received: 10))
  }

  func testOneDeadlineCoversEveryAttempt() throws {
    let server = try DroppingServer(body: body, mode: .dropsOnceThenStalls)
    defer { server.stop() }
    let started = Date()
    let (result, _) = fetch(server.url, deadline: 1)
    guard case .failure(let failure) = result else { return XCTFail("a download that stalled past its deadline finished") }
    XCTAssertEqual(failure.code, "offline")
    XCTAssertLessThan(Date().timeIntervalSince(started), 2.5, "the resumed attempt stops at the deadline the first one started")
    XCTAssertEqual(server.requests.count, 2)
  }
}
