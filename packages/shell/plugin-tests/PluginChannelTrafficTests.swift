import Darwin
import XCTest

@testable import ArdiaPluginChannel

final class PluginChannelTrafficTests: XCTestCase {
  static let lineLimit = 8 << 20
  static let readChunk = 4 << 20

  final class Rig {
    let app = DispatchQueue(label: "app")
    let helper = DispatchQueue(label: "helper")
    var connection: ControlConnection!
    var channel: HostChannel!
    let lock = NSLock()
    var requests: [Int] = []
    var replies: [Int] = []
    var retired: ControlConnection.RetireReason?
    var helperClosed = false

    init(paced: Bool, answer: @escaping (Rig, Int) -> Void) {
      var fds: [Int32] = [0, 0]
      precondition(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0)
      var noSigPipe: Int32 = 1
      setsockopt(fds[0], SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
      _ = fcntl(fds[0], F_SETFL, fcntl(fds[0], F_GETFL) | O_NONBLOCK)
      connection = ControlConnection(
        id: 1, fd: fds[0], queue: app,
        onLine: { [unowned self] _, line in
          let id = Self.id(of: line)
          self.lock.withLock { self.requests.append(id) }
          answer(self, id)
        },
        onClose: { _ in }, onWritten: { _ in }, lineLimit: PluginChannelTrafficTests.lineLimit, paced: paced,
        onRetire: { [unowned self] _, reason in self.lock.withLock { self.retired = reason } })
      channel = HostChannel(
        fd: fds[1], queue: helper,
        onLine: { [unowned self] line in
          let id = Self.id(of: line)
          self.lock.withLock { self.replies.append(id) }
        },
        onClose: { [unowned self] in self.lock.withLock { self.helperClosed = true } })
      app.sync { connection.open() }
      helper.sync { channel.open() }
    }

    static func id(of line: String) -> Int {
      guard let colon = line.firstIndex(of: ":") else { return -1 }
      let digits = line[line.index(after: colon)...].prefix { $0.isNumber }
      return Int(digits) ?? -1
    }

    static func readReply(_ id: Int) -> Data {
      var line = Data("{\"id\":\(id),\"result\":{\"found\":true,\"data\":\"".utf8)
      line.append(Data(repeating: UInt8(ascii: "A"), count: (PluginChannelTrafficTests.readChunk / 3) * 4))
      line.append(Data("\",\"size\":1,\"mtimeMs\":0}}\n".utf8))
      return line
    }

    func reply(_ id: Int) { connection.reply(Self.readReply(id), ticket: 0) }

    func sendRequests(_ count: Int) {
      helper.sync {
        for id in 1...count { _ = channel.send("{\"id\":\(id),\"method\":\"files.read\",\"params\":{\"path\":\"export.zip\",\"length\":\(PluginChannelTrafficTests.readChunk)}}") }
      }
    }

    var snapshot: (requests: Int, replies: Int, retired: ControlConnection.RetireReason?, helperClosed: Bool) {
      lock.withLock { (requests.count, replies.count, retired, helperClosed) }
    }

    func wait(seconds: TimeInterval, until done: () -> Bool) -> Bool {
      let end = Date().addingTimeInterval(seconds)
      while Date() < end {
        if done() { return true }
        usleep(5000)
      }
      return done()
    }

    func shutDown() {
      app.sync { connection.close() }
      helper.sync { channel.close() }
    }
  }

  func busyHelper(_ rig: Rig, for seconds: TimeInterval) -> DispatchSemaphore {
    let release = DispatchSemaphore(value: 0)
    rig.helper.async { _ = release.wait(timeout: .now() + seconds) }
    return release
  }

  func testReadRepliesQueuedBehindABusyHelperUsedToRetireTheChannel() {
    let rig = Rig(paced: false) { rig, id in rig.reply(id) }
    rig.sendRequests(14)
    let release = busyHelper(rig, for: 10)
    XCTAssertTrue(rig.wait(seconds: 10) { rig.snapshot.requests == 14 || rig.snapshot.retired != nil })
    release.signal()
    XCTAssertTrue(rig.wait(seconds: 10) { rig.snapshot.helperClosed })
    let seen = rig.snapshot
    XCTAssertEqual(seen.retired, .replyBacklog, "14 unread 4 MiB read replies are past the 34 MiB queue, so the app closed the channel")
    XCTAssertLessThan(seen.replies, 14)
    rig.shutDown()
  }

  func testMoreRequestsThanTheAppTakesAtOnceUsedToRetireTheChannel() {
    let rig = Rig(paced: false) { _, _ in }
    rig.sendRequests(40)
    XCTAssertTrue(rig.wait(seconds: 10) { rig.snapshot.helperClosed })
    XCTAssertEqual(rig.snapshot.retired, .tooManyRequests)
    rig.shutDown()
  }

  func testAPacedChannelCarriesFourteenReadRepliesPastABusyHelper() {
    let rig = Rig(paced: true) { rig, id in rig.reply(id) }
    rig.sendRequests(14)
    let release = busyHelper(rig, for: 10)
    XCTAssertTrue(rig.wait(seconds: 10) { rig.snapshot.requests >= 4 })
    usleep(300_000)
    let held = rig.app.sync { rig.connection.queuedBytes }
    XCTAssertLessThanOrEqual(held, ControlConnection.ceiling(lineLimit: Self.lineLimit, paced: true))
    XCTAssertLessThan(rig.snapshot.requests, 14, "the app stopped taking requests while replies waited")
    release.signal()
    XCTAssertTrue(rig.wait(seconds: 20) { rig.snapshot.replies == 14 })
    let seen = rig.snapshot
    XCTAssertNil(seen.retired)
    XCTAssertFalse(seen.helperClosed)
    XCTAssertEqual(rig.lock.withLock { rig.replies }, Array(1...14), "every reply arrives once, in order")
    rig.shutDown()
  }

  func testAPacedChannelHoldsRequestsPastThePendingLimitInsteadOfRetiring() {
    var held: [Int] = []
    let rig = Rig(paced: true) { _, id in held.append(id) }
    rig.sendRequests(40)
    XCTAssertTrue(rig.wait(seconds: 10) { rig.snapshot.requests == ControlConnection.maxPendingRequests })
    usleep(200_000)
    XCTAssertEqual(rig.snapshot.requests, ControlConnection.maxPendingRequests)
    XCTAssertTrue(rig.app.sync { rig.connection.paused })
    for _ in 0..<40 {
      rig.app.sync {
        guard !held.isEmpty else { return }
        let id = held.removeFirst()
        rig.connection.reply(Data("{\"id\":\(id),\"result\":{}}\n".utf8), ticket: 0)
      }
      _ = rig.wait(seconds: 2) { rig.app.sync { !held.isEmpty } || rig.snapshot.replies == 40 }
    }
    XCTAssertTrue(rig.wait(seconds: 10) { rig.snapshot.replies == 40 })
    XCTAssertNil(rig.snapshot.retired)
    XCTAssertFalse(rig.snapshot.helperClosed)
    rig.shutDown()
  }

  func testAPacedChannelStillRetiresALineOverTheLimitAndSaysWhy() {
    let rig = Rig(paced: true) { _, _ in }
    var fds: [Int32] = [0, 0]
    precondition(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0)
    _ = fcntl(fds[0], F_SETFL, fcntl(fds[0], F_GETFL) | O_NONBLOCK)
    var reason: ControlConnection.RetireReason?
    let queue = DispatchQueue(label: "long")
    let connection = ControlConnection(
      id: 2, fd: fds[0], queue: queue, onLine: { _, _ in }, onClose: { _ in }, onWritten: { _ in }, lineLimit: 1024, paced: true,
      onRetire: { _, r in reason = r })
    queue.sync { connection.open() }
    let line = [UInt8](repeating: UInt8(ascii: "x"), count: 4096) + [10]
    _ = line.withUnsafeBytes { write(fds[1], $0.baseAddress, $0.count) }
    XCTAssertTrue(rig.wait(seconds: 5) { queue.sync { connection.closed } })
    XCTAssertEqual(queue.sync { reason }, .lineTooLong)
    XCTAssertEqual(queue.sync { connection.retiredBecause }, .lineTooLong)
    close(fds[1])
    rig.shutDown()
  }

  func testEachQueueKeepsItsOwnRetiringList() {
    let pluginQueue = DispatchQueue(label: "plugins")
    let socketQueue = DispatchQueue(label: "control")
    XCTAssertTrue(ControlRetirements.of(pluginQueue) === ControlRetirements.of(pluginQueue))
    XCTAssertFalse(ControlRetirements.of(pluginQueue) === ControlRetirements.of(socketQueue))
    var fds: [Int32] = []
    func connection(_ id: Int, on queue: DispatchQueue) -> ControlConnection {
      var pair: [Int32] = [0, 0]
      precondition(socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0)
      fds += pair
      return ControlConnection(id: id, fd: pair[0], queue: queue, onLine: { _, _ in }, onClose: { _ in }, onWritten: { _ in })
    }
    let theirs = connection(0, on: socketQueue)
    socketQueue.sync { theirs.retiring.add(theirs, keepingAtMost: ControlConnection.maxRetiring) }
    let mine = (1...ControlConnection.maxRetiring + 1).map { connection($0, on: pluginQueue) }
    pluginQueue.sync { for c in mine { c.retiring.add(c, keepingAtMost: ControlConnection.maxRetiring) } }
    XCTAssertTrue(pluginQueue.sync { mine[0].closed }, "the plugin queue's oldest made room")
    XCTAssertFalse(socketQueue.sync { theirs.closed }, "the control socket's connection isn't touched by the plugin queue's list")
    XCTAssertTrue(ControlRetirements.of(socketQueue).holds(theirs))
    XCTAssertFalse(ControlRetirements.of(pluginQueue).holds(theirs))
    socketQueue.sync { theirs.close() }
    pluginQueue.sync { mine.forEach { $0.close() } }
    XCTAssertFalse(ControlRetirements.of(socketQueue).holds(theirs))
    fds.forEach { close($0) }
  }

  func testAResultLineGoesOutBetweenCompleteLinesAheadOfQueuedBulkWrites() {
    var pair: [Int32] = [0, 0]
    precondition(socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0)
    let queue = DispatchQueue(label: "host-urgent")
    let channel = HostChannel(fd: pair[0], queue: queue, onLine: { _ in }, onClose: {})
    queue.sync { channel.open() }
    let big = String(repeating: "b", count: 1 << 20)
    queue.sync {
      for i in 0..<6 { XCTAssertNil(channel.send("{\"id\":\(i),\"method\":\"files.write\",\"data\":\"\(big)\"}")) }
      XCTAssertNil(channel.send("{\"id\":99,\"method\":\"result\"}", urgent: true))
    }
    let order = queue.sync { channel.queuedOrder }
    XCTAssertGreaterThan(order.count, 2, "the bulk writes are backed up behind a full socket")
    XCTAssertEqual(order.dropFirst().first, "{\"id\":99,\"method\":\"result\"}", "the result is next after the line being written, ahead of every queued write")
    XCTAssertTrue(order.first?.hasSuffix("\"}") == true, "the line in progress finishes before the result")
    queue.sync { channel.close() }
    close(pair[0])
    close(pair[1])
  }
}
