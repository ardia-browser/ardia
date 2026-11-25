import XCTest
@testable import ArdiaUpdaterCore

final class MouseShortcutTableTests: XCTestCase {
  private let command: UInt = 1 << 20
  private let shift: UInt = 1 << 17
  private let capsLock: UInt = 1 << 16
  private let numericPad: UInt = 1 << 21

  func testNoBindingsMeansAnEmptyTableThatMatchesNothing() {
    let table = MouseShortcutTable([:])
    XCTAssertTrue(table.isEmpty)
    XCTAssertNil(table.command(button: 2, modifierFlags: 0))
  }

  func testAMiddleClickBindingMatchesOnlyThatButtonWithThoseModifiers() {
    let table = MouseShortcutTable(["closeTab": ["mouse:middle"], "goBack": ["mouse:4", "command"]])
    XCTAssertFalse(table.isEmpty)
    XCTAssertEqual(table.command(button: 2, modifierFlags: 0), "closeTab")
    XCTAssertEqual(table.command(button: 2, modifierFlags: capsLock | numericPad), "closeTab")
    XCTAssertNil(table.command(button: 2, modifierFlags: shift))
    XCTAssertEqual(table.command(button: 3, modifierFlags: command), "goBack")
    XCTAssertNil(table.command(button: 3, modifierFlags: 0))
    XCTAssertNil(table.command(button: 4, modifierFlags: 0))
  }

  func testLeftRightAndUnknownButtonsAndKeysAreNeverBound() {
    let table = MouseShortcutTable(["a": ["mouse:0"], "b": ["mouse:1"], "c": ["t", "command"], "d": ["mouse:9"], "e": []])
    XCTAssertTrue(table.isEmpty)
    XCTAssertNil(table.command(button: 0, modifierFlags: 0))
    XCTAssertNil(table.command(button: 1, modifierFlags: 0))
    XCTAssertNil(table.command(button: 9, modifierFlags: 0))
  }

  func testRecordedModifiersAreNamedInTheAppsOrder() {
    XCTAssertEqual(MouseShortcutTable.modifierNames(command | shift | capsLock), ["shift", "command"])
    XCTAssertEqual(MouseShortcutTable.modifierNames(0), [])
  }
}
