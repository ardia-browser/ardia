import UserNotifications

#if DEBUG
final class DevEngineNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
  static var kept: DevEngineNotificationDelegate?
}
#endif
