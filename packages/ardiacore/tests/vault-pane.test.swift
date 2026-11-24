import Foundation
import Testing

private let timingBudgets = ProcessInfo.processInfo.environment["ARDIA_PERF_BUDGETS"] == "1"

private func item(_ id: String, _ title: String, _ username: String, _ urls: [String], provider: String = "1password", profile: String? = nil) -> VaultItem {
  VaultItem(provider: provider, id: id, title: title, username: username, urls: urls, profile: profile)
}

private func saved(_ origin: String, _ username: String) -> VaultSavedLogin { VaultSavedLogin(origin: origin, username: username) }

private func shown(_ order: VaultPaneOrder, _ index: VaultSavedIndex, _ catalog: VaultCatalog?) -> [String] {
  order.rows.map { encoded in
    encoded >= 0 ? "saved:\(index.logins[Int(encoded)].username)" : "item:\(catalog!.items[Int(-encoded - 1)].id)"
  }
}

private func offMain<T: Sendable>(_ work: @escaping @Sendable () -> T) async -> T { await Task.detached { work() }.value }

@Suite("Settings password list")
struct VaultPaneTests {
  @Test func `saved logins sort by site, then username, ignoring case and reading numbers as numbers`() async {
    let index = await offMain {
      VaultSavedIndex([saved("https://b.example.com", "zed"), saved("https://site10.test", "a"), saved("https://www.A.example.com", "amy"), saved("https://site9.test", "a"),
                       saved("https://b.example.com", "Bea")])
    }
    let order = VaultPaneOrder.merge(saved: index, catalog: nil, query: "")
    #expect(shown(order, index, nil) == ["saved:amy", "saved:Bea", "saved:zed", "saved:a", "saved:a"])
    #expect(index.logins[Int(order.rows[3])].origin == "https://site9.test")
    #expect(order.listed == 5)
  }

  @Test func `every search word must match the origin or the username, and an IDN host matches by its Unicode name`() async {
    let index = await offMain {
      VaultSavedIndex([saved("https://mail.example.com", "sam@home.test"), saved("https://shop.example.com", "kim"), saved("https://xn--mnchen-3ya.de", "max")])
    }
    #expect(shown(VaultPaneOrder.merge(saved: index, catalog: nil, query: "EXAMPLE sam"), index, nil) == ["saved:sam@home.test"])
    #expect(shown(VaultPaneOrder.merge(saved: index, catalog: nil, query: "münchen"), index, nil) == ["saved:max"])
    #expect(VaultPaneOrder.merge(saved: index, catalog: nil, query: "nobody").rows.isEmpty)
  }

  @Test func `the profile's saved logins and every manager's logins merge in one site order, saved first on a tie`() async {
    let catalog = await offMain {
      VaultCatalog([
        item("m1", "Mail", "sam", ["https://mail.example.com"]), item("m2", "Zebra", "amy", ["https://zebra.test"]),
        item("own", "Ardia's own", "sam", ["https://aaa.test"], provider: "ardia", profile: "work"),
      ], ownProvider: "ardia")
    }
    let index = await offMain { VaultSavedIndex([saved("https://mail.example.com", "sam"), saved("https://beta.test", "kim")]) }
    let order = VaultPaneOrder.merge(saved: index, catalog: catalog, query: "")
    #expect(shown(order, index, catalog) == ["saved:kim", "saved:sam", "item:m1", "item:m2"])
    #expect(order.listed == 4)
    #expect(shown(VaultPaneOrder.merge(saved: index, catalog: catalog, query: "sam"), index, catalog) == ["saved:sam", "item:m1"])
  }

  @Test func `logins on a website are found by their exact origin, whatever its case or trailing slash`() async {
    let index = await offMain {
      VaultSavedIndex([saved("https://Example.com/", "a"), saved("https://example.com", "b"), saved("https://example.com:8443", "c"), saved("http://example.com", "d")])
    }
    #expect(index.on("https://example.com").map(\.username) == ["a", "b"])
    #expect(index.on("https://example.com:8443/").map(\.username) == ["c"])
  }

  @Test func `the engine's list parses off the main thread, and an engine error reads as no list`() async {
    let parsed = await offMain { VaultSavedIndex.parse(#"{"passwords":[{"origin":"https://a.test","username":"amy"},{"origin":"https://b.test"}]}"#) }
    #expect(parsed == [saved("https://a.test", "amy"), saved("https://b.test", "")])
    #expect(await offMain { VaultSavedIndex.parse(#"{"error":"profile not loaded"}"#) } == nil)
    #expect(await offMain { VaultSavedIndex.parse("not json") } == nil)
  }

  @Test(arguments: ["münchen", "bücher", "例え", "xn", "a-b"])
  func `punycode decodes what it encodes`(label: String) {
    let encoded = VaultPunycode.encode(label)
    #expect(encoded.flatMap(VaultPunycode.decode) == label)
  }

  @Test func `a host shows each IDN label in Unicode and leaves the rest alone`() {
    #expect(VaultPunycode.displayed("https://www.xn--mnchen-3ya.de/login") == "https://www.münchen.de/login")
    #expect(VaultPunycode.displayed("https://xn--zz.example") == "https://xn--zz.example")
  }

  @Test(.timeLimit(.minutes(1)))
  func `50,000 saved logins and a 50,000 login manager merge and search in milliseconds, off the main thread`() async {
    let logins = (0..<50_000).map { saved("https://site\($0 % 9_000).example\($0 % 7).com", "user\($0)@example.com") }
    let items = (0..<50_000).map { item("i\($0)", "Account \($0)", "sam\($0 % 400)", ["https://login.site\($0 % 9_000).example\($0 % 7).com/signin"]) }
    let clock = ContinuousClock()
    let started = clock.now
    let index = await offMain { VaultSavedIndex(logins) }
    let built = started.duration(to: clock.now)
    let catalog = await offMain { VaultCatalog(items, ownProvider: "ardia") }
    let (merged, all) = await offMain {
      let started = ContinuousClock.now
      let order = VaultPaneOrder.merge(saved: index, catalog: catalog, query: "")
      return (order, started.duration(to: .now))
    }
    #expect(merged.rows.count == 100_000)
    #expect(merged.listed == 100_000)
    let (searched, search) = await offMain {
      let started = ContinuousClock.now
      let order = VaultPaneOrder.merge(saved: index, catalog: catalog, query: "site42 user")
      return (order, started.duration(to: .now))
    }
    #expect(!searched.rows.isEmpty)
    #expect(searched.rows.allSatisfy { $0 >= 0 })
    print("pane list: index \(built), merge \(all), search \(search)")
    if timingBudgets {
      #expect(built < .seconds(2), "indexing took \(built)")
      #expect(all < .milliseconds(200), "merging took \(all)")
      #expect(search < .milliseconds(50), "a search took \(search)")
    }
  }
}
