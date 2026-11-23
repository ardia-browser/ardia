import Foundation
import Testing
import os

private func login(_ id: String, _ title: String, _ username: String, _ urls: [String], provider: String = "1password", updatedAt: Double? = nil,
                   profile: String? = nil, urlMatch: [String]? = nil) -> VaultItem {
  VaultItem(provider: provider, id: id, title: title, username: username, urls: urls, urlMatch: urlMatch, updatedAt: updatedAt, profile: profile)
}

private func ids(_ ranked: [VaultRanked]) -> [String] { ranked.map(\.item.id) }

private let googleVault = [
  login("exact", "Google", "sam@gmail.com", ["https://accounts.google.com"]),
  login("mail", "Gmail", "pat@gmail.com", ["https://mail.google.com"]),
  login("root", "Google root", "kim@gmail.com", ["google.com"]),
  login("tube", "YouTube", "sam.tube@gmail.com", ["https://www.youtube.com"]),
  login("tubeHost", "YouTube Studio", "studio@gmail.com", ["https://studio.youtube.com"], urlMatch: ["host"]),
  login("fake", "Google", "sam@gmail.com", ["https://g00gle.com"]),
  login("fake2", "Google login", "sam@gmail.com", ["https://accounts.google.com.evil.io"]),
  login("other", "Bank", "sam", ["https://bank.example.org"]),
  login("brandOnly", "Google", "notes@example.com", []),
]

@Suite("Fill menu recommendations")
struct VaultRecommendTests {
  let catalog = VaultCatalog(googleVault, ownProvider: "ardia")

  func recommend(_ origin: String, usage: VaultUsageSignals = .none, pageUsername: String? = nil, remembered: String? = nil, in catalog: VaultCatalog? = nil)
    -> [VaultRanked]
  {
    (catalog ?? self.catalog).recommend(origin: origin, filter: .everyProfile, usage: usage, pageUsername: pageUsername, remembered: remembered)
  }

  @Test func `the page's own origin comes first, then the rest of its registrable domain, then its shared group`() {
    let ranked = recommend("https://accounts.google.com")
    #expect(ids(ranked) == ["exact", "root", "mail", "tube"])
    #expect(ranked.map(\.reason) == [.origin, .site, .site, .shared])
    #expect(ranked.last?.site == "youtube.com", "a shared suggestion says which site it is for")
    #expect(ranked.last?.tier == .sibling, "a shared suggestion always needs a choice")
  }

  @Test func `a look-alike or a lookalike suffix never matches the real site, and the real site never matches them`() {
    #expect(!ids(recommend("https://accounts.google.com")).contains("fake"))
    #expect(!ids(recommend("https://accounts.google.com")).contains("fake2"))
    #expect(ids(recommend("https://g00gle.com")) == ["fake"])
    #expect(ids(recommend("https://accounts.google.com.evil.io")) == ["fake2"])
  }

  @Test func `no login crosses to an unrelated registrable domain, and a host-only login stays on its host`() {
    #expect(ids(recommend("https://bank.example.org")) == ["other"])
    #expect(!ids(recommend("https://www.google.com")).contains("tubeHost"))
    #expect(ids(recommend("https://shop.unrelated.net")).isEmpty)
  }

  @Test func `a login with no website is offered by brand only when nothing on the site matches`() {
    let noUrls = VaultCatalog([googleVault[8], googleVault[7]], ownProvider: "ardia")
    let ranked = recommend("https://accounts.google.com", in: noUrls)
    #expect(ids(ranked) == ["brandOnly"])
    #expect(ranked.first?.reason == .brand)
    #expect(!ids(recommend("https://accounts.google.com")).contains("brandOnly"))
    #expect(ids(recommend("https://g00gle.com", in: noUrls)).isEmpty)
  }

  @Test func `what was filled here leads its group, then how often, but never lifts a login past a better match`() {
    let usage = VaultUsageSignals(lastHere: "1password/mail", frequency: ["1password/root": 3, "1password/tube": 50], recentlyEdited: [])
    let ranked = recommend("https://accounts.google.com", usage: usage)
    #expect(ids(ranked) == ["exact", "mail", "root", "tube"])
  }

  @Test func `the username the page already shows pins its login above everything on the site`() {
    #expect(ids(recommend("https://accounts.google.com", pageUsername: " PAT@gmail.com ")).first == "mail")
    #expect(ids(recommend("https://accounts.google.com", pageUsername: "sam.tube@gmail.com")).first == "exact", "a shared login is never pinned")
  }

  @Test func `the same username on the same host from two managers shows once`() {
    let twice = VaultCatalog([
      login("a", "Site", "sam", ["https://example.com"]), login("b", "Site", "sam", ["https://example.com"], provider: "bitwarden"),
      login("c", "Site 2", "sam", ["https://example.com/other"]),
    ], ownProvider: "ardia")
    #expect(ids(recommend("https://example.com", in: twice)) == ["a", "c"])
  }
}

@Suite("Fill menu search")
struct VaultSmartSearchTests {
  let catalog = VaultCatalog([
    login("u", "Work", "samantha@example.com", ["https://intranet.example.com"], updatedAt: 1),
    login("t", "Samba Share", "admin", ["https://nas.local.example"], updatedAt: 2),
    login("h", "Router", "root", ["https://sam-router.example.net"], updatedAt: 3),
    login("s", "Old account", "x", ["https://example.org"], updatedAt: 4),
    login("v", "Notes", "kim", ["https://notes.example.com"], updatedAt: 5),
    login("g", "Google", "pat@gmail.com", ["https://accounts.google.com"], updatedAt: 6),
    login("café", "Café Crème", "lou", ["https://cafe.example.fr"], updatedAt: 7),
  ], ownProvider: "ardia")

  func search(_ query: String, origin: String = "https://unrelated.test") -> [String] {
    catalog.smartSearch(query, origin: origin, limit: 20, filter: .everyProfile)?.map(\.id) ?? []
  }

  @Test func `a username or title prefix beats a host prefix, which beats a match inside a word`() {
    #expect(search("sam") == ["t", "u", "h"])
  }

  @Test func `every word must match, in any field, case and accents ignored`() {
    #expect(search("SAMANTHA intranet") == ["u"])
    #expect(search("creme") == ["café"])
    #expect(search("sam nothing").isEmpty)
  }

  @Test func `one typo is forgiven in words of four or more letters, never in shorter ones`() {
    #expect(search("gogle") == ["g"])
    #expect(search("googel") == ["g"])
    #expect(search("rotuer") == ["h"])
    #expect(search("gol").isEmpty)
  }

  @Test func `among equal matches the page's site comes first, then the most recent`() {
    let mail = VaultCatalog([
      login("old", "Mail", "a", ["https://mail.example.com"], updatedAt: 1), login("new", "Mail", "b", ["https://mail.other.org"], updatedAt: 9),
      login("newest", "Mail", "c", ["https://mail.third.net"], updatedAt: 10),
    ], ownProvider: "ardia")
    #expect(mail.smartSearch("mail", origin: "https://www.example.com", limit: 5, filter: .everyProfile)?.map(\.id) == ["old", "newest", "new"])
  }

  @Test func `a newer keystroke cancels a running search`() {
    #expect(catalog.smartSearch("sam", origin: "", limit: 20, filter: .everyProfile) { true } == nil)
  }
}

@Suite("Usage signals")
struct VaultUsageTests {
  @Test func `fills decay with a thirty day half life and the newest fill is remembered per site and profile`() {
    var book = VaultUsageBook()
    let day = 24 * 3600 * 1000.0
    book.noteFill(profile: "work", origin: "https://accounts.google.com", item: "1password/a", now: 0)
    book.noteFill(profile: "work", origin: "https://mail.google.com", item: "1password/a", now: 30 * day)
    book.noteFill(profile: "work", origin: "https://google.com", item: "1password/b", now: 30 * day + 1)
    let here = book.signals(profile: "work", origin: "https://www.google.com", now: 30 * day + 2)
    #expect(here.lastHere == "1password/b")
    #expect(abs((here.frequency["1password/a"] ?? 0) - 1.5) < 0.01)
    #expect(book.signals(profile: "home", origin: "https://google.com", now: 30 * day).lastHere == nil, "another profile sees nothing")
  }

  @Test func `forgetting a manager or pruning to what is listed clears its signals`() {
    var book = VaultUsageBook()
    book.noteFill(profile: nil, origin: "https://a.example", item: "1password/a", now: 1)
    book.noteFill(profile: nil, origin: "https://a.example", item: "bitwarden/b", now: 2)
    book.noteEdit(item: "1password/gone", now: 3)
    let pruned = book.keepOnly(listed: ["1password/a"], of: ["1password"])
    #expect(pruned)
    #expect(book.edited.isEmpty)
    book.forget(provider: "1password")
    #expect(book.signals(profile: nil, origin: "https://a.example", now: 4).frequency.keys.sorted() == ["bitwarden/b"])
  }

  @Test func `signals are written off the caller and read back from the sealed bytes`() {
    let stored = OSAllocatedUnfairLock(initialState: Data?.none)
    let usage = VaultUsage(read: { stored.withLock { $0 } }, write: { data in stored.withLock { $0 = data } }, clock: { 1000 })
    usage.noteFill(profile: "p", origin: "https://example.com", provider: "1password", id: "a")
    usage.settle()
    let again = VaultUsage(read: { stored.withLock { $0 } }, write: { _ in }, clock: { 1000 })
    #expect(again.signals(profile: "p", origin: "https://login.example.com").lastHere == "1password/a")
  }
}

@Suite("Search and recommendation budget")
struct VaultRankBudgetTests {
  static func vault(_ count: Int) -> [VaultItem] {
    (0..<count).map { index in
      let site = "site\(index % 9_000).example\(index % 7).com"
      return login("item\(index)", "Account \(index) Café", "user\(index % 400)@example.com", ["https://login.\(site)", "https://\(site)/signin"], updatedAt: Double(index))
    }
  }

  @Test(.timeLimit(.minutes(1)))
  func `a 50,000 login vault answers each keystroke and each recommendation in under 16 ms`() {
    let catalog = VaultCatalog(Self.vault(50_000), ownProvider: "ardia")
    let clock = ContinuousClock()
    var times: [Duration] = []
    for query in ["u", "us", "use", "user", "user4", "user42", "user42@", "user42@exa", "acount", "café 77", "site4 user"] {
      let runs = (0..<3).map { _ in clock.measure { _ = catalog.smartSearch(query, origin: "https://login.site42.example0.com", limit: 100, filter: .everyProfile) } }
      times.append(runs.min()!)
    }
    times.sort()
    let p50 = times[times.count / 2]
    let p95 = times[min(times.count - 1, Int(Double(times.count) * 0.95))]
    print("keystroke p50 \(p50) p95 \(p95)")
    #expect(p95 < .milliseconds(16), "p95 \(p95)")
    let recommend = (0..<20).map { _ in
      clock.measure { _ = catalog.recommend(origin: "https://login.site42.example0.com", filter: .everyProfile, usage: .none, pageUsername: nil, remembered: nil) }
    }.sorted()[10]
    print("recommend \(recommend)")
    #expect(recommend < .milliseconds(16))
  }
}
