import Foundation
import Testing

private let secret = "otpauth://totp/Example:sam?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Example"

private func login(_ id: String, _ url: String, hasTotp: Bool? = nil, updatedAt: Double = 1) -> VaultItem {
  VaultItem(provider: "1password", id: id, title: id, username: "sam", urls: [url], hasTotp: hasTotp, updatedAt: updatedAt)
}

private func plan(_ items: [VaultItem], cached: [String: VaultCacheSnapshot.Password] = [:], tried: Set<String> = [], urgent: Set<String> = [],
                  focus: String? = nil, sweepLeft: Int = VaultTotpWarmPlan.sweepLimit, limit: Int = 50) -> [String] {
  VaultTotpWarmPlan.order(items, cached: cached, tried: tried, urgent: urgent, focusSite: focus, sweepLeft: sweepLeft, limit: limit).map(\.id)
}

@Suite("Verification code warm-up")
struct VaultTotpWarmTests {
  @Test func `the codes a menu asked for go first, then the page's site, then logins known to have codes, newest first, then the rest`() {
    let items = [
      login("old-code", "https://bank.example.org", hasTotp: true, updatedAt: 1), login("new-code", "https://shop.example.net", hasTotp: true, updatedAt: 9),
      login("other", "https://other.example.com", updatedAt: 5), login("site-a", "https://accounts.google.com", updatedAt: 2),
      login("site-b", "https://mail.google.com", updatedAt: 3), login("asked", "https://other.example.com", updatedAt: 1),
    ]
    #expect(plan(items, urgent: ["asked"], focus: "google.com") == ["asked", "site-b", "site-a", "new-code", "old-code", "other"])
  }

  @Test func `a look-alike host is not the page's site`() {
    let items = [login("fake", "https://g00gle.com"), login("real", "https://accounts.google.com")]
    #expect(plan(items, focus: "google.com", sweepLeft: 0) == ["real"])
  }

  @Test func `a login already warmed, known to have no code, or tried this run is skipped`() {
    let items = [login("warm", "https://a.example"), login("none", "https://b.example"), login("listedNone", "https://c.example", hasTotp: false),
                 login("tried", "https://d.example"), login("left", "https://e.example")]
    let cached = ["warm": VaultCacheSnapshot.Password(value: secret, itemUpdatedAt: 1), "none": VaultCacheSnapshot.Password(value: VaultTotpWarmPlan.absent, itemUpdatedAt: 1)]
    #expect(plan(items, cached: cached, tried: ["tried"]) == ["left"])
  }

  @Test func `a login edited since its code was read is warmed again, and the stale secret makes no code`() {
    let edited = login("edited", "https://a.example", updatedAt: 2)
    let stale = ["edited": VaultCacheSnapshot.Password(value: secret, itemUpdatedAt: 1)]
    #expect(VaultTotpWarmPlan.knowledge(of: edited, cached: stale["edited"]) == .unknown)
    #expect(plan([edited], cached: stale) == ["edited"])
    let fresh = VaultTotpWarmPlan.entry(for: secret, item: edited)
    #expect(VaultTotpWarmPlan.knowledge(of: edited, cached: fresh) == .secret)
  }

  @Test func `a read that finds no secret is remembered as no code, and a one-time code is never kept as a secret`() {
    let item = login("x", "https://a.example", updatedAt: 3)
    #expect(VaultTotpWarmPlan.knowledge(of: item, cached: VaultTotpWarmPlan.entry(for: nil, item: item)) == .none)
    #expect(VaultTotpWarmPlan.knowledge(of: item, cached: VaultTotpWarmPlan.entry(for: "123456", item: item)) == .none)
  }

  @Test func `the sweep over logins of unknown kind stops at its budget, while the page's site and known codes keep going`() {
    let unknown = (0..<10).map { login("u\($0)", "https://u\($0).example", updatedAt: Double($0)) }
    let known = login("k", "https://k.example", hasTotp: true)
    let site = login("s", "https://www.google.com")
    #expect(plan(unknown + [known, site], focus: "google.com", sweepLeft: 2) == ["s", "k", "u9", "u8"])
    #expect(plan(unknown + [known], sweepLeft: 0) == ["k"])
  }

  @Test func `a locked store has nothing cached, so after unlock every login is asked about again and none reads as known`() {
    let items = [login("a", "https://a.example", hasTotp: true), login("b", "https://b.example", hasTotp: true)]
    #expect(plan(items, cached: [:]) == ["a", "b"])
  }

  @Test(.timeLimit(.minutes(1)))
  func `planning a page over 25,000 logins with 2,000 codes takes milliseconds`() {
    let items = (0..<25_000).map { login("i\($0)", "https://site\($0 % 5000).example\($0 % 7).com/login", hasTotp: $0 % 12 == 0 ? true : nil, updatedAt: Double($0)) }
    let clock = ContinuousClock()
    var page: [String] = []
    let took = clock.measure { page = plan(items, focus: "example3.com", limit: VaultTotpWarmPlan.page) }
    #expect(page.count == VaultTotpWarmPlan.page)
    #expect(took < .milliseconds(400), "planning took \(took)")
  }
}
