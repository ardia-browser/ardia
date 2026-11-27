import AppKit
import XCTest
@testable import ArdiaUpdaterCore

final class KeyRepeatGateTests: XCTestCase {
  private final class Target: NSObject {
    var currentEvent: NSEvent?
    var invocations = 0
    var dispatches = 0

    @objc func run(_ sender: NSMenuItem) {
      invocations += 1
      if KeyRepeatGate.dispatches("focusCommandBar", fallback: currentEvent) { dispatches += 1 }
    }
  }

  override func setUp() {
    super.setUp()
    _ = NSApplication.shared
  }

  private func key(_ type: NSEvent.EventType, repeated: Bool = false) -> NSEvent {
    NSEvent.keyEvent(
      with: type, location: .zero, modifierFlags: .command, timestamp: 1, windowNumber: 0,
      context: nil, characters: "l", charactersIgnoringModifiers: "l", isARepeat: repeated, keyCode: 37)!
  }

  private func commandBarMenu(target: Target) -> KeyEquivalentMenu {
    let main = KeyEquivalentMenu()
    let file = KeyEquivalentMenu(title: "File")
    let item = NSMenuItem(title: "Open Command Bar", action: #selector(Target.run(_:)), keyEquivalent: "l")
    item.keyEquivalentModifierMask = .command
    item.target = target
    file.addItem(item)
    let root = NSMenuItem(title: "File", action: nil, keyEquivalent: "")
    root.submenu = file
    main.addItem(root)
    return main
  }

  func testAHeldOpenCommandBarKeyRunsOnceAndAFreshPressRunsAgain() {
    let presses = [false, true, true, false].map { KeyRepeatGate.dispatches("focusCommandBar", keyDown: true, repeated: $0) }
    XCTAssertEqual(presses, [true, false, false, true])
  }

  func testOtherCommandsAndMenuClicksStillRepeat() {
    XCTAssertTrue(KeyRepeatGate.dispatches("nextTab", keyDown: true, repeated: true))
    XCTAssertTrue(KeyRepeatGate.dispatches("focusCommandBar", keyDown: false, repeated: false))
    XCTAssertTrue(KeyRepeatGate.dispatches("focusCommandBar", fallback: nil))
  }

  func testForwardedRepeatAfterKeyUpIsDroppedEvenWhenCurrentEventIsKeyUp() {
    let target = Target()
    let menu = commandBarMenu(target: target)
    target.currentEvent = key(.keyUp)

    XCTAssertTrue(menu.performKeyEquivalent(with: key(.keyDown, repeated: true)))
    XCTAssertEqual(target.invocations, 1)
    XCTAssertEqual(target.dispatches, 0)
    XCTAssertTrue(KeyRepeatGate.dispatches("focusCommandBar", fallback: target.currentEvent))
  }

  func testForwardedFreshKeyDownDispatchesEvenWhileALaterRepeatIsCurrent() {
    let target = Target()
    let menu = commandBarMenu(target: target)
    target.currentEvent = key(.keyDown, repeated: true)

    XCTAssertTrue(menu.performKeyEquivalent(with: key(.keyDown, repeated: false)))
    XCTAssertEqual(target.invocations, 1)
    XCTAssertEqual(target.dispatches, 1)
    XCTAssertFalse(KeyRepeatGate.dispatches("focusCommandBar", fallback: target.currentEvent))
  }
}
