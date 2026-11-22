import XCTest

@testable import ArdiaPluginCore

final class PluginFetchPolicyTests: XCTestCase {
  func url(_ text: String) -> URL { URL(string: text)! }

  func testExactHostsMatchCaseInsensitivelyAndIgnoreATrailingDot() {
    XCTAssertTrue(PluginFetchPolicy.hostAllowed("api.example.com", by: ["api.example.com"]))
    XCTAssertTrue(PluginFetchPolicy.hostAllowed("API.Example.COM.", by: ["api.example.com"]))
    XCTAssertFalse(PluginFetchPolicy.hostAllowed("example.com", by: ["api.example.com"]))
    XCTAssertFalse(PluginFetchPolicy.hostAllowed("api.example.com.evil.net", by: ["api.example.com"]))
    XCTAssertFalse(PluginFetchPolicy.hostAllowed("api.example.com", by: []))
  }

  func testAWildcardMatchesSubdomainsButNotTheApexOrLookalikes() {
    let rules = ["*.example.com"]
    XCTAssertTrue(PluginFetchPolicy.hostAllowed("a.example.com", by: rules))
    XCTAssertTrue(PluginFetchPolicy.hostAllowed("a.b.example.com", by: rules))
    XCTAssertFalse(PluginFetchPolicy.hostAllowed("example.com", by: rules))
    XCTAssertFalse(PluginFetchPolicy.hostAllowed("badexample.com", by: rules))
    XCTAssertFalse(PluginFetchPolicy.hostAllowed("example.com.evil.net", by: rules))
    XCTAssertFalse(PluginFetchPolicy.hostAllowed("a.example.com", by: ["*."]))
    XCTAssertFalse(PluginFetchPolicy.hostAllowed("a.example.com", by: ["*.*.com"]))
    XCTAssertFalse(PluginFetchPolicy.hostAllowed("a.example.com", by: ["a.*.com"]))
  }

  func testAStarAllowsAnyPublicHostButNotPrivateOnes() {
    XCTAssertNil(PluginFetchPolicy.check(url("https://anything.example.org/x"), allowedHosts: ["*"]))
    XCTAssertNotNil(PluginFetchPolicy.check(url("https://10.0.0.1/"), allowedHosts: ["*"]))
    XCTAssertNotNil(PluginFetchPolicy.check(url("https://localhost:8080/"), allowedHosts: ["*"]))
    XCTAssertNotNil(PluginFetchPolicy.check(url("https://router.local/"), allowedHosts: ["*"]))
    XCTAssertNotNil(PluginFetchPolicy.check(url("https://metadata.google.internal/"), allowedHosts: ["*"]))
  }

  func testOnlyHttpsWithoutCredentialsPasses() {
    XCTAssertNotNil(PluginFetchPolicy.check(url("ftp://example.com/"), allowedHosts: ["*"]))
    XCTAssertNotNil(PluginFetchPolicy.check(url("file:///etc/passwd"), allowedHosts: ["*"]))
    XCTAssertNotNil(PluginFetchPolicy.check(url("https://user:pass@example.com/"), allowedHosts: ["*"]))
    XCTAssertNotNil(PluginFetchPolicy.check(url("https://user@example.com/"), allowedHosts: ["*"]))
    XCTAssertNil(PluginFetchPolicy.check(url("https://example.com:8443/"), allowedHosts: ["example.com"]))
    XCTAssertNotNil(PluginFetchPolicy.check(url("http://example.com:8443/"), allowedHosts: ["example.com"]))
    XCTAssertNotNil(PluginFetchPolicy.check(url("http://example.com/"), allowedHosts: ["*"]))
    XCTAssertNotNil(PluginFetchPolicy.checkRedirect(to: url("http://example.com/"), count: 1, allowedHosts: ["*"], allowLoopback: false))
  }

  func testPrivateLoopbackLinkLocalAndMetadataIPv4LiteralsAreBlocked() {
    for host in [
      "127.0.0.1", "127.1", "0x7f.1", "2130706433", "0.0.0.0", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
      "224.0.0.1", "255.255.255.255", "198.18.0.1",
    ] {
      XCTAssertTrue(PluginFetchPolicy.isBlockedAddress(host), host)
      XCTAssertNotNil(PluginFetchPolicy.check(url("https://\(host)/"), allowedHosts: ["*", host]), host)
    }
    for host in ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "93.184.216.34"] {
      XCTAssertFalse(PluginFetchPolicy.isBlockedAddress(host), host)
    }
  }

  func testPrivateAndMappedIPv6LiteralsAreBlocked() {
    for host in ["::1", "::", "fe80::1", "fc00::1", "fd00:ec2::254", "ff02::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe", "2002:7f00:1::", "2001:db8::1", "[::1]"] {
      XCTAssertTrue(PluginFetchPolicy.isBlockedAddress(host), host)
    }
    XCTAssertFalse(PluginFetchPolicy.isBlockedAddress("2606:4700:4700::1111"))
    XCTAssertFalse(PluginFetchPolicy.isBlockedAddress("::ffff:8.8.8.8"))
    XCTAssertNotNil(PluginFetchPolicy.check(url("https://[::1]:8080/"), allowedHosts: ["*"]))
    XCTAssertNotNil(PluginFetchPolicy.check(url("https://[::ffff:7f00:1]/"), allowedHosts: ["*"]))
  }

  func testNat64AddressesAreJudgedByTheIPv4TheyCarry() {
    XCTAssertFalse(PluginFetchPolicy.isBlockedAddress("64:ff9b::808:808"))
    XCTAssertTrue(PluginFetchPolicy.isBlockedAddress("64:ff9b::a00:1"))
    XCTAssertTrue(PluginFetchPolicy.isBlockedAddress("64:ff9b:1:a00:0:100:808:808"))
    XCTAssertTrue(PluginFetchPolicy.isBlockedAddress("64:ff9b:1::808:808"))
    XCTAssertTrue(PluginFetchPolicy.isBlockedAddress("64:ff9b:2::808:808"))
    XCTAssertNotNil(PluginFetchPolicy.check(url("https://[64:ff9b:1:a00:0:100:808:808]/"), allowedHosts: ["*"]))
  }

  func testLoopbackPassesOnlyForAnIsolatedInstanceThatListsIt() {
    XCTAssertTrue(PluginFetchPolicy.loopbackAllowed(isolated: true, allowedHosts: ["127.0.0.1"]))
    XCTAssertFalse(PluginFetchPolicy.loopbackAllowed(isolated: false, allowedHosts: ["127.0.0.1"]))
    XCTAssertFalse(PluginFetchPolicy.loopbackAllowed(isolated: true, allowedHosts: ["*"]))
    XCTAssertNil(PluginFetchPolicy.check(url("http://127.0.0.1:9000/"), allowedHosts: ["127.0.0.1"], allowLoopback: true))
    XCTAssertNotNil(PluginFetchPolicy.check(url("https://127.0.0.2:9000/"), allowedHosts: ["*"], allowLoopback: true))
    XCTAssertNotNil(PluginFetchPolicy.check(url("https://localhost:9000/"), allowedHosts: ["*"], allowLoopback: true))
  }

  func testEveryRedirectIsCheckedAgainstTheSameRules() {
    let rules = ["api.example.com"]
    XCTAssertNil(PluginFetchPolicy.checkRedirect(to: url("https://api.example.com/next"), count: PluginFetchPolicy.maxRedirects, allowedHosts: rules, allowLoopback: false))
    XCTAssertNil(PluginFetchPolicy.checkRedirect(to: url("https://api.example.com/next"), count: 1, allowedHosts: rules, allowLoopback: false))
    XCTAssertNotNil(PluginFetchPolicy.checkRedirect(to: url("https://other.example.com/"), count: 1, allowedHosts: rules, allowLoopback: false))
    XCTAssertNotNil(PluginFetchPolicy.checkRedirect(to: url("https://169.254.169.254/latest/meta-data"), count: 1, allowedHosts: ["*"], allowLoopback: false))
    XCTAssertNotNil(PluginFetchPolicy.checkRedirect(to: url("file:///etc/passwd"), count: 1, allowedHosts: ["*"], allowLoopback: false))
    XCTAssertNotNil(PluginFetchPolicy.checkRedirect(to: url("https://api.example.com/"), count: PluginFetchPolicy.maxRedirects + 1, allowedHosts: rules, allowLoopback: false))
  }

  func testACrossOriginRedirectDropsCredentialsHeaders() {
    let headers = ["authorization": "Bearer x", "cookie": "a=b", "accept": "*/*"]
    let kept = PluginFetchPolicy.redirectHeaders(headers, from: url("https://a.example.com/"), to: url("https://a.example.com/b"))
    XCTAssertEqual(kept, headers)
    let dropped = PluginFetchPolicy.redirectHeaders(headers, from: url("https://a.example.com/"), to: url("https://b.example.com/"))
    XCTAssertEqual(dropped, ["accept": "*/*"])
  }

  func testACrossOriginRedirectForwardsOnlyHeadersSafeForAnyOrigin() {
    let headers = ["x-api-key": "secret", "private-token": "t", "accept": "application/json", "accept-language": "en", "content-type": "text/plain", "user-agent": "Plugin"]
    XCTAssertEqual(PluginFetchPolicy.redirectHeaders(headers, from: url("https://a.example.com/"), to: url("https://a.example.com/b")), headers)
    XCTAssertEqual(
      PluginFetchPolicy.redirectHeaders(headers, from: url("https://a.example.com/"), to: url("https://b.example.com/")),
      ["accept": "application/json", "accept-language": "en", "content-type": "text/plain", "user-agent": "Plugin"])
    XCTAssertEqual(PluginFetchPolicy.redirectHeaders(headers, from: url("https://a.example.com/"), to: url("http://a.example.com/"))["x-api-key"], nil)
  }

  func testPlainHttpIsRefusedWithAnyHeadersExceptOnTheIsolatedTestLoopback() {
    func reason(_ address: String, _ headers: [String: String], loopback: Bool = false) -> String? {
      if case .failure(let refusal) = PluginFetchPolicy.request(
        url: address, method: "POST", headers: headers, body: "{}", timeoutMs: 1000, allowedHosts: ["*", "127.0.0.1"], allowLoopback: loopback)
      {
        return refusal.reason
      }
      return nil
    }
    XCTAssertNotNil(reason("http://api.example.com/", ["Authorization": "Bearer x"]))
    XCTAssertNotNil(reason("http://api.example.com/", ["X-Api-Key": "k"]))
    XCTAssertNotNil(reason("http://api.example.com/", [:]))
    XCTAssertNil(reason("https://api.example.com/", ["Authorization": "Bearer x", "Cookie": "a=b", "X-Api-Key": "k"]))
    XCTAssertNil(reason("http://127.0.0.1:9000/", ["Authorization": "Bearer x"], loopback: true))
    XCTAssertNotNil(reason("http://127.0.0.1:9000/", [:]))
  }

  func testResolvedAddressesAreCheckedSoAPublicNameCantPointInside() {
    XCTAssertTrue(PluginFetchPolicy.resolvedAddressesBlocked(["93.184.216.34", "10.0.0.5"], allowLoopback: false))
    XCTAssertFalse(PluginFetchPolicy.resolvedAddressesBlocked(["93.184.216.34", "2606:2800:220:1::"], allowLoopback: false))
    XCTAssertFalse(PluginFetchPolicy.resolvedAddressesBlocked(["127.0.0.1"], allowLoopback: true))
  }

  func testRequestsClampTheTimeoutAndCheckMethodHeadersAndBody() throws {
    let made = try PluginFetchPolicy.request(
      url: "https://api.example.com/v1", method: "post", headers: ["Content-Type": "application/json", "Host": "evil", "Sec-Fetch-Site": "x"], body: "{}",
      timeoutMs: 999_999, allowedHosts: ["api.example.com"], allowLoopback: false
    ).get()
    XCTAssertEqual(made.method, "POST")
    XCTAssertEqual(made.headers, ["content-type": "application/json"])
    XCTAssertEqual(made.timeout, 60)
    XCTAssertEqual(made.body, Data("{}".utf8))
    XCTAssertEqual(PluginFetchPolicy.clampedTimeout(5), 1)
    XCTAssertEqual(PluginFetchPolicy.clampedTimeout(2500), 2.5)
    func refused(_ method: String, _ headers: [String: String] = [:], body: String? = nil) -> Bool {
      if case .failure = PluginFetchPolicy.request(url: "https://a.example.com/", method: method, headers: headers, body: body, timeoutMs: 1000, allowedHosts: ["*"], allowLoopback: false) {
        return true
      }
      return false
    }
    XCTAssertTrue(refused("CONNECT"))
    XCTAssertTrue(refused("TRACE"))
    XCTAssertTrue(refused("GET", body: "x"))
    XCTAssertTrue(refused("GET", ["X-A": "b\r\nInjected: 1"]))
    XCTAssertTrue(refused("GET", ["Bad Name": "x"]))
    XCTAssertFalse(refused("GET", ["X-A": "b"]))
    XCTAssertTrue(refused("POST", body: String(repeating: "a", count: PluginFetchPolicy.maxRequestBytes + 1)))
  }

  func testSizeBudgetsFitTheOneMegabyteChannelReply() {
    XCTAssertEqual(PluginFetchPolicy.maxResponseBytes, 716_800)
    XCTAssertEqual(PluginFetchPolicy.maxRequestBytes, 524_288)
    XCTAssertEqual(PluginFetchPolicy.maxRedirects, 5)
    let headers = Dictionary(uniqueKeysWithValues: (0..<50).map { ("x-header-\($0)", String(repeating: "v", count: 160)) })
    let reply: [String: Any] = ["ok": true, "status": 200, "statusText": "no error", "url": "https://a.example.com/" + String(repeating: "p", count: 8000), "headers": headers, "body": String(repeating: "a", count: PluginFetchPolicy.maxResponseBytes)]
    let line = try! JSONSerialization.data(withJSONObject: ["id": 1, "result": reply])
    XCTAssertLessThan(line.count, 1 << 20)
    let atLimit = PluginFetchPolicy.request(
      url: "https://a.example.com/", method: "POST", headers: [:], body: String(repeating: "a", count: PluginFetchPolicy.maxRequestBytes), timeoutMs: 1000, allowedHosts: ["*"], allowLoopback: false)
    XCTAssertNotNil(try? atLimit.get())
  }

  func testTheConnectionIsPinnedToAVettedAddress() {
    XCTAssertEqual(try? PluginFetchPolicy.pinnedAddress(for: url("https://a.example.com/"), resolved: ["93.184.216.34", "2606:2800:220:1::"], allowLoopback: false).get(), "93.184.216.34")
    XCTAssertNil(try? PluginFetchPolicy.pinnedAddress(for: url("https://a.example.com/"), resolved: ["93.184.216.34", "10.0.0.5"], allowLoopback: false).get())
    XCTAssertNil(try? PluginFetchPolicy.pinnedAddress(for: url("https://a.example.com/"), resolved: [], allowLoopback: false).get())
    XCTAssertNil(try? PluginFetchPolicy.pinnedAddress(for: url("https://a.example.com/"), resolved: nil, allowLoopback: false).get())
    XCTAssertNil(try? PluginFetchPolicy.pinnedAddress(for: url("https://a.example.com/"), resolved: ["not-an-ip"], allowLoopback: false).get())
    XCTAssertEqual(try? PluginFetchPolicy.pinnedAddress(for: url("http://8.8.8.8/"), resolved: nil, allowLoopback: false).get(), "8.8.8.8")
    XCTAssertEqual(try? PluginFetchPolicy.pinnedAddress(for: url("http://[2606:4700:4700::1111]/"), resolved: nil, allowLoopback: false).get(), "2606:4700:4700::1111")
    XCTAssertNil(try? PluginFetchPolicy.pinnedAddress(for: url("http://169.254.169.254/"), resolved: nil, allowLoopback: false).get())
    XCTAssertEqual(try? PluginFetchPolicy.pinnedAddress(for: url("http://127.0.0.1:9000/"), resolved: nil, allowLoopback: true).get(), "127.0.0.1")
    XCTAssertNil(try? PluginFetchPolicy.pinnedAddress(for: url("http://127.0.0.1:9000/"), resolved: nil, allowLoopback: false).get())
  }

  func testANonAsciiHostIsRefused() {
    let url = URL(string: "https://xn--bcher-kva.example/")!
    XCTAssertNil(PluginFetchPolicy.check(url, allowedHosts: ["xn--bcher-kva.example"]))
    if let unicode = URL(string: "https://bücher.example/"), let host = unicode.host, !host.utf8.allSatisfy({ $0 < 0x80 }) {
      XCTAssertNotNil(PluginFetchPolicy.check(unicode, allowedHosts: ["*"]))
    }
  }

  func testAnExplicitDefaultPortIsTheSameOriginAsNoPort() {
    let plain = URL(string: "https://api.example.com/start")!
    XCTAssertTrue(PluginFetchPolicy.sameOrigin(plain, URL(string: "https://api.example.com:443/next")!))
    XCTAssertTrue(PluginFetchPolicy.sameOrigin(URL(string: "https://API.example.com:443/a")!, plain))
    XCTAssertFalse(PluginFetchPolicy.sameOrigin(plain, URL(string: "https://api.example.com:8443/next")!))
    let headers = ["authorization": "Bearer x", "accept": "*/*"]
    XCTAssertEqual(PluginFetchPolicy.redirectHeaders(headers, from: plain, to: URL(string: "https://api.example.com:443/next")!), headers)
  }
}
