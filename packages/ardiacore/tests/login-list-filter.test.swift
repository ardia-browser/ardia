import Foundation
import Testing

private func shown(_ names: [String], _ typed: String) -> [String] {
  LoginListFilter.hits(names, typed: typed).map { names[$0.index] }
}

@Suite struct LoginListFiltering {
  private let fixtures = ["anna@example.test", "Ännabel", "bob", "joanna.k@mail.test"]

  @Test func `typing keeps the names that contain it, ignoring case and accents, starts-with first`() {
    #expect(shown(fixtures, "an") == ["anna@example.test", "Ännabel", "joanna.k@mail.test"])
    #expect(shown(fixtures, "ÄN") == ["anna@example.test", "Ännabel", "joanna.k@mail.test"])
    #expect(shown(fixtures, "zzz") == [])
  }

  @Test func `nothing typed keeps every name in its order with nothing marked`() {
    let hits = LoginListFilter.hits(fixtures, typed: "")
    #expect(hits.map(\.index) == [0, 1, 2, 3])
    #expect(hits.allSatisfy { $0.bold.length == 0 })
  }

  @Test func `a word start after @ . _ - or a space ranks between starts-with and anywhere, stable within each rank`() {
    let names = ["joanna", "bo.anna", "anne", "jo_an", "banana-ann", "x@an", "an", "li an", "kan-x"]
    #expect(shown(names, "an") == ["anne", "an", "bo.anna", "jo_an", "banana-ann", "x@an", "li an", "joanna", "kan-x"])
  }

  @Test func `the marked run is the matched text as the name spells it, at its best-ranked place`() {
    let names = ["Ännabel", "banana-ann", "joanna.k@mail.test", "e\u{301}mile"]
    let bold = { (typed: String) in LoginListFilter.hits(names, typed: typed).map { (names[$0.index] as NSString).substring(with: $0.bold) } }
    #expect(bold("an") == ["Än", "an", "an"])
    #expect(bold("ANN") == ["Änn", "ann", "ann"])
    #expect(bold("em") == ["e\u{301}m"])
  }
}
