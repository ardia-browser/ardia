import AppKit
import ArdiaCore
import ExpoModulesCore

public class FocusModule: Module, FocusNative {
  private static var pendingUIOwner: ObjectIdentifier?

  private let lifetime = ModuleLifetime()
  private var switcherMonitor: Any?
  private var dragEscapeMonitor: Any?
  private var unclaimedEscapeMonitor: Any?
  private let switcherPointer = SwitcherPointer()

  static func pressesWithoutRelease() -> Int { PressRelease.pressesWithoutRelease }

  static func takeFocusHandoffCounts() -> [String: [String: Int]] { FocusHandoff.shared.takeOutcomes() }

  static func setConsentEpoch(_ epoch: String) {
    ArdiaEvents.consentEpoch = epoch
    FocusHandoff.shared.setConsentEpoch(epoch)
    let setEpoch = NSSelectorFromString("ardia_setConsentEpoch:")
    if let view = NSClassFromString("RCTView") as AnyObject?, view.responds(to: setEpoch) { _ = view.perform(setEpoch, with: epoch) }
    PressRelease.forgetPresses()
  }

  static func pressRepeated() -> [String: Any]? { PressRelease.pressRepeated }

  static func takeEditKeyAcks() -> [String: Int] { FocusHandoff.shared.takeEditKeyAcks() }

  static func takeInputSourceKeys() -> Int { InputSourceKeys.takeWebKitTabKeys() }

  static func cancelFocusMove(_ generation: Int, _ restoringSource: Bool) { FocusHandoff.shared.cancel(generation, restoringSource: restoringSource) }

  func claimFocus(_ generation: Int, _ tag: Int) {
    guard let view = appContext?.findView(withTag: tag, ofType: NSView.self) else { return }
    FocusHandoff.shared.claim(generation, destination: view)
  }

  static func saveKeyResponder(_ windowId: String) -> Int { SavedKeyResponders.shared.save(WindowManager.shared.window(windowId)) }

  static func restoreKeyResponder(_ token: Int) -> Bool { SavedKeyResponders.shared.restore(token) }

  static func discardKeyResponder(_ token: Int) { SavedKeyResponders.shared.discard(token) }

  func setSwitcherCapture(_ active: Bool) {
    lifetime.run { self.applySwitcherCapture(active) }
  }

  func setDragEscapeCapture(_ active: Bool) {
    lifetime.run { self.applyDragEscapeCapture(active) }
  }

  static func takeHoverCounts() -> [String: [String: Int]] {
    let take = NSSelectorFromString("ardia_takeHoverCounts")
    guard let view = NSClassFromString("RCTView") as AnyObject?, view.responds(to: take),
      let taken = view.perform(take)?.takeUnretainedValue() as? [String: [String: NSNumber]]
    else { return [:] }
    return taken.mapValues { $0.mapValues(\.intValue) }
  }

  func switcherPointerMoved() -> Bool { switcherPointer.moved(to: SwitcherPointer.location) }

  public func definition() -> ModuleDefinition {
    Name(Self.moduleName)

    OnCreate {
      self.lifetime.begin(self) {
        if let monitor = self.switcherMonitor { NSEvent.removeMonitor(monitor) }
        self.switcherMonitor = nil
        if let monitor = self.dragEscapeMonitor { NSEvent.removeMonitor(monitor) }
        self.dragEscapeMonitor = nil
        if let monitor = self.unclaimedEscapeMonitor { NSEvent.removeMonitor(monitor) }
        self.unclaimedEscapeMonitor = nil
        if Self.pendingUIOwner == ObjectIdentifier(self) {
          Self.pendingUIOwner = nil
          FocusHandoff.shared.afterPendingUI = { DispatchQueue.main.async(execute: $0) }
        }
      }
      self.lifetime.onMain { [weak self] in
        guard let self else { return }
        FocusHandoff.shared.install()
        self.watchUnclaimedEscape()
        if let queue = self.appContext?.reactBridge?.uiManager?.methodQueue {
          FocusHandoff.shared.afterPendingUI = { block in queue.async { DispatchQueue.main.async(execute: block) } }
          Self.pendingUIOwner = ObjectIdentifier(self)
        }
      }
    }

    OnDestroy { self.lifetime.end() }

    Self.pressesWithoutReleaseFunction
    Self.takeFocusHandoffCountsFunction
    Self.setConsentEpochFunction
    Self.pressRepeatedFunction
    Self.takeEditKeyAcksFunction
    Self.takeInputSourceKeysFunction
    Self.cancelFocusMoveFunction
    claimFocusFunction
    Self.saveKeyResponderFunction
    Self.restoreKeyResponderFunction
    Self.discardKeyResponderFunction

    setSwitcherCaptureFunction

    setDragEscapeCaptureFunction

    Self.takeHoverCountsFunction
    switcherPointerMovedFunction
  }

  private func applySwitcherCapture(_ active: Bool) {
    if let monitor = switcherMonitor { NSEvent.removeMonitor(monitor) }
    switcherMonitor = nil
    switcherPointer.start(active ? SwitcherPointer.location : nil)
    guard active else { return }
    let emit: ([String: Any]) -> Void = { ShellEvents.send(.app, $0) }
    switcherMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseUp, .rightMouseUp, .otherMouseUp]) { event in
      guard event.type == .keyDown else {
        emit(["type": "switcherMouseUp"])
        return event
      }
      if MainMenu.isSwitcherKey(event) { return event }
      switch event.keyCode {
      case 53: emit(["type": "switcherKey", "key": "escape"])
      case 124: emit(["type": "switcherKey", "key": "next"])
      case 123: emit(["type": "switcherKey", "key": "previous"])
      case _ where event.charactersIgnoringModifiers?.lowercased() == "w" && !event.isARepeat && !event.modifierFlags.intersection([.control, .command]).isEmpty:
        emit(["type": "switcherKey", "key": "close"])
      default: break
      }
      return nil
    }
  }

  private func watchUnclaimedEscape() {
    guard unclaimedEscapeMonitor == nil else { return }
    unclaimedEscapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
      let modifiers = event.modifierFlags.intersection([.command, .option, .control, .shift])
      guard let self, event.keyCode == 53, modifiers.isEmpty, !event.isARepeat, self.dragEscapeMonitor == nil, self.switcherMonitor == nil,
        let window = event.window, window.firstResponder === window, let id = WindowManager.shared.id(of: window)
      else { return event }
      ShellEvents.send(.app, ["type": "unclaimedEscape", "windowId": id])
      return event
    }
  }

  private func applyDragEscapeCapture(_ active: Bool) {
    if let monitor = dragEscapeMonitor { NSEvent.removeMonitor(monitor) }
    dragEscapeMonitor = nil
    guard active else { return }
    let emit: ([String: Any]) -> Void = { ShellEvents.send(.app, $0) }
    dragEscapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
      let modifiers = event.modifierFlags.intersection([.command, .option, .control, .shift])
      guard event.keyCode == 53 || event.charactersIgnoringModifiers == "\u{1b}", modifiers.isEmpty else { return event }
      emit(["type": "dragEscape"])
      return nil
    }
  }
}
