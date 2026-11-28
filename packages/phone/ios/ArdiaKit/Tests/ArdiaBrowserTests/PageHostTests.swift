import Foundation
import Testing
@testable import ArdiaBrowser

@Suite struct PageHostTests {
  @Test func hostsCompareLowercasedWithoutATrailingDot() {
    #expect(PageHost.key(URL(string: "https://Docs.Example.COM./a")) == "docs.example.com")
    #expect(PageHost.key(URL(string: "https://docs.example.com/b")) == "docs.example.com")
  }

  @Test func anInternationalHostComparesAsPunycode() {
    #expect(PageHost.key(URL(string: "https://xn--bcher-kva.example/")) == "xn--bcher-kva.example")
    #expect(PageHost.key(URL(string: "https://Bücher.example./")) == "xn--bcher-kva.example")
  }

  @Test func subdomainsAreDifferentHosts() {
    #expect(PageHost.key(URL(string: "https://www.ck/")) != PageHost.key(URL(string: "https://a.www.ck/")))
  }

  @Test func aPageWithoutAHostHasNone() {
    #expect(PageHost.key(URL(string: "about:blank")) == nil)
    #expect(PageHost.key(nil) == nil)
  }
}
