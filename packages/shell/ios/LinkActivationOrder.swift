import AppKit

final class LinkActivationOrder: NSObject {
  private struct Placement {
    weak var window: NSWindow?
    let below: Int
  }

  private static let pairing: TimeInterval = 3
  private var placements: [Placement] = []
  private var activatedAt: Date?
  private weak var opened: NSWindow?
  private var openedAt: Date?

  override init() {
    super.init()
    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(willBecomeActive(_:)), name: NSApplication.willBecomeActiveNotification, object: nil)
    center.addObserver(self, selector: #selector(didBecomeActive(_:)), name: NSApplication.didBecomeActiveNotification, object: nil)
  }

  func openedFromLink(_ window: NSWindow) {
    guard !NSApp.isActive || activatedAt.map({ Date().timeIntervalSince($0) < Self.pairing }) == true else { return }
    opened = window
    openedAt = Date()
    keepOthersWhereTheyWere()
  }

  @objc private func willBecomeActive(_ notification: Notification) {
    placements = Self.placements()
    activatedAt = nil
  }

  @objc private func didBecomeActive(_ notification: Notification) {
    activatedAt = Date()
    keepOthersWhereTheyWere()
  }

  private func keepOthersWhereTheyWere() {
    guard let opened, let openedAt, let activatedAt, abs(openedAt.timeIntervalSince(activatedAt)) < Self.pairing else { return }
    self.openedAt = nil
    let placements = placements
    Self.restore(placements, except: opened)
    DispatchQueue.main.async { [weak opened] in Self.restore(placements, except: opened) }
  }

  private static func restore(_ placements: [Placement], except opened: NSWindow?) {
    for placement in placements.reversed() {
      guard let window = placement.window, window !== opened, window.isVisible, !window.isMiniaturized else { continue }
      window.order(.below, relativeTo: placement.below)
    }
  }

  private static func placements() -> [Placement] {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
    else { return [] }
    let pid = ProcessInfo.processInfo.processIdentifier
    var above: Int?
    var result: [Placement] = []
    for info in list where (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 {
      guard let number = (info[kCGWindowNumber as String] as? NSNumber)?.intValue else { continue }
      guard (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid else {
        above = number
        continue
      }
      if let above, let window = NSApp.window(withWindowNumber: number) { result.append(Placement(window: window, below: above)) }
    }
    return result
  }
}
