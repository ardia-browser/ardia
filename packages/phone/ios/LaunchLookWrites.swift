import Foundation
import os

enum LaunchLookWrites {
  private struct Shown {
    var recalled: LaunchLook.Recalled
    var appDark: Bool
  }

  private static let shownAtLaunch = OSAllocatedUnfairLock<Shown?>(uncheckedState: nil)
  private static let firstWriteTaken = OSAllocatedUnfairLock<Bool>(initialState: false)

  static func noteShown(_ recalled: LaunchLook.Recalled, appDark: Bool) {
    shownAtLaunch.withLockUnchecked { shown in
      if shown == nil { shown = Shown(recalled: recalled, appDark: appDark) }
    }
  }

  static func remember(_ next: LaunchLook.Recalled) -> Bool {
    let first = firstWriteTaken.withLock { taken -> Bool in
      defer { taken = true }
      return !taken
    }
    if first, let shown = shownAtLaunch.withLockUnchecked({ $0 }), !next.colors.isIncognito, !shown.recalled.drawsTheSameSpace(as: next, appDark: shown.appDark) {
      PendingCounts.add(PendingCounts.launchLooksStale)
    }
    return LaunchLook.remember(next)
  }
}
