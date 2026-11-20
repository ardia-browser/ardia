import AppKit

enum VaultCopyResult: Sendable, Equatable {
  case copied
  case declined
  case refused(VaultFillError)
  case clipboardFailed

  func jsonObject() -> [String: Any] {
    switch self {
    case .copied: return ["copied": true, "clearsAfter": VaultClipboard.clearDelay]
    case .declined: return ["copied": false, "declined": true, "clearsAfter": 0]
    case .refused(let error): return ["copied": false, "error": error.rawValue, "clearsAfter": 0]
    case .clipboardFailed: return ["copied": false, "error": "clipboard", "clearsAfter": 0]
    }
  }
}

enum VaultClipboard {
  static let clearDelay = 90

  private static let concealed = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")
  private static let transient = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")
  private static let ownCopy = NSPasteboard.PasteboardType("dev.ardia.vaults.copy")
  private static let testBoard = NSPasteboard.Name("dev.ardia.vaults.test-clipboard")

  private struct Placed {
    let changeCount: Int
    let deadline: Date
  }

  @MainActor private static var placed: Placed?
  @MainActor private static var observers: [NSObjectProtocol] = []

  static func copy(_ text: String) async -> Bool {
    await withCheckedContinuation { (done: CheckedContinuation<Bool, Never>) in
      DispatchQueue.main.async { done.resume(returning: MainActor.assumeIsolated { Self.place(text) }) }
    }
  }

  static func board() -> NSPasteboard {
    LaunchConfig.shared.background ? NSPasteboard(name: testBoard) : NSPasteboard.general
  }

  private static var markerKey: String { "ArdiaVaultClipboardHeld.\(board().name.rawValue)" }
  private static var legacyMarkerKey: String { "ArdiaVaultClipboardMarker.\(board().name.rawValue)" }

  @MainActor
  private static func place(_ text: String) -> Bool {
    guard !text.isEmpty else { return false }
    let item = NSPasteboardItem()
    guard item.setString(text, forType: .string) else { return false }
    item.setData(Data(), forType: concealed)
    item.setData(Data(), forType: transient)
    item.setData(Data(), forType: ownCopy)
    let pasteboard = board()
    pasteboard.prepareForNewContents(with: .currentHostOnly)
    guard pasteboard.writeObjects([item]), pasteboard.types?.contains(ownCopy) == true else {
      NSLog("[vaults] the clipboard didn't keep the copy (%@)", pasteboard.name.rawValue)
      return false
    }
    let deadline = Date().addingTimeInterval(TimeInterval(clearDelay))
    placed = Placed(changeCount: pasteboard.changeCount, deadline: deadline)
    UserDefaults.standard.set(true, forKey: markerKey)
    watch()
    DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(clearDelay)) {
      MainActor.assumeIsolated { clearIfDue() }
    }
    return true
  }

  @MainActor
  static func clearIfDue(now: Date = Date(), quitting: Bool = false) {
    guard let held = placed else { return }
    let current = board()
    switch VaultClipboardDue.decide(placedCount: held.changeCount, deadline: held.deadline, currentCount: current.changeCount, now: now, quitting: quitting) {
    case .keep: return
    case .forget: forget()
    case .clear:
      current.clearContents()
      forget()
    }
  }

  @MainActor
  static func clearLeftover() {
    let defaults = UserDefaults.standard
    guard placed == nil, defaults.object(forKey: markerKey) != nil || defaults.object(forKey: legacyMarkerKey) != nil else { return }
    let current = board()
    if current.types?.contains(ownCopy) == true {
      current.clearContents()
      NSLog("[vaults] cleared a copy left on the clipboard by the last run")
    }
    defaults.removeObject(forKey: markerKey)
    defaults.removeObject(forKey: legacyMarkerKey)
  }

  @MainActor
  private static func forget() {
    placed = nil
    UserDefaults.standard.removeObject(forKey: markerKey)
  }

  @MainActor
  private static func watch() {
    guard observers.isEmpty else { return }
    let center = NotificationCenter.default
    let due: @Sendable (Notification) -> Void = { _ in MainActor.assumeIsolated { clearIfDue() } }
    observers = [
      center.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { _ in
        MainActor.assumeIsolated { clearIfDue(quitting: true) }
      },
      center.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main, using: due),
      NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main, using: due),
      NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.screensDidWakeNotification, object: nil, queue: .main, using: due),
    ]
  }
}
