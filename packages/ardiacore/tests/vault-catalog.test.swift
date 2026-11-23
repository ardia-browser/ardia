import Foundation
import Testing

private let timingBudgets = ProcessInfo.processInfo.environment["ARDIA_PERF_BUDGETS"] == "1"

private func login(_ id: String, _ title: String, _ username: String, _ urls: [String], provider: String = "1password", updatedAt: Double? = nil, profile: String? = nil) -> VaultItem {
  VaultItem(provider: provider, id: id, title: title, username: username, urls: urls, updatedAt: updatedAt, profile: profile)
}

private func hugeVault(_ count: Int) -> [VaultItem] {
  (0..<count).map { index in
    let site = "site\(index % 9_000).example\(index % 7).com"
    let urls = (0..<(1 + index % 5)).map { "https://\(["", "login.", "accounts.", "app."][$0 % 4])\(site)/signin?next=\($0)" }
    return login("item\(index)", "Account \(index) Café", "user\(index % 400)@example.com", urls, updatedAt: Double(index))
  }
}

@Suite("Vault catalog")
struct VaultCatalogTests {
  let items = [
    login("a", "Example Mail", "sam@example.com", ["https://mail.example.com/login"]),
    login("b", "Example Accounts", "sam@example.com", ["accounts.example.com"]),
    login("c", "Elsewhere", "pat@other.org", ["https://other.org"]),
    login("d", "Alice's Pages", "alice", ["https://alice.github.io"]),
    login("e", "Bob's Pages", "bob", ["https://bob.github.io"]),
    login("f", "Local", "dev", ["http://127.0.0.1:8471/login.html"]),
    login("g", "Ardia Mail", "sam", ["https://mail.example.com"], provider: "ardia", profile: "work"),
    login("h", "Ardia Other", "kim", ["https://other.org"], provider: "ardia", profile: "home"),
  ]

  var catalog: VaultCatalog { VaultCatalog(items, ownProvider: "ardia") }

  @Test func `a page's site items are every login under its registrable domain and nothing across a public suffix`() {
    #expect(Set(catalog.near("https://www.example.com").map(\.id)) == ["a", "b", "g"])
    #expect(catalog.near("https://alice.github.io").map(\.id) == ["d"])
    #expect(catalog.near("http://127.0.0.1:8471").map(\.id) == ["f"])
    #expect(catalog.near("https://nowhere.example.net").isEmpty)
  }

  @Test func `search ranks a title that starts with the first word above one that only contains it, then by title`() {
    #expect(catalog.search("mail", limit: 10, filter: .everyProfile).map(\.id) == ["g", "a"])
    #expect(catalog.search("example sam", limit: 10, filter: .everyProfile).map(\.id) == ["b", "a", "g"])
  }

  @Test func `search folds accents and case, and an empty query lists by title`() {
    let accented = VaultCatalog([login("x", "Café Ünïcødé", "z", [])], ownProvider: "ardia")
    #expect(accented.search("CAFE unic", limit: 5, filter: .everyProfile).map(\.id) == ["x"])
    #expect(catalog.search("", limit: 3, filter: .everyProfile).map(\.title) == ["Alice's Pages", "Ardia Mail", "Ardia Other"])
  }

  @Test func `Ardia's own logins follow the profile filter while every manager's logins always show`() {
    #expect(catalog.search("", limit: 50, filter: .profile("work")).map(\.id).contains("g"))
    #expect(!catalog.search("", limit: 50, filter: .profile("work")).map(\.id).contains("h"))
    #expect(catalog.search("", limit: 50, filter: .managersOnly).allSatisfy { $0.provider != "ardia" })
    #expect(catalog.page(query: "", offset: 0, limit: 50, filter: .managersOnly).total == 6)
  }

  @Test func `a page is sorted by site then username, and the total counts every match`() {
    let page = catalog.page(query: "", offset: 0, limit: 3, filter: .everyProfile)
    #expect(page.total == 8)
    #expect(page.items.map(\.id) == ["f", "b", "d"])
    let rest = catalog.page(query: "", offset: 3, limit: 50, filter: .everyProfile)
    #expect(rest.items.map(\.id) == ["e", "g", "a", "h", "c"])
    #expect(catalog.page(query: "other kim", offset: 0, limit: 10, filter: .everyProfile).items.map(\.id) == ["h"])
    #expect(catalog.page(query: "", offset: 0, limit: 0, filter: .everyProfile).total == 8)
  }

  @Test func `usernames rank by how often they're used, then how recently, emails first when asked`() {
    let used = VaultCatalog([
      login("1", "A", "kim", [], updatedAt: 5), login("2", "B", "sam@example.com", [], updatedAt: 1), login("3", "C", "kim", [], updatedAt: 9),
      login("4", "D", "pat@example.com", [], updatedAt: 3),
    ], ownProvider: "ardia")
    #expect(used.usernames(email: false, limit: 5, filter: .everyProfile).map(\.id) == ["3", "4", "2"])
    #expect(used.usernames(email: true, limit: 2, filter: .everyProfile).map(\.username) == ["pat@example.com", "sam@example.com"])
  }

  @Test func `results stay within their caps however big the vault is`() {
    let same = (0..<800).map { login("s\($0)", "Same \($0)", "u\($0)", ["https://big.example.com"]) }
    let big = VaultCatalog(same, ownProvider: "ardia")
    #expect(big.near("https://big.example.com").count == VaultCatalog.siteItemsLimit)
    #expect(big.search("same", limit: 10_000, filter: .everyProfile).count == VaultCatalog.searchLimit)
    #expect(big.page(query: "", offset: 0, limit: 10_000, filter: .everyProfile).items.count == 800)
  }

  @Test(.timeLimit(.minutes(1)))
  func `a 50,000 login vault builds in about a second and answers each query in milliseconds`() {
    let vault = hugeVault(50_000)
    let clock = ContinuousClock()
    var built: VaultCatalog?
    let build = clock.measure { built = VaultCatalog(vault, ownProvider: "ardia") }
    let catalog = built!
    if timingBudgets { #expect(build < .seconds(3), "building took \(build)") }
    var near: [VaultItem] = []
    let lookup = clock.measure { for _ in 0..<100 { near = catalog.near("https://login.site42.example0.com") } }
    #expect(!near.isEmpty)
    if timingBudgets { #expect(lookup < .milliseconds(100), "100 site lookups took \(lookup)") }
    var found: [VaultItem] = []
    let search = clock.measure { found = catalog.search("account 4", limit: 100, filter: .everyProfile) }
    #expect(!found.isEmpty)
    if timingBudgets { #expect(search < .milliseconds(400), "a search took \(search)") }
    var listed = 0
    let page = clock.measure { listed = catalog.page(query: "", offset: 0, limit: 200, filter: .managersOnly).items.count }
    #expect(listed > 0)
    if timingBudgets { #expect(page < .milliseconds(150), "a page took \(page)") }
  }
}
