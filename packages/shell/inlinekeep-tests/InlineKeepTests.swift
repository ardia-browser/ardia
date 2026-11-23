import AppKit
import XCTest
@testable import ArdiaInlineKeepCore

final class InlineKeepTests: XCTestCase {
  private var tag = 100

  private func field(_ text: String, selected: NSRange) -> NSTextView {
    tag += 1
    let view = NSTextView(frame: .zero)
    view.isFieldEditor = true
    view.string = text
    view.setSelectedRange(selected)
    return view
  }

  func testAMatchingLetterMovesTheSelectionAndIsReportedOnce() {
    let editor = field("gmail.com", selected: NSRange(location: 1, length: 8))
    InlineKeep.arm(editor, tag: tag, typedLength: 1, keeps: true)
    XCTAssertTrue(InlineKeep.keeps(editor, inserting: "m", at: NSRange(location: NSNotFound, length: 0)))
    XCTAssertEqual(editor.string, "gmail.com")
    XCTAssertEqual(editor.selectedRange(), NSRange(location: 2, length: 7))
    XCTAssertEqual(InlineKeep.take(tag: tag, start: 2, end: 9), ["gm", "ail.com"])
    XCTAssertEqual(InlineKeep.take(tag: tag, start: 2, end: 9), [])
  }

  func testLettersKeepGoingUntilTheJSReadsThem() {
    let editor = field("gmail.com", selected: NSRange(location: 1, length: 8))
    InlineKeep.arm(editor, tag: tag, typedLength: 1, keeps: true)
    for letter in ["m", "a", "i"] { XCTAssertTrue(InlineKeep.keeps(editor, inserting: letter, at: NSRange(location: NSNotFound, length: 0))) }
    XCTAssertEqual(InlineKeep.take(tag: tag, start: 2, end: 9), ["gm", "ail.com"])
    XCTAssertEqual(InlineKeep.take(tag: tag, start: 4, end: 9), ["gmai", "l.com"])
  }

  func testAnAcceptedCompletionIsNotKeptWhenItsTailIsSelectedAgain() {
    let editor = field("gmail.com", selected: NSRange(location: 1, length: 8))
    InlineKeep.arm(editor, tag: tag, typedLength: 1, keeps: true)
    editor.setSelectedRange(NSRange(location: 9, length: 0))
    editor.setSelectedRange(NSRange(location: 1, length: 8))
    XCTAssertFalse(InlineKeep.keeps(editor, inserting: "m", at: NSRange(location: NSNotFound, length: 0)))
  }

  func testALetterThatDoesNotMatchOrAFieldThatDidNotOptInIsTypedNormally() {
    let editor = field("gmail.com", selected: NSRange(location: 1, length: 8))
    InlineKeep.arm(editor, tag: tag, typedLength: 1, keeps: true)
    XCTAssertFalse(InlineKeep.keeps(editor, inserting: "x", at: NSRange(location: NSNotFound, length: 0)))
    XCTAssertFalse(InlineKeep.keeps(editor, inserting: "M", at: NSRange(location: NSNotFound, length: 0)))
    let other = field("gmail.com", selected: NSRange(location: 1, length: 8))
    InlineKeep.arm(other, tag: tag, typedLength: 1, keeps: false)
    XCTAssertFalse(InlineKeep.keeps(other, inserting: "m", at: NSRange(location: NSNotFound, length: 0)))
  }
}
