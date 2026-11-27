import Foundation
import os

enum LaunchLookWrites {
  private struct Shown {
    var recalled: LaunchLook.Recalled
    var appDark: Bool
    var window: Int?
  }

  private static let shownAtLaunch = OSAllocatedUnfairLock<Shown?>(uncheckedState: nil)
  private static let firstWriteTaken = OSAllocatedUnfairLock<Bool>(initialState: false)

  static func noteShown(_ recalled: LaunchLook.Recalled, appDark: Bool) {
    shownAtLaunch.withLockUnchecked { shown in
      if shown == nil { shown = Shown(recalled: recalled, appDark: appDark, window: UsageConsent.lock.withLock { UsageConsent.windowLocked() }) }
    }
  }

  static func remember(_ next: LaunchLook.Recalled) -> Bool {
    let first = firstWriteTaken.withLock { taken -> Bool in
      defer { taken = true }
      return !taken
    }
    if first, let shown = shownAtLaunch.withLockUnchecked({ $0 }),
       LaunchLook.countsAsStale(shown: shown.recalled, appDark: shown.appDark, shownWindow: shown.window, next: next, currentWindow: UsageConsent.lock.withLock { UsageConsent.windowLocked() }) {
      PendingCounts.add(PendingCounts.launchLooksStale, sampledWindow: shown.window)
    }
    return LaunchLook.remember(next)
  }
}
