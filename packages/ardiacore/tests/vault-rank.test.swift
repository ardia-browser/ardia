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

  @Test func `the page's own origin comes first, then the rest of its registrable domain`() {
    let ranked = recommend("https://accounts.google.com")
    #expect(ids(ranked) == ["exact", "root", "mail"], "Apple's list doesn't group google.com with youtube.com")
    #expect(ranked.map(\.reason) == [.origin, .site, .site])
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
    #expect(ids(ranked) == ["exact", "mail", "root"])
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

private let sharedVault = [
  login("store", "Steam", "sam", ["https://store.steampowered.com"]),
  login("community", "Steam Community", "sam.c", ["https://steamcommunity.com"]),
  login("communityHost", "Steam Community", "host.only", ["https://steamcommunity.com"], urlMatch: ["host"]),
  login("behance", "Behance", "pat", ["https://www.behance.net"]),
  login("adobe", "Adobe", "pat.a", ["https://account.adobe.com"]),
  login("trello", "Trello", "kim", ["https://trello.com"]),
  login("atlassianId", "Atlassian", "kim.a", ["https://id.atlassian.com"]),
  login("fakeCommunity", "Steam Community", "sam", ["https://steamcommunity.co"]),
  login("fakeSuffix", "Steam", "sam", ["https://steampowered.com.evil.io"]),
  login("fakeAdobe", "Behance", "pat", ["https://behance.net.example.org"]),
]

@Suite("Shared sign-in groups from Apple's list")
struct VaultSharedSitesTests {
  let catalog = VaultCatalog(sharedVault, ownProvider: "ardia")

  func recommend(_ origin: String) -> [VaultRanked] {
    catalog.recommend(origin: origin, filter: .everyProfile, usage: .none, pageUsername: nil, remembered: nil)
  }

  @Test func `the vendored list comes from a pinned commit of Apple's file`() {
    #expect(VaultSharedSitesData.commit.count == 40 && VaultSharedSitesData.commit.allSatisfy(\.isHexDigit))
    #expect(VaultSharedSites.sourcesByPage["steampowered.com"]?.contains("steamcommunity.com") == true)
    #expect(VaultSharedSites.sourcesByPage["google.com"] == nil && VaultSharedSites.sourcesByPage["youtube.com"] == nil)
    #expect(VaultSharedSites.sourcesByPage.values.allSatisfy { !$0.isEmpty })
  }

  @Test func `a shared group offers its logins both ways, after the page's own site, and says which site each is for`() {
    let onStore = recommend("https://store.steampowered.com")
    #expect(ids(onStore) == ["store", "community"])
    #expect(onStore.map(\.reason) == [.origin, .shared])
    #expect(onStore.last?.site == "steamcommunity.com")
    #expect(onStore.last?.tier == .sibling, "a shared suggestion always needs a choice")
    let busy = VaultUsageSignals(lastHere: nil, frequency: ["1password/community": 50], recentlyEdited: [])
    #expect(ids(catalog.recommend(origin: "https://store.steampowered.com", filter: .everyProfile, usage: busy, pageUsername: "sam.c", remembered: nil)) == ["store", "community"],
            "fills and the page's username never lift a shared login past the site's own")
    let onCommunity = recommend("https://steamcommunity.com")
    #expect(ids(onCommunity).contains("store") && onCommunity.first { $0.item.id == "store" }?.reason == .shared)
  }

  @Test func `a one-way entry offers the from site's logins on the to site, never the reverse`() {
    let onAdobe = recommend("https://www.adobe.com")
    #expect(ids(onAdobe) == ["adobe", "behance"])
    #expect(onAdobe.last?.reason == .shared && onAdobe.last?.site == "behance.net")
    #expect(ids(recommend("https://www.behance.net")) == ["behance"])
    #expect(ids(recommend("https://id.atlassian.com")) == ["atlassianId", "trello"])
    #expect(ids(recommend("https://trello.com")) == ["trello"])
  }

  @Test func `a host named in the list matches only that host, not the rest of its registrable domain`() {
    #expect(!ids(recommend("https://start.atlassian.com")).contains("trello"))
  }

  @Test func `look-alikes and host-only logins never cross through a group`() {
    for origin in ["https://store.steampowered.com", "https://steamcommunity.com"] {
      let found = ids(recommend(origin))
      #expect(!found.contains("fakeCommunity") && !found.contains("fakeSuffix"))
    }
    #expect(!ids(recommend("https://store.steampowered.com")).contains("communityHost"))
    #expect(!ids(recommend("https://www.adobe.com")).contains("fakeAdobe"))
    #expect(ids(recommend("https://steamcommunity.co")) == ["fakeCommunity"])
    #expect(ids(recommend("https://steampowered.com.evil.io")) == ["fakeSuffix"])
  }

  @Test func `search lifts a group's logins on the page's site, one-way entries only on the to site`() {
    let creative = VaultCatalog([
      login("behance", "Creative", "a", ["https://www.behance.net"], updatedAt: 1), login("adobe", "Creative", "b", ["https://account.adobe.com"], updatedAt: 2),
      login("other", "Creative", "c", ["https://creative.example.org"], updatedAt: 9),
    ], ownProvider: "ardia")
    let search = { (origin: String) in creative.smartSearch("creative", origin: origin, limit: 5, filter: .everyProfile)?.map(\.id) ?? [] }
    #expect(search("https://www.adobe.com") == ["adobe", "behance", "other"])
    #expect(search("https://www.behance.net") == ["behance", "other", "adobe"])
  }
}

private let microsoftVault = [
  login("personal", "Microsoft account", "sam@outlook.com", ["https://login.live.com"]),
  login("xbox", "Xbox", "sam.x@outlook.com", ["https://www.xbox.com"]),
  login("work", "Work", "sam@contoso.com", ["https://login.microsoftonline.com"]),
  login("fake", "Microsoft", "sam@outlook.com", ["https://login.microsoftonline.co"]),
  login("fakeSuffix", "Microsoft", "sam@outlook.com", ["https://login.live.com.evil.io"]),
  login("learn", "Microsoft Learn", "dev@contoso.com", ["https://learn.microsoft.com"]),
]

@Suite("Ardia's Microsoft account supplement")
struct VaultMicrosoftSupplementTests {
  let catalog = VaultCatalog(microsoftVault, ownProvider: "ardia")

  func recommend(_ origin: String) -> [String] {
    ids(catalog.recommend(origin: origin, filter: .everyProfile, usage: .none, pageUsername: nil, remembered: nil))
  }

  @Test func `the supplement is kept apart from Apple's list and names nothing Apple's list does`() {
    #expect(!VaultSharedSitesData.ardiaText.isEmpty)
    let apple = Set(VaultSharedSitesData.text.split(whereSeparator: { ";,>".contains($0) }).map(String.init))
    #expect(VaultSharedSitesData.ardiaText.split(whereSeparator: { ";,>".contains($0) }).allSatisfy { !apple.contains(String($0)) })
  }

  @Test func `a personal login saved for live.com is offered on login.microsoftonline.com, after the page's own`() {
    let ranked = catalog.recommend(origin: "https://login.microsoftonline.com", filter: .everyProfile, usage: .none, pageUsername: nil, remembered: nil)
    #expect(ids(ranked) == ["work", "xbox", "personal"])
    #expect(ranked.first { $0.item.id == "personal" }?.reason == .shared)
    #expect(ranked.first { $0.item.id == "personal" }?.site == "live.com")
  }

  @Test func `personal account sites share their logins, and a work login never reaches them`() {
    #expect(recommend("https://login.live.com") == ["personal", "xbox"])
    #expect(recommend("https://www.xbox.com") == ["xbox", "personal"])
    #expect(recommend("https://outlook.live.com") == ["personal", "xbox"])
    #expect(!recommend("https://account.microsoft.com").contains("work"))
  }

  @Test func `only account.microsoft.com joins, not the rest of microsoft.com`() {
    #expect(recommend("https://account.microsoft.com") == ["learn", "xbox", "personal"])
    #expect(recommend("https://learn.microsoft.com") == ["learn"])
    #expect(!recommend("https://login.live.com").contains("learn"))
  }

  @Test func `look-alikes never match a Microsoft sign-in, and Google and YouTube stay apart`() {
    #expect(!recommend("https://login.microsoftonline.com").contains("fake"))
    #expect(!recommend("https://login.live.com").contains("fakeSuffix"))
    #expect(recommend("https://login.microsoftonline.co") == ["fake"])
    #expect(VaultSharedSites.sources(host: "accounts.google.com", site: "google.com").isEmpty)
    #expect(VaultSharedSites.sources(host: "www.youtube.com", site: "youtube.com").isEmpty)
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
