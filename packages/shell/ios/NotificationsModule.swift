import AppKit
import ExpoModulesCore

public class NotificationsModule: Module, NotificationsNative {
  private let lifetime = ModuleLifetime()

  static func notificationPermission(_ promise: Promise) { NotificationHub.shared.permission { promise.resolve($0) } }

  static func requestNotificationPermission(_ promise: Promise) { NotificationHub.shared.requestPermission { promise.resolve($0) } }

  static func postNotification(_ options: NotificationOptions, _ promise: Promise) { NotificationHub.shared.post(options) { promise.resolve($0.payload) } }

  static func removeNotifications(_ ids: [String]) { NotificationHub.shared.remove(ids) }

  static func openNotificationSettings() {
    let id = Bundle.main.bundleIdentifier ?? ""
    if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(id)") {
      NSWorkspace.shared.open(url)
    }
  }

  public func definition() -> ModuleDefinition {
    Name(Self.moduleName)
    Self.eventsDefinition

    OnCreate {
      self.lifetime.begin(self) { ShellEvents.retire(self) }
      self.lifetime.onMain { NotificationHub.shared.install() }
    }

    OnStartObserving(ShellEvents.Channel.notificationResponse.rawValue) { ShellEvents.attach(.notificationResponse, to: self, while: self.lifetime) }

    OnDestroy {
      self.lifetime.end()
      ShellEvents.detach(self)
    }

    Self.notificationPermissionFunction
    Self.requestNotificationPermissionFunction
    Self.postNotificationFunction
    Self.removeNotificationsFunction
    Self.openNotificationSettingsFunction
  }
}
