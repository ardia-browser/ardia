import XCTest

@testable import ArdiaPluginCore

final class PluginConnectAttemptsTests: XCTestCase {
  func url(_ text: String) -> URL { URL(string: text)! }

  func testEveryResolvedAddressIsVettedAndKeptInterleavedByFamily() {
    let resolved = ["2606:2800:220:1::", "2606:2800:220:1::2", "93.184.216.34", "93.184.216.35", "2606:2800:220:1::"]
    XCTAssertEqual(
      try? PluginFetchPolicy.vettedAddresses(for: url("https://a.example.com/"), resolved: resolved, allowLoopback: false).get(),
      ["2606:2800:220:1::", "93.184.216.34", "2606:2800:220:1::2", "93.184.216.35"])
    XCTAssertEqual(
      try? PluginFetchPolicy.vettedAddresses(for: url("https://a.example.com/"), resolved: ["93.184.216.34", "93.184.216.35", "2606:2800:220:1::"], allowLoopback: false).get(),
      ["93.184.216.34", "2606:2800:220:1::", "93.184.216.35"])
    XCTAssertNil(try? PluginFetchPolicy.vettedAddresses(for: url("https://a.example.com/"), resolved: ["93.184.216.34", "2606:2800:220:1::", "10.0.0.5"], allowLoopback: false).get())
    XCTAssertNil(try? PluginFetchPolicy.vettedAddresses(for: url("https://a.example.com/"), resolved: ["93.184.216.34", "::ffff:127.0.0.1"], allowLoopback: false).get())
    XCTAssertEqual(try? PluginFetchPolicy.vettedAddresses(for: url("https://8.8.8.8/"), resolved: ["1.1.1.1"], allowLoopback: false).get(), ["8.8.8.8"])
    XCTAssertNil(try? PluginFetchPolicy.vettedAddresses(for: url("https://a.example.com/"), resolved: nil, allowLoopback: false).get())
  }

  func testAFailedAddressHandsOverToTheNextUntilOneConnects() {
    var attempts = PluginConnectAttempts(addresses: ["2606:2800:220:1::", "93.184.216.34"], deadline: 30)
    let first = attempts.next(now: 0)
    XCTAssertEqual(first?.address, "2606:2800:220:1::")
    XCTAssertEqual(first?.timeout, PluginConnectAttempts.fallbackAfter)
    attempts.failed(reason: "the network is unreachable")
    let second = attempts.next(now: 1)
    XCTAssertEqual(second?.address, "93.184.216.34")
    XCTAssertEqual(second?.timeout, 29)
    attempts.failed(reason: "the server refused the connection")
    XCTAssertNil(attempts.next(now: 2))
    XCTAssertEqual(attempts.failureReason, "none of its 2 addresses answered (the server refused the connection)")
  }

  func testAttemptsStayInsideTheRequestDeadline() {
    var attempts = PluginConnectAttempts(addresses: ["93.184.216.34", "93.184.216.35", "93.184.216.36"], deadline: 10)
    XCTAssertEqual(attempts.next(now: 8)?.timeout, 2)
    attempts.failed(reason: "it timed out")
    XCTAssertNil(attempts.next(now: 10))
    XCTAssertEqual(attempts.failureReason, "it timed out")
  }

  func testASingleAddressKeepsTheWholeTimeoutAndItsOwnFailureReason() {
    var attempts = PluginConnectAttempts(addresses: ["93.184.216.34"], deadline: 30)
    XCTAssertEqual(attempts.next(now: 0)?.timeout, 30)
    attempts.failed(reason: "the server refused the connection")
    XCTAssertNil(attempts.next(now: 1))
    XCTAssertEqual(attempts.failureReason, "the server refused the connection")
  }
}
