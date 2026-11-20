import XCTest
@testable import ArdiaTextCore

final class ChromeWordBreaksTests: XCTestCase {
  private static let segmentsFromChromiumIntlSegmenter: [(String, [Range<Int>])] = [
    ("www.example.com", [0..<3, 4..<11, 12..<15]),
    ("github.com/a/b", [0..<6, 7..<10, 11..<12, 13..<14]),
    ("https://x.com/a?b=1", [0..<5, 8..<9, 10..<13, 14..<15, 16..<17, 18..<19]),
    ("123.456.879", [0..<11]),
    ("1.2.3.4", [0..<7]),
    ("a.1", [0..<1, 2..<3]),
    ("1.a", [0..<1, 2..<3]),
    ("v1.2", [0..<4]),
    ("a1.2b", [0..<5]),
    ("ab.c1", [0..<2, 3..<5]),
    ("a.b.1", [0..<1, 2..<3, 4..<5]),
    ("don't", [0..<5]),
    ("don\u{2019}t", [0..<5]),
    ("a:b", [0..<1, 2..<3]),
    ("foo@bar.com", [0..<3, 4..<7, 8..<11]),
    ("a_b", [0..<3]),
    ("a-b", [0..<1, 2..<3]),
    ("x.com:8080/p", [0..<1, 2..<5, 6..<10, 11..<12]),
    ("caf\u{E9}.fr", [0..<4, 5..<7]),
    ("cafe\u{301}.fr", [0..<5, 6..<8]),
    ("hello world", [0..<5, 6..<11]),
    ("a,b", [0..<1, 2..<3]),
    ("1,000.5", [0..<7]),
    ("a\u{FF0E}b", [0..<1, 2..<3]),
    ("a\u{FE52}b", [0..<3]),
    ("a\u{2024}b", [0..<3]),
    ("1\u{FF0E}2", [0..<3]),
    ("\u{5D0}.\u{5D1}", [0..<1, 2..<3]),
    ("a..b", [0..<1, 3..<4]),
    ("1..2", [0..<1, 3..<4]),
    (".com", [1..<4]),
    ("example.", [0..<7]),
    ("mail.google.com/mail/u/0/#inbox", [0..<4, 5..<11, 12..<15, 16..<20, 21..<22, 23..<24, 26..<31]),
    ("https://en.wikipedia.org/wiki/Foo_(bar)", [0..<5, 8..<10, 11..<20, 21..<24, 25..<29, 30..<34, 35..<38]),
    ("192.168.0.1:3000", [0..<11, 12..<16]),
    ("localhost:3000", [0..<9, 10..<14]),
    ("ex-ample.co.uk", [0..<2, 3..<8, 9..<11, 12..<14]),
    ("user@sub.example.org", [0..<4, 5..<8, 9..<16, 17..<20]),
    ("a.b-c.d", [0..<1, 2..<3, 4..<5, 6..<7]),
    ("foo.bar_baz", [0..<3, 4..<11]),
    ("\u{1F600}.com", [3..<6]),
    ("x.y\u{200D}z", [0..<1, 2..<5]),
    ("1\u{301}.2", [0..<4]),
    ("a'b.c", [0..<3, 4..<5]),
    ("Foo.Bar", [0..<3, 4..<7]),
    ("\u{391}\u{392}.\u{393}\u{394}", [0..<2, 3..<5]),
    ("\u{43F}\u{440}\u{438}\u{432}\u{435}\u{442}.\u{440}\u{444}", [0..<6, 7..<9]),
  ]

  private func deletingWordsBackward(_ text: String) -> [String] {
    var text = text
    var steps: [String] = []
    while !text.isEmpty {
      let caret = (text as NSString).length
      text = (text as NSString).substring(to: ChromeWordBreaks.wordStart(before: caret, in: text))
      steps.append(text)
    }
    return steps
  }

  private func deletingWordsForward(_ text: String) -> [String] {
    var text = text
    var steps: [String] = []
    while !text.isEmpty {
      text = (text as NSString).substring(from: ChromeWordBreaks.wordEnd(after: 0, in: text))
      steps.append(text)
    }
    return steps
  }

  func testWordsMatchChromiumsIcuForEverySample() {
    for (text, expected) in Self.segmentsFromChromiumIntlSegmenter {
      XCTAssertEqual(ChromeWordBreaks.words(in: text), expected, text)
    }
  }

  func testOptionDeleteStopsAtEachDotInAHostname() {
    XCTAssertEqual(deletingWordsBackward("www.example.com"), ["www.example.", "www.", ""])
  }

  func testOptionDeleteWalksBackThroughAPath() {
    XCTAssertEqual(deletingWordsBackward("github.com/a/b"), ["github.com/a/", "github.com/", "github.", ""])
  }

  func testOptionDeleteTakesTrailingPunctuationWithTheWordBeforeIt() {
    XCTAssertEqual(
      deletingWordsBackward("https://x.com/a?b=1"),
      ["https://x.com/a?b=", "https://x.com/a?", "https://x.com/", "https://x.", "https://", ""])
  }

  func testDigitsJoinedByDotsAreOneWord() {
    XCTAssertEqual(deletingWordsBackward("123.456.879"), [""])
    XCTAssertEqual(deletingWordsBackward("1.2.3.4"), [""])
    XCTAssertEqual(deletingWordsBackward("192.168.0.1:3000"), ["192.168.0.1:", ""])
  }

  func testForwardDeleteStopsAtTheEndOfEachLabel() {
    XCTAssertEqual(deletingWordsForward("www.example.com"), [".example.com", ".com", ""])
  }

  func testMovesFromTheMiddleOfAWord() {
    XCTAssertEqual(ChromeWordBreaks.wordStart(before: 7, in: "www.example.com"), 4)
    XCTAssertEqual(ChromeWordBreaks.wordEnd(after: 7, in: "www.example.com"), 11)
    XCTAssertEqual(ChromeWordBreaks.wordStart(before: 4, in: "www.example.com"), 0)
    XCTAssertEqual(ChromeWordBreaks.wordEnd(after: 11, in: "www.example.com"), 15)
  }

  func testEdgesStayPut() {
    XCTAssertEqual(ChromeWordBreaks.wordStart(before: 0, in: "www.example.com"), 0)
    XCTAssertEqual(ChromeWordBreaks.wordEnd(after: 15, in: "www.example.com"), 15)
    XCTAssertEqual(ChromeWordBreaks.wordStart(before: 3, in: "://"), 0)
    XCTAssertEqual(ChromeWordBreaks.wordEnd(after: 0, in: "://"), 3)
    XCTAssertEqual(ChromeWordBreaks.wordStart(before: 0, in: ""), 0)
    XCTAssertEqual(ChromeWordBreaks.wordEnd(after: 0, in: ""), 0)
  }

  func testOffsetsAreUtf16() {
    XCTAssertEqual(ChromeWordBreaks.wordStart(before: 6, in: "😀.com"), 3)
    XCTAssertEqual(ChromeWordBreaks.wordStart(before: 3, in: "😀.com"), 0)
    XCTAssertEqual(ChromeWordBreaks.words(in: "𝟏.𝟐"), [0..<5])
  }

  func testStockBreaksKeepAHostnameWhole() {
    XCTAssertEqual(ChromeWordBreaks.words(in: "www.example.com", splittingLetterStops: false), [0..<15])
    XCTAssertEqual(ChromeWordBreaks.stop(forward: false, from: 15, in: "www.example.com", splittingLetterStops: false), 0)
    XCTAssertEqual(ChromeWordBreaks.stop(forward: false, from: 15, in: "www.example.com"), 12)
    XCTAssertEqual(ChromeWordBreaks.stop(forward: true, from: 0, in: "www.example.com"), 3)
  }

  func testShiftOptionLeftFromTheEndSelectsTheLastLabel() {
    let extended = ChromeWordBreaks.extend(15..<15, keptAnchor: nil, activeEndAtStart: false, forward: false, in: "www.example.com")
    XCTAssertEqual(extended, ChromeWordBreaks.Extension(anchor: 15, from: 15, stop: 12))
    XCTAssertEqual(extended.range, 12..<15)
    let again = ChromeWordBreaks.extend(extended.range, keptAnchor: extended.anchor, activeEndAtStart: false, forward: false, in: "www.example.com")
    XCTAssertEqual(again.range, 4..<15)
  }

  func testAFreshSelectionGrowsFromItsActiveEnd() {
    let shrunk = ChromeWordBreaks.extend(12..<15, keptAnchor: nil, activeEndAtStart: false, forward: false, in: "www.example.com")
    XCTAssertEqual(shrunk, ChromeWordBreaks.Extension(anchor: 12, from: 15, stop: 12))
    XCTAssertEqual(shrunk.range, 12..<12)
    let grown = ChromeWordBreaks.extend(12..<15, keptAnchor: nil, activeEndAtStart: true, forward: false, in: "www.example.com")
    XCTAssertEqual(grown.range, 4..<15)
  }

  func testAKeptAnchorOffTheSelectionIsIgnored() {
    let extended = ChromeWordBreaks.extend(4..<11, keptAnchor: 15, activeEndAtStart: false, forward: true, in: "www.example.com")
    XCTAssertEqual(extended, ChromeWordBreaks.Extension(anchor: 4, from: 11, stop: 15))
  }

  func testCollapsingASelectionCountsAsAMoveEvenWhenTheCaretStaysAtTheEdge() {
    let text = "www.example.com"
    let right = ChromeWordBreaks.stop(forward: true, from: 15, in: text)
    XCTAssertEqual(right, 15)
    XCTAssertTrue(ChromeWordBreaks.countsAsWordMove(from: 0..<15, to: right..<right))
    let left = ChromeWordBreaks.stop(forward: false, from: 0, in: text)
    XCTAssertEqual(left, 0)
    XCTAssertTrue(ChromeWordBreaks.countsAsWordMove(from: 0..<15, to: left..<left))
    XCTAssertFalse(ChromeWordBreaks.countsAsWordMove(from: 15..<15, to: right..<right))
    XCTAssertFalse(ChromeWordBreaks.countsAsWordMove(from: 0..<0, to: left..<left))
    let held = ChromeWordBreaks.extend(0..<15, keptAnchor: 0, activeEndAtStart: false, forward: true, in: text)
    XCTAssertFalse(ChromeWordBreaks.countsAsWordMove(from: 0..<15, to: held.range))
  }

  func testRightToLeftTextIsNoticed() {
    XCTAssertTrue(ChromeWordBreaks.containsRightToLeftText("שלום.com"))
    XCTAssertTrue(ChromeWordBreaks.containsRightToLeftText("مثال.com"))
    XCTAssertFalse(ChromeWordBreaks.containsRightToLeftText("www.example.com"))
    XCTAssertFalse(ChromeWordBreaks.containsRightToLeftText("привет.рф"))
  }
}
