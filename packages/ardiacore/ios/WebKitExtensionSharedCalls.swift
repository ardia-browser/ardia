import Foundation

@MainActor
enum WebKitExtensionSharedCalls {
  private static let storageCalls: [String: String] = [
    "sharedGet": "ac_extension_storage_get", "sharedGetKeys": "ac_extension_storage_get_keys", "sharedSet": "ac_extension_storage_set",
    "sharedRemove": "ac_extension_storage_remove", "sharedClear": "ac_extension_storage_clear", "sharedBytesInUse": "ac_extension_storage_get_bytes_in_use",
    "sharedSetAccessLevel": "ac_extension_storage_set_access_level",
  ]
  private static let alarmCalls: [String: String] = [
    "create": "ac_extension_alarms_create", "get": "ac_extension_alarms_get", "getAll": "ac_extension_alarms_get_all",
    "clear": "ac_extension_alarms_clear", "clearAll": "ac_extension_alarms_clear_all",
  ]
  private static let dnrCalls: [String: String] = [
    "dynamic": "ac_extension_dnr_get_dynamic_rules", "session": "ac_extension_dnr_get_session_rules", "rulesets": "ac_extension_dnr_get_enabled_rulesets",
    "disabled": "ac_extension_dnr_get_disabled_rule_ids",
  ]
  private static let dnrUpdates: [String: String] = [
    "dynamic": "ac_extension_dnr_update_dynamic_rules", "session": "ac_extension_dnr_update_session_rules",
    "rulesets": "ac_extension_dnr_update_enabled_rulesets", "static": "ac_extension_dnr_update_static_rules",
  ]

  static func handle(_ api: String, _ method: String, args: [Any], extensionId: String, profile: String, untrusted: Bool,
                     reply: @escaping (Any?, (any Error)?) -> Void) -> Bool {
    let argument = { (index: Int) -> Any? in args.indices.contains(index) ? args[index] : nil }
    let value = { (index: Int) -> Any in argument(index).flatMap { $0 is NSNull ? nil : $0 } ?? NSNull() }
    switch api {
    case "storage":
      guard let name = storageCalls[method] else { return false }
      var call: [String: Any] = ["id": extensionId, "area": argument(0) as? String ?? "", "content": untrusted]
      switch method {
      case "sharedGet", "sharedRemove", "sharedBytesInUse": call["keys"] = value(1)
      case "sharedSet": call["values"] = argument(1) as? [String: Any] ?? [:]
      case "sharedSetAccessLevel": call["accessLevel"] = argument(1) as? String ?? ""
      default: break
      }
      run(name, profile: profile, args: call, reply: reply) { result in
        switch method {
        case "sharedGet": result["values"] ?? [String: Any]()
        case "sharedGetKeys": result["keys"] ?? [Any]()
        case "sharedBytesInUse": result["bytes"] ?? 0
        default: nil
        }
      }
    case "alarms":
      guard let name = alarmCalls[method] else { return false }
      var call: [String: Any] = ["id": extensionId]
      if method != "getAll", method != "clearAll" { call["name"] = argument(0) as? String ?? "" }
      if method == "create" { call["info"] = argument(1) as? [String: Any] ?? [:] }
      run(name, profile: profile, args: call, reply: reply) { result in
        if result["kept"] as? Bool == true { WebKitExtensionShared.count("extensionAlarmKept") }
        return switch method {
        case "get": result["alarm"]
        case "getAll": result["alarms"] ?? [Any]()
        case "clear": result["removed"] ?? false
        case "clearAll": true
        default: nil
        }
      }
    case "declarativeNetRequest":
      switch method {
      case "mirrorState":
        let kinds = Array(Set(argument(0) as? [String] ?? Array(dnrCalls.keys))).filter { dnrCalls[$0] != nil }
        mirrorState(kinds, extensionId: extensionId, profile: profile, reply: reply)
      case "update":
        guard let kind = argument(0) as? String, let name = dnrUpdates[kind] else {
          reply(["error": "Ardia doesn't know this rule update."], nil)
          return true
        }
        run(name, profile: profile, args: ["id": extensionId, "options": argument(1) as? [String: Any] ?? [:]], reply: reply) { _ in nil }
      case "noteApplyFailure":
        WebKitExtensionShared.count("extensionDnrApplyFailed")
        reply(["result": NSNull()], nil)
      default:
        return false
      }
    default:
      return false
    }
    return true
  }

  private static func run(_ name: String, profile: String, args: [String: Any], reply: @escaping (Any?, (any Error)?) -> Void,
                          result: @escaping ([String: Any]) -> Any?) {
    WebKitExtensionShared.call(name, profile: profile, args: args) { answer in
      switch answer {
      case .ok(let body):
        WebKitExtensionShared.count("extensionSharedCall")
        reply(["result": result(body) ?? NSNull()], nil)
      case .missing:
        WebKitExtensionShared.count("extensionSharedFallback")
        reply(["error": WebKitExtensionShared.unshared], nil)
      case .failed(let message):
        reply(["error": message], nil)
      }
    }
  }

  static func dnrField(_ kind: String) -> String {
    switch kind {
    case "rulesets", "disabled": "rulesets"
    default: "rules"
    }
  }

  private static func mirrorState(_ kinds: [String], extensionId: String, profile: String, reply: @escaping (Any?, (any Error)?) -> Void) {
    var state: [String: Any] = [:]
    var failure: String?
    var left = kinds.count
    guard left > 0 else { return reply(["result": state], nil) }
    for kind in kinds {
      guard let name = dnrCalls[kind] else { continue }
      WebKitExtensionShared.call(name, profile: profile, args: ["id": extensionId]) { answer in
        switch answer {
        case .ok(let body): state[kind] = body[Self.dnrField(kind)] ?? [Any]()
        case .missing where kind == "disabled": break
        case .missing: failure = failure ?? WebKitExtensionShared.unshared
        case .failed(let message): failure = failure ?? message
        }
        left -= 1
        guard left == 0 else { return }
        if let failure {
          if failure == WebKitExtensionShared.unshared { WebKitExtensionShared.count("extensionSharedFallback") }
          return reply(["error": failure], nil)
        }
        WebKitExtensionShared.count("extensionSharedCall")
        reply(["result": state], nil)
      }
    }
  }
}
