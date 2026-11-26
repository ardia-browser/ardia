import Testing

private let chromiumAnswers: [String: String] = [
  "accounts.example.com": "example.com", "a.accounts.example.com": "example.com", "example.com": "example.com", "a.example.com": "example.com",
  "bbc.co.uk": "bbc.co.uk", "a.bbc.co.uk": "bbc.co.uk", "news.bbc.co.uk": "bbc.co.uk",
  "a.github.io": "a.github.io", "a.a.github.io": "a.github.io", "b.github.io": "b.github.io", "a.b.github.io": "b.github.io",
  "accounts.example.localhost": "accounts.example.localhost", "a.accounts.example.localhost": "a.accounts.example.localhost",
  "example.localhost": "example.localhost", "other.localhost": "other.localhost",
]

private func site(_ host: String) -> String { ApplePasswordsMatch.site(host, domains: chromiumAnswers) }

@Suite struct ApplePasswordsMatching {
  @Test func `a login's site is the registrable domain, public-suffix aware, with an unknown suffix taken as one label`() {
    #expect(site("accounts.example.com") == "example.com")
    #expect(site("news.bbc.co.uk") == "bbc.co.uk")
    #expect(site("bbc.co.uk") == "bbc.co.uk")
    #expect(site("a.github.io") != site("b.github.io"))
    #expect(site("accounts.example.localhost") == "example.localhost")
    #expect(site("other.localhost") == "other.localhost")
    #expect(site("127.0.0.1") == "127.0.0.1")
    #expect(site("localhost") == "localhost")
  }

  @Test func `the probes ask Chromium about each host and, for a deep one, one label deeper`() {
    let probes = ApplePasswordsMatch.probes(["accounts.example.com", "example.com", "127.0.0.1"])
    #expect(Set(probes) == ["accounts.example.com", "a.accounts.example.com", "example.com", "127.0.0.1"])
  }

  private let entries = [
    ApplePasswordsEntry(user: "grace", sites: ["example.localhost"]),
    ApplePasswordsEntry(user: "ada", sites: ["https://example.localhost"]),
    ApplePasswordsEntry(user: "linus", sites: ["other.localhost"]),
    ApplePasswordsEntry(user: "plain", sites: ["http://example.localhost"]),
    ApplePasswordsEntry(user: "ada", sites: ["accounts.example.localhost"]),
  ]

  @Test func `an https page lists the site's https logins once each, sorted, and never another site's`() {
    let found = ApplePasswordsMatch.logins(entries, scheme: "https", host: "accounts.example.localhost", domains: chromiumAnswers)
    #expect(found == [.init(user: "ada", insecure: false), .init(user: "grace", insecure: false)])
  }

  @Test func `an http page lists only logins saved for http, each marked insecure`() {
    let found = ApplePasswordsMatch.logins(entries, scheme: "http", host: "example.localhost", domains: chromiumAnswers)
    #expect(found == [.init(user: "plain", insecure: true)])
  }

  @Test func `an entry with no sites counts as the host it was asked for, over https`() {
    let bare = [ApplePasswordsEntry(user: "nobody", sites: [])]
    #expect(ApplePasswordsMatch.logins(bare, scheme: "https", host: "example.localhost", domains: chromiumAnswers).map(\.user) == ["nobody"])
    #expect(ApplePasswordsMatch.logins(bare, scheme: "http", host: "example.localhost", domains: chromiumAnswers).isEmpty)
  }

  @Test func `a frame is on the page's site only when both registrable domains agree`() {
    #expect(ApplePasswordsMatch.sameSite("accounts.example.localhost", "example.localhost", domains: chromiumAnswers))
    #expect(!ApplePasswordsMatch.sameSite("other.localhost", "example.localhost", domains: chromiumAnswers))
  }
}
