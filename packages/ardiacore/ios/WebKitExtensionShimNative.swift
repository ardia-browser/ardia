import AppKit
import CoreGraphics

enum WebKitExtensionIdle {
  static let minimumInterval = 15
  static let defaultInterval = 60

  static func interval(_ value: Any?) -> Int { max(minimumInterval, (value as? NSNumber)?.intValue ?? defaultInterval) }

  static var screenLocked: Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    return (session["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false
  }

  static var idleSeconds: Double {
    guard let any = CGEventType(rawValue: UInt32.max) else { return 0 }
    return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: any)
  }

  static func state(interval: Int) -> String {
    if screenLocked { return "locked" }
    return idleSeconds >= Double(interval) ? "idle" : "active"
  }
}

enum WebKitExtensionAccess {
  static let selfManagement: Set<String> = ["getSelf", "uninstallSelf", "getPermissionWarningsByManifest"]
  static let forbiddenHeaders: Set<String> = [
    "accept-charset", "accept-encoding", "access-control-request-headers", "access-control-request-method", "connection", "content-length",
    "cookie", "cookie2", "date", "dnt", "expect", "host", "keep-alive", "origin", "referer", "te", "trailer", "transfer-encoding", "upgrade", "user-agent", "via",
    "access-control-request-private-network",
  ]

  static func mayCall(_ api: String, _ method: String, permissions: Set<String>) -> Bool {
    api != "management" || selfManagement.contains(method) || permissions.contains("management")
  }

  static func hearsAlarm(isPrivate: Bool, regularHasExtension: Bool) -> Bool {
    !isPrivate || !regularHasExtension
  }

  static func mayListen(_ api: String, permissions: Set<String>) -> Bool {
    api != "management" || permissions.contains("management")
  }

  static func acceptsExternal(from sender: String, manifest: [String: Any]) -> Bool {
    guard let connectable = manifest["externally_connectable"] as? [String: Any] else { return true }
    return (connectable["ids"] as? [Any] ?? []).contains { ($0 as? String) == "*" || ($0 as? String) == sender }
  }

  static func ownsNewChannel(_ channel: String, extensionId: String, open: Set<String>) -> Bool {
    channel.hasPrefix("\(extensionId):") && channel.count > extensionId.count + 1 && !open.contains(channel)
  }

  static func isForbiddenHeader(_ name: String) -> Bool {
    let lowered = name.lowercased()
    return forbiddenHeaders.contains(lowered) || lowered.hasPrefix("proxy-") || lowered.hasPrefix("sec-")
  }

  static func mayNavigate(to url: URL) -> Bool {
    let scheme = url.scheme?.lowercased() ?? ""
    return !url.isFileURL && scheme != "javascript"
  }

  static func ownPage(_ url: URL) -> String? {
    guard url.scheme == "webkit-extension", let host = url.host, !host.isEmpty else { return nil }
    return host
  }

  static func isFresh(_ moment: Date?, lifetime: TimeInterval, now: Date) -> Bool {
    guard let moment else { return false }
    let age = now.timeIntervalSince(moment)
    return age >= 0 && age <= lifetime
  }
}

enum WebKitExtensionDns {
  static let unavailable = "A request URL is required for DNS resolution."
}

enum WebKitExtensionManagedStorage {
  static let readOnly = "This is a read-only store."

  static func policy(extensionId: String) -> [String: Any] {
    let domain = "\(Bundle.main.bundleIdentifier ?? "com.ardia.browser").extensions.\(extensionId)"
    let folders = ["/Library/Managed Preferences/\(NSUserName())", "/Library/Managed Preferences"]
    for folder in folders {
      let url = URL(fileURLWithPath: folder, isDirectory: true).appendingPathComponent("\(domain).plist")
      if let values = NSDictionary(contentsOf: url) as? [String: Any] { return values }
    }
    return [:]
  }

  static func get(_ keys: Any?, extensionId: String) -> [String: Any] {
    let values = policy(extensionId: extensionId)
    switch keys {
    case let key as String: return values[key].map { [key: $0] } ?? [:]
    case let list as [Any]: return values.filter { entry in list.contains { ($0 as? String) == entry.key } }
    case let defaults as [String: Any]: return defaults.merging(values.filter { defaults[$0.key] != nil }) { $1 }
    default: return values
    }
  }

  static func bytesInUse(_ keys: Any?, extensionId: String) -> Int {
    let values = get(keys is NSNull ? nil : keys, extensionId: extensionId)
    return values.reduce(0) { total, entry in
      let size = (try? JSONSerialization.data(withJSONObject: [entry.value], options: [.fragmentsAllowed]))?.count ?? 2
      return total + entry.key.utf8.count + max(0, size - 2)
    }
  }
}
