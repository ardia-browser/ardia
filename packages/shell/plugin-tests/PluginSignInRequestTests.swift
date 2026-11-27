import Darwin
import XCTest

@testable import ArdiaPluginCore

final class PluginSignInRequestTests: XCTestCase {
  private let state = "s7Hq2_xK-9pLm3Rt"
  private lazy var loopback = PluginSignInExpectation.forCallback(host: "127.0.0.1", port: 53682, path: "/cb", state: state)!

  private func request(_ target: String, method: String = "GET", host: String = "127.0.0.1:53682", extra: [String] = ["Sec-Fetch-Mode: navigate", "Sec-Fetch-Dest: document"]) -> Data {
    Data((["\(method) \(target) HTTP/1.1", "Host: \(host)"] + extra + ["", ""]).joined(separator: "\r\n").utf8)
  }

  func testCatchesOnlyTheCallbackWithTheSessionsState() {
    XCTAssertEqual(PluginSignInRequest.verdict(request("/cb?code=x&state=\(state)"), expecting: loopback), .caught("/cb?code=x&state=\(state)"))
    XCTAssertEqual(PluginSignInRequest.verdict(request("/cb?state=\(state)&error=access_denied", extra: []), expecting: loopback), .caught("/cb?state=\(state)&error=access_denied"))
    XCTAssertEqual(PluginSignInRequest.verdict(request("/cb?code=x"), expecting: loopback), .refused(403))
    XCTAssertEqual(PluginSignInRequest.verdict(request("/cb"), expecting: loopback), .refused(403))
    XCTAssertEqual(PluginSignInRequest.verdict(request("/cb?code=x&state=s7Hq2_xK-9pLm3Ru"), expecting: loopback), .refused(403))
    XCTAssertEqual(PluginSignInRequest.verdict(request("/cb?code=x&state=\(state)x"), expecting: loopback), .refused(403))
    XCTAssertEqual(PluginSignInRequest.verdict(request("/cb?state=\(state)&state=\(state)"), expecting: loopback), .refused(403))
    XCTAssertEqual(PluginSignInRequest.verdict(request("/cb?xstate=\(state)"), expecting: loopback), .refused(403))
    XCTAssertEqual(PluginSignInRequest.verdict(request("/cb?st%61te=evil&state=\(state)"), expecting: loopback), .refused(403))
    XCTAssertEqual(PluginSignInRequest.verdict(request("/cb?state=\(state)&%73tate=evil"), expecting: loopback), .refused(403))
    XCTAssertEqual(PluginSignInRequest.verdict(request("/cb?st%ZZte=x&state=\(state)"), expecting: loopback), .refused(403))
    XCTAssertEqual(PluginSignInRequest.verdict(request("/cb?%73tate=\(state)"), expecting: loopback), .caught("/cb?%73tate=\(state)"))
  }

  func testWaitsForTheWholeHead() {
    XCTAssertEqual(PluginSignInRequest.verdict(Data("GET /cb?code=x HTTP/1.1\r\nHost: 127".utf8), expecting: loopback), .incomplete)
    XCTAssertEqual(PluginSignInRequest.verdict(Data(), expecting: loopback), .incomplete)
  }

  func testRefusesEverythingElse() {
    let s = "state=\(state)"
    XCTAssertEqual(PluginSignInRequest.verdict(request("/other?\(s)"), expecting: loopback), .refused(404))
    XCTAssertEqual(PluginSignInRequest.verdict(request("/cb/?\(s)"), expecting: loopback), .refused(404))
    XCTAssertEqual(PluginSignInRequest.verdict(request("/%63b?\(s)"), expecting: loopback), .refused(404))
    XCTAssertEqual(PluginSignInRequest.verdict(request("/cb?\(s)", method: "POST"), expecting: loopback), .refused(405))
    XCTAssertEqual(PluginSignInRequest.verdict(request("/cb?\(s)", host: "evil.example:53682"), expecting: loopback), .refused(421))
    XCTAssertEqual(PluginSignInRequest.verdict(request("/cb?\(s)", host: "localhost:53682"), expecting: loopback), .refused(421))
    XCTAssertEqual(PluginSignInRequest.verdict(request("/cb?\(s)", extra: ["Sec-Fetch-Mode: no-cors", "Sec-Fetch-Dest: empty"]), expecting: loopback), .refused(403))
    XCTAssertEqual(PluginSignInRequest.verdict(request("/cb?\(s)", extra: ["Host: evil.example"]), expecting: loopback), .refused(400))
    XCTAssertEqual(PluginSignInRequest.verdict(request("/cb?\(s)#frag"), expecting: loopback), .refused(400))
    XCTAssertEqual(PluginSignInRequest.verdict(Data("GET /cb?\(s) HTTP/1.1\r\nHost: 127.0.0.1:53682\r\nX: \u{1}\r\n\r\n".utf8), expecting: loopback), .refused(400))
    XCTAssertEqual(PluginSignInRequest.verdict(request("/cb?" + String(repeating: "a", count: 9000)), expecting: loopback), .refused(414))
    XCTAssertEqual(PluginSignInRequest.verdict(Data(String(repeating: "a", count: PluginSignInRequest.maxHead + 1).utf8), expecting: loopback), .refused(431))
  }

  func testPathsAndStatesAreTheNarrowForms() {
    for good in ["/", "/cb", "/oauth/callback", "/a.b/c~d_e-f"] { XCTAssertTrue(PluginSignInExpectation.isPath(good), good) }
    for bad in ["", "cb", "/cb/", "//cb", "/./cb", "/../cb", "/a/..", "/%2e%2e/cb", "/c%62", "/c b", "/c?b", "/caf\u{e9}"] { XCTAssertFalse(PluginSignInExpectation.isPath(bad), bad) }
    XCTAssertTrue(PluginSignInExpectation.isState(state))
    for bad in ["short", String(repeating: "a", count: 257), "s7Hq2_xK-9pLm3R.", "s7Hq2_xK 9pLm3Rt"] { XCTAssertFalse(PluginSignInExpectation.isState(bad), bad) }
    XCTAssertNil(PluginSignInExpectation.forCallback(host: "0.0.0.0", port: 8080, path: "/cb", state: state))
    XCTAssertNil(PluginSignInExpectation.forCallback(host: "127.0.0.1", port: 80, path: "/cb", state: state))
    XCTAssertEqual(PluginSignInExpectation.forCallback(host: "localhost", port: 8080, path: "/cb", state: state)?.hosts, ["localhost:8080"])
  }

  func testAnswersNoContentSoTheTabNeverLeavesItsPage() {
    XCTAssertTrue(String(decoding: PluginSignInRequest.response(.caught("/cb")), as: UTF8.self).hasPrefix("HTTP/1.1 204 No Content\r\n"))
    XCTAssertTrue(String(decoding: PluginSignInRequest.response(.refused(403)), as: UTF8.self).hasPrefix("HTTP/1.1 403 Forbidden\r\n"))
  }
}

final class PluginSignInListenerTests: XCTestCase {
  private let state = "Zq81_mNw-4Lp0aXc"

  private func freePort() -> Int {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    defer { close(fd) }
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_addr = in_addr(s_addr: in_addr_t(0x7F00_0001).bigEndian)
    _ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) } }
    return Int(UInt16(bigEndian: addr.sin_port))
  }

  private func get(_ port: Int, _ target: String, host: String? = nil) -> String {
    let url = URL(string: "http://127.0.0.1:\(port)\(target)")!
    var request = URLRequest(url: url, timeoutInterval: 5)
    if let host { request.setValue(host, forHTTPHeaderField: "Host") }
    let done = expectation(description: target)
    var status = "none"
    URLSession(configuration: .ephemeral).dataTask(with: request) { _, response, error in
      status = (response as? HTTPURLResponse).map { "\($0.statusCode)" } ?? "error \(error.map { ($0 as NSError).code } ?? 0)"
      done.fulfill()
    }.resume()
    wait(for: [done], timeout: 8)
    return status
  }

  private func listen(_ listener: PluginSignInListener, _ id: String, _ host: String, _ port: Int, deadlineMs: Int = 60_000) -> PluginSignInBind {
    let done = expectation(description: "bind \(id)")
    var bound = PluginSignInBind.failed("no answer")
    listener.listen(id: id, host: host, port: port, path: "/cb", state: state, deadlineMs: deadlineMs) {
      bound = $0
      done.fulfill()
    }
    wait(for: [done], timeout: 5)
    return bound
  }

  func testAForgedCallbackKeepsListeningThenTheRealOneIsCaught() {
    let port = freePort()
    var caught: [(String, String)] = []
    let listener = PluginSignInListener { caught.append(($0, $1)) }
    XCTAssertEqual(listen(listener, "s1", "127.0.0.1", port), .listening)
    XCTAssertEqual(get(port, "/cb?code=forged"), "403")
    XCTAssertEqual(get(port, "/cb?code=forged&state=Zq81_mNw-4Lp0aXd"), "403")
    XCTAssertEqual(get(port, "/elsewhere?state=\(state)"), "404")
    XCTAssertEqual(listener.sessionCount, 1, "still listening")
    XCTAssertEqual(get(port, "/cb?code=real&state=\(state)"), "204")
    XCTAssertEqual(listener.queue.sync { caught.map { "\($0.0) \($0.1)" } }, ["s1 /cb?code=real&state=\(state)"])
    XCTAssertEqual(listener.sessionCount, 0)
    XCTAssertTrue(get(port, "/cb?code=late&state=\(state)").hasPrefix("error"), "the port is closed once caught")
    XCTAssertEqual(listen(listener, "s2", "127.0.0.1", port), .listening, "the same port binds again right after")
    listener.stopAll()
  }

  func testATakenPortIsPortInUseForAnotherProgramAndForAnotherSession() {
    let port = freePort()
    let listener = PluginSignInListener { _, _ in }
    XCTAssertEqual(listen(listener, "a", "127.0.0.1", port), .listening)
    guard case .portInUse = listen(listener, "b", "127.0.0.1", port) else { return XCTFail("a second session on the same endpoint") }
    guard case .portInUse = listen(listener, "c", "localhost", port) else { return XCTFail("localhost overlaps 127.0.0.1") }
    XCTAssertEqual(listener.sessionCount, 1)
    listener.stopAll()
    XCTAssertEqual(listener.sessionCount, 0)
    XCTAssertEqual(listen(listener, "d", "localhost", port), .listening, "stopAll frees the port")
    listener.stopAll()
  }

  func testAProgramListeningOnTheWildcardAddressIsPortInUse() {
    let port = freePort()
    let other = socket(AF_INET, SOCK_STREAM, 0)
    defer { close(other) }
    var on: Int32 = 1
    setsockopt(other, SOL_SOCKET, SO_REUSEADDR, &on, socklen_t(MemoryLayout<Int32>.size))
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = in_port_t(UInt16(port).bigEndian)
    addr.sin_addr = in_addr(s_addr: INADDR_ANY)
    XCTAssertEqual(withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(other, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }, 0)
    XCTAssertEqual(Darwin.listen(other, 4), 0)
    let listener = PluginSignInListener { _, _ in }
    guard case .portInUse = listen(listener, "w", "127.0.0.1", port) else { return XCTFail("a wildcard listener holds the port") }
    XCTAssertEqual(listener.sessionCount, 0)
  }

  private func rawConnect(_ port: Int) -> Int32 {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    var on: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    var wait = timeval(tv_sec: 2, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &wait, socklen_t(MemoryLayout<timeval>.size))
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = in_port_t(UInt16(port).bigEndian)
    addr.sin_addr = in_addr(s_addr: in_addr_t(0x7F00_0001).bigEndian)
    XCTAssertEqual(withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }, 0)
    return fd
  }

  private func readAll(_ fd: Int32) -> (text: String, eof: Bool) {
    var buffer = [UInt8](repeating: 0, count: 1024)
    var text = ""
    while true {
      let n = Darwin.read(fd, &buffer, buffer.count)
      if n == 0 { return (text, true) }
      if n < 0 { return (text, false) }
      text += String(decoding: buffer[0..<n], as: UTF8.self)
    }
  }

  func testABurstOfIdleClientsIsCappedAndTheRealOneStillGetsThroughOnceTheyGo() {
    let port = freePort()
    var caught = 0
    let listener = PluginSignInListener { _, _ in caught += 1 }
    XCTAssertEqual(listen(listener, "b", "127.0.0.1", port), .listening)
    let idle = (0..<PluginSignInListener.maxConnections).map { _ in rawConnect(port) }
    let extra = rawConnect(port)
    XCTAssertEqual(readAll(extra).eof, true, "past the cap a connection is closed at once")
    close(extra)
    for fd in idle { close(fd) }
    let real = expectation(description: "drained")
    listener.queue.asyncAfter(deadline: .now() + 0.3) { real.fulfill() }
    wait(for: [real], timeout: 2)
    XCTAssertEqual(get(port, "/cb?code=x&state=\(state)"), "204")
    XCTAssertEqual(listener.queue.sync { caught }, 1)
    listener.stopAll()
  }

  func testStopAllClosesAnsweredSocketsAtOnce() {
    let port = freePort()
    let listener = PluginSignInListener { _, _ in }
    XCTAssertEqual(listen(listener, "d", "127.0.0.1", port), .listening)
    let fds = (0..<3).map { _ in rawConnect(port) }
    for fd in fds {
      let head = "GET /cb?code=forged HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\n\r\n"
      _ = head.withCString { Darwin.write(fd, $0, strlen($0)) }
    }
    let answered = expectation(description: "answered")
    listener.queue.asyncAfter(deadline: .now() + 0.2) { answered.fulfill() }
    wait(for: [answered], timeout: 2)
    XCTAssertEqual(listener.drainingCount, 3, "answered sockets wait for the client to close")
    let started = Date()
    listener.stopAll()
    XCTAssertEqual(listener.drainingCount, 0)
    for fd in fds {
      let got = readAll(fd)
      XCTAssertTrue(got.text.hasPrefix("HTTP/1.1 403"), got.text)
      XCTAssertTrue(got.eof)
      close(fd)
    }
    XCTAssertLessThan(Date().timeIntervalSince(started), PluginSignInListener.drainDeadline, "closed by stopAll, not by the drain deadline")
  }

  func testAStopQueuedBetweenTheBindsTwoHopsStopsIt() {
    let port = freePort()
    let listener = PluginSignInListener { _, _ in }
    let done = expectation(description: "bind answered")
    var bound = PluginSignInBind.listening
    listener.queue.suspend()
    listener.listen(id: "r", host: "127.0.0.1", port: port, path: "/cb", state: state, deadlineMs: 60_000) {
      bound = $0
      done.fulfill()
    }
    listener.stop("r")
    listener.queue.resume()
    wait(for: [done], timeout: 5)
    guard case .failed = bound else { return XCTFail("a bind stopped before it listened must not listen") }
    XCTAssertEqual(listener.sessionCount, 0)
    XCTAssertTrue(get(port, "/cb?state=\(state)").hasPrefix("error"), "nothing is listening")
  }

  func testStopAllRacingPendingBindsLeavesNothingListening() {
    let port = freePort()
    let listener = PluginSignInListener { _, _ in }
    for round in 0..<20 {
      let done = expectation(description: "bind \(round)")
      listener.listen(id: "p\(round)", host: "127.0.0.1", port: port, path: "/cb", state: state, deadlineMs: 60_000) { _ in done.fulfill() }
      listener.stopAll()
      wait(for: [done], timeout: 5)
      listener.queue.sync {}
      XCTAssertEqual(listener.sessionCount, 0, "round \(round)")
    }
    XCTAssertTrue(get(port, "/cb?state=\(state)").hasPrefix("error"), "nothing is listening")
  }

  func testAStopThenAListenOnTheSamePortSucceeds() {
    let port = freePort()
    let listener = PluginSignInListener { _, _ in }
    XCTAssertEqual(listen(listener, "x", "127.0.0.1", port), .listening)
    listener.stop("x")
    XCTAssertEqual(listen(listener, "y", "127.0.0.1", port), .listening)
    listener.stopAll()
  }

  func testTheNativeDeadlineEndsTheSessionByItself() {
    let port = freePort()
    let listener = PluginSignInListener { _, _ in }
    XCTAssertEqual(listen(listener, "t", "127.0.0.1", port, deadlineMs: 1000), .listening)
    let gone = expectation(description: "deadline")
    listener.queue.asyncAfter(deadline: .now() + 1.3) { gone.fulfill() }
    wait(for: [gone], timeout: 3)
    XCTAssertEqual(listener.sessionCount, 0)
  }
}
