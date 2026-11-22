import AppKit
import UserNotifications

final class NotificationHub: NSObject, UNUserNotificationCenterDelegate {
  static let shared = NotificationHub()

  private var pending: [(String, String, [String: Any])] = []
  private static let dismissibleCategory = "ardia.dismissible"
  private static let engineNotificationIdKey = "notificationId"
  private static let ownCategories: Set<UNNotificationCategory> = [
    UNNotificationCategory(identifier: dismissibleCategory, actions: [], intentIdentifiers: [], options: [.customDismissAction]),
  ]

  private let categoryLedger = CategoryLedger()
  private let engineDelegateLock = NSLock()
  private weak var engineDelegateStore: UNUserNotificationCenterDelegate?
  private var settingsReported = false

  private var center: UNUserNotificationCenter { .current() }

  func install() {
    Self.holdCenter
    if let current = center.delegate, current !== self { adoptEngineDelegate(current) }
    center.delegate = self
    registerOwnCategories()
  }

  func registerOwnCategories(afterRead: (() -> Void)? = nil) {
    let mark = categoryLedger.mark
    center.getNotificationCategories { [center, categoryLedger] categories in
      afterRead?()
      categoryLedger.writeUnlessWritten(since: mark) { center.setNotificationCategories(categories) }
    }
  }

  var engineDelegate: UNUserNotificationCenterDelegate? {
    engineDelegateLock.lock()
    defer { engineDelegateLock.unlock() }
    return engineDelegateStore
  }

  private func adoptEngineDelegate(_ delegate: UNUserNotificationCenterDelegate) {
    engineDelegateLock.lock()
    engineDelegateStore = delegate
    engineDelegateLock.unlock()
  }

  private static let holdCenter: Void = {
    let delegateSetter = #selector(setter: UNUserNotificationCenter.delegate)
    if let method = class_getInstanceMethod(UNUserNotificationCenter.self, delegateSetter) {
      typealias Setter = @convention(c) (UNUserNotificationCenter, Selector, UNUserNotificationCenterDelegate?) -> Void
      let original = unsafeBitCast(method_getImplementation(method), to: Setter.self)
      let block: @convention(block) (UNUserNotificationCenter, UNUserNotificationCenterDelegate?) -> Void = { center, delegate in
        guard let delegate, delegate !== NotificationHub.shared else { return original(center, delegateSetter, delegate) }
        NotificationHub.shared.adoptEngineDelegate(delegate)
        original(center, delegateSetter, NotificationHub.shared)
      }
      method_setImplementation(method, imp_implementationWithBlock(block))
    }
    let categoriesSetter = #selector(UNUserNotificationCenter.setNotificationCategories(_:))
    if let method = class_getInstanceMethod(UNUserNotificationCenter.self, categoriesSetter) {
      typealias Setter = @convention(c) (UNUserNotificationCenter, Selector, NSSet) -> Void
      let original = unsafeBitCast(method_getImplementation(method), to: Setter.self)
      let block: @convention(block) (UNUserNotificationCenter, NSSet) -> Void = { center, categories in
        let given = categories.compactMap { $0 as? UNNotificationCategory }
        let kept = CategoryLedger.merged(given, keeping: Array(ownCategories), id: \.identifier)
        NotificationHub.shared.categoryLedger.write { original(center, categoriesSetter, NSSet(array: kept)) }
      }
      method_setImplementation(method, imp_implementationWithBlock(block))
    }
  }()

  private static func postedByEngine(_ notification: UNNotification) -> Bool {
    notification.request.content.userInfo[engineNotificationIdKey] != nil
  }

  func flushPending() {
    while let (id, action, info) = pending.first, deliver(id, action, info) { pending.removeFirst() }
  }

  private func deliver(_ id: String, _ action: String, _ info: [String: Any]) -> Bool {
    ShellEvents.send(.notificationResponse, [
      "id": id, "action": action, "tabId": info["tabId"] as Any, "windowId": info["windowId"] as Any, "data": info["data"] as Any,
    ])
  }

  func permission(_ completion: @escaping (String) -> Void) {
    center.getNotificationSettings { settings in
      let status: String
      switch settings.authorizationStatus {
      case .authorized: status = "granted"
      case .denied: status = "denied"
      case .provisional, .ephemeral: status = "provisional"
      default: status = "notDetermined"
      }
      DispatchQueue.main.async { completion(status) }
    }
  }

  func requestPermission(_ completion: @escaping (Bool) -> Void) {
    center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
      DispatchQueue.main.async { completion(granted) }
    }
  }

  func reportSettingsOnce() {
    guard !settingsReported else { return }
    let stamp = ArdiaConsentStamp.begin()
    guard !stamp.epoch.isEmpty else { return }
    center.getNotificationSettings { settings in
      let authorization = Self.name(of: settings.authorizationStatus)
      let alert = Self.name(of: settings.alertSetting)
      let style = Self.name(of: settings.alertStyle)
      DispatchQueue.main.async { [self] in
        guard !settingsReported else { return }
        settingsReported = ShellEvents.send(.app, stamp.onto(["type": "notificationSettings", "authorization": authorization, "alertSetting": alert, "alertStyle": style]))
      }
    }
  }

  private static func name(of status: UNAuthorizationStatus) -> String {
    switch status {
    case .notDetermined: return "notDetermined"
    case .denied: return "denied"
    case .authorized: return "authorized"
    case .provisional: return "provisional"
    case .ephemeral: return "ephemeral"
    @unknown default: return "unknown"
    }
  }

  private static func name(of setting: UNNotificationSetting) -> String {
    switch setting {
    case .notSupported: return "notSupported"
    case .disabled: return "disabled"
    case .enabled: return "enabled"
    @unknown default: return "unknown"
    }
  }

  private static func name(of style: UNAlertStyle) -> String {
    switch style {
    case .none: return "none"
    case .banner: return "banner"
    case .alert: return "alert"
    @unknown default: return "unknown"
    }
  }

  func post(_ options: NotificationOptions, completion: @escaping (NotificationPostResult) -> Void) {
    let id = options.id ?? UUID().uuidString
    let content = UNMutableNotificationContent()
    content.title = options.title
    content.body = options.body
    if let subtitle = options.subtitle { content.subtitle = subtitle }
    if !options.silent { content.sound = .default }
    if let origin = options.origin { content.threadIdentifier = origin }
    if options.dismissible { content.categoryIdentifier = Self.dismissibleCategory }
    let info: [String: Any?] = ["tabId": options.tabId, "windowId": options.windowId, "origin": options.origin, "data": options.data]
    content.userInfo = info.compactMapValues { $0 }

    let deliver = { [center] (icon: NotificationIcon) in
      center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { error in
        let failure = error as NSError?
        let result = NotificationPostResult(id: failure == nil ? id : nil, icon: icon, errorDomain: failure?.domain, errorCode: failure?.code)
        DispatchQueue.main.async { completion(result) }
      }
    }
    guard let icon = options.icon.flatMap(URL.init(string:)) else {
      return deliver(options.icon == nil ? .absent : NotificationIcon(status: "invalid_url", errorCode: nil))
    }
    attachment(from: icon, id: id) { attachment, outcome in
      if let attachment { content.attachments = [attachment] }
      deliver(outcome)
    }
  }

  func remove(_ ids: [String]) {
    center.removeDeliveredNotifications(withIdentifiers: ids)
    center.removePendingNotificationRequests(withIdentifiers: ids)
  }

  private func attachment(from url: URL, id: String, completion: @escaping (UNNotificationAttachment?, NotificationIcon) -> Void) {
    let make = { (file: URL) in
      do {
        let attachment = try UNNotificationAttachment(identifier: "icon", url: file)
        completion(attachment, NotificationIcon(status: "attached", errorCode: nil))
      } catch {
        completion(nil, NotificationIcon(status: "attachment_rejected", errorCode: (error as NSError).code))
      }
    }
    if url.isFileURL { return make(url) }
    URLSession.shared.dataTask(with: url) { data, response, error in
      guard let data, !data.isEmpty else {
        let outcome = NotificationIcon(status: error == nil ? "empty" : "download_failed", errorCode: (error as NSError?)?.code)
        return DispatchQueue.main.async { completion(nil, outcome) }
      }
      let ext = (response?.mimeType == "image/png" || url.absoluteString.hasPrefix("data:image/png")) ? "png"
        : (response?.suggestedFilename as NSString?)?.pathExtension.nonEmpty ?? "png"
      let file = FileManager.default.temporaryDirectory.appendingPathComponent("ac-notification-\(id).\(ext)")
      do {
        try data.write(to: file)
        DispatchQueue.main.async { make(file) }
      } catch {
        let outcome = NotificationIcon(status: "write_failed", errorCode: (error as NSError).code)
        DispatchQueue.main.async { completion(nil, outcome) }
      }
    }.resume()
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
    let postedByEngine = Self.postedByEngine(notification)
    let engine = postedByEngine ? engineDelegate : nil
    let handedToEngine = engine?.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:willPresent:withCompletionHandler:))) == true
    if postedByEngine {
      let stamp = ArdiaConsentStamp.begin()
      DispatchQueue.main.async { _ = ShellEvents.send(.app, stamp.onto(["type": "engineNotificationPresented", "handedToEngine": handedToEngine])) }
    }
    if handedToEngine, let engine {
      return engine.userNotificationCenter?(center, willPresent: notification, withCompletionHandler: completionHandler) ?? completionHandler([.banner, .list, .sound])
    }
    completionHandler([.banner, .list, .sound])
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
    if Self.postedByEngine(response.notification) {
      let action = response.actionIdentifier == UNNotificationDefaultActionIdentifier ? "click" : "close"
      DispatchQueue.main.async { [self] in _ = deliver("engine:", action, [:]) }
      guard let engine = engineDelegate,
            engine.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:didReceive:withCompletionHandler:))) else { return completionHandler() }
      return engine.userNotificationCenter?(center, didReceive: response, withCompletionHandler: completionHandler) ?? completionHandler()
    }
    let id = response.notification.request.identifier
    let info = response.notification.request.content.userInfo as? [String: Any] ?? [:]
    let action: String? = switch response.actionIdentifier {
    case UNNotificationDefaultActionIdentifier: "click"
    case UNNotificationDismissActionIdentifier: "close"
    default: nil
    }
    DispatchQueue.main.async { [self] in
      if let action {
        if action == "click" { NSApp.activate() }
        if !deliver(id, action, info) { pending.append((id, action, info)) }
      }
      completionHandler()
    }
  }
}

private extension String {
  var nonEmpty: String? { isEmpty ? nil : self }
}
