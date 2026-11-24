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
    if let raw = options.icon, raw.utf8.count > Self.maxIconDataUriBytes {
      return deliver(NotificationIcon(status: "too_large", errorCode: nil))
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

  static let maxIconDataUriBytes = 1_049_600
  static let maxIconBytes = 786_432

  private func attachment(from url: URL, id: String, completion: @escaping (UNNotificationAttachment?, NotificationIcon) -> Void) {
    let make = { (file: URL) in
      do {
        let attachment = try UNNotificationAttachment(identifier: "icon", url: file)
        completion(attachment, NotificationIcon(status: "attached", errorCode: nil))
      } catch {
        completion(nil, NotificationIcon(status: "attachment_rejected", errorCode: (error as NSError).code))
      }
    }
    if url.isFileURL {
      guard (url.host ?? "").isEmpty || url.host == "localhost" else { return completion(nil, NotificationIcon(status: "invalid_url", errorCode: nil)) }
      return make(url)
    }
    guard url.scheme?.lowercased() == "data", url.absoluteString.prefix(11).lowercased() == "data:image/" else {
      return completion(nil, NotificationIcon(status: "invalid_url", errorCode: nil))
    }
    let raw = url.absoluteString
    let header = raw.firstIndex(of: ",").map { raw[..<$0] } ?? raw[...]
    let payloadBytes = max(0, raw.utf8.count - header.utf8.count - 1)
    let decodedBound = header.lowercased().hasSuffix(";base64") ? payloadBytes / 4 * 3 : payloadBytes
    guard raw.utf8.count <= Self.maxIconDataUriBytes, decodedBound <= Self.maxIconBytes else {
      return completion(nil, NotificationIcon(status: "too_large", errorCode: nil))
    }
    guard let data = try? Data(contentsOf: url), !data.isEmpty else {
      return completion(nil, NotificationIcon(status: "empty", errorCode: nil))
    }
    guard data.count <= Self.maxIconBytes else {
      return completion(nil, NotificationIcon(status: "too_large", errorCode: nil))
    }
    let subtype = url.absoluteString.dropFirst("data:image/".count).prefix { $0 != ";" && $0 != "," }.lowercased()
    let ext = ["jpeg": "jpg", "jpg": "jpg", "gif": "gif", "heic": "heic", "tiff": "tiff", "webp": "webp"][subtype] ?? "png"
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("ac-notification-\(id).\(ext)")
    do {
      try data.write(to: file)
      make(file)
    } catch {
      completion(nil, NotificationIcon(status: "write_failed", errorCode: (error as NSError).code))
    }
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
    if Self.postedByEngine(notification), let engine = engineDelegate,
       engine.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:willPresent:withCompletionHandler:))) {
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
