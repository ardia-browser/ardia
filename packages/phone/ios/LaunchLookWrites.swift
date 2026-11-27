import Foundation
import os

enum LaunchLookWrites {
  private static let shownAtLaunch = OSAllocatedUnfairLock<LaunchLook.Recalled?>(uncheckedState: nil)

  static func noteShown(_ recalled: LaunchLook.Recalled) {
    shownAtLaunch.withLockUnchecked { $0 = recalled }
  }

  static func remember(_ next: LaunchLook.Recalled) -> Bool {
    let shown = shownAtLaunch.withLockUnchecked { shown -> LaunchLook.Recalled? in
      defer { shown = nil }
      return shown
    }
    if let shown, !next.colors.isIncognito, !shown.drawsTheSameSpace(as: next) {
      PendingCounts.add(PendingCounts.launchLooksStale)
    }
    return LaunchLook.remember(next)
  }
}
