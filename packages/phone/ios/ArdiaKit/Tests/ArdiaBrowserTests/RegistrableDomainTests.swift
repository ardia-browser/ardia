import Testing
@testable import ArdiaBrowser

@Suite struct RegistrableDomainTests {
  @Test func aHostReducesToTheDomainAPersonRegistered() {
    #expect(RegistrableDomain.of("www.example.com") == "example.com")
    #expect(RegistrableDomain.of("news.bbc.co.uk") == "bbc.co.uk")
    #expect(RegistrableDomain.of("Docs.Example.COM") == "example.com")
  }

  @Test func eachPagesSiteIsItsOwn() {
    #expect(RegistrableDomain.of("alice.github.io") == "alice.github.io")
    #expect(RegistrableDomain.of("alice.github.io") != RegistrableDomain.of("bob.github.io"))
  }

  @Test func addressesAndSingleLabelsStayAsTheyAre() {
    #expect(RegistrableDomain.of("localhost") == "localhost")
    #expect(RegistrableDomain.of("127.0.0.1") == "127.0.0.1")
    #expect(RegistrableDomain.of("com") == "com")
  }
}
