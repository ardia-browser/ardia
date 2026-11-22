import XCTest
@testable import ArdiaUpdaterCore

final class GlobalChordRuleTests: XCTestCase {
  func testAnUnmodifiedFunctionKeyRegisters() {
    XCTAssertTrue(GlobalChordRule.registrable(key: "\u{F709}", modifiers: 0))
    XCTAssertTrue(GlobalChordRule.registrable(key: "\u{F704}", modifiers: GlobalChordRule.shift))
  }

  func testAPlainOrShiftedLetterDoesNotRegister() {
    XCTAssertFalse(GlobalChordRule.registrable(key: "n", modifiers: 0))
    XCTAssertFalse(GlobalChordRule.registrable(key: "N", modifiers: GlobalChordRule.shift))
    XCTAssertFalse(GlobalChordRule.registrable(key: "\u{F700}", modifiers: 0))
  }

  func testCommandOrControlChordsRegister() {
    XCTAssertTrue(GlobalChordRule.registrable(key: "n", modifiers: GlobalChordRule.modifiers(command: true, option: true, control: false, shift: false)))
    XCTAssertTrue(GlobalChordRule.registrable(key: "n", modifiers: GlobalChordRule.control))
  }

  func testFnOnAnOrdinaryKeyNeverRegistersSinceCarbonCannotHoldIt() {
    let commandN = GlobalChordRule.modifiers(command: true, option: false, control: false, shift: false)
    XCTAssertFalse(GlobalChordRule.registrable(key: "n", modifiers: commandN, function: true))
    XCTAssertTrue(GlobalChordRule.registrable(key: "n", modifiers: commandN, function: false))
    XCTAssertTrue(GlobalChordRule.registrable(key: "\u{F709}", modifiers: 0, function: true))
  }

  func testModifiersMapToCarbonBits() {
    XCTAssertEqual(GlobalChordRule.modifiers(command: true, option: true, control: false, shift: false), 2304)
    XCTAssertEqual(GlobalChordRule.modifiers(command: false, option: false, control: true, shift: true), 0x1200)
    XCTAssertEqual(GlobalChordRule.modifiers(command: false, option: false, control: false, shift: false), 0)
  }
}
