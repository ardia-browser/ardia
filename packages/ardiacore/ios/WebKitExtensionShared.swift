import Darwin
import Foundation

enum WebKitExtensionShared {
  enum Feature: String, CaseIterable {
    case storage
    case alarms
    case dnr
    case grants

    var probe: String {
      switch self {
      case .storage: "ac_extension_storage_get"
      case .alarms: "ac_extension_alarms_watch"
      case .dnr: "ac_extension_dnr_get_dynamic_rules"
      case .grants: "ac_extension_grants_get"
      }
    }

    var watchCall: String? {
      switch self {
      case .storage: "ac_extension_storage_watch"
      case .alarms: "ac_extension_alarms_watch"
      case .dnr: "ac_extension_dnr_watch"
      case .grants: nil
      }
    }
  }

  enum Answer {
    case ok([String: Any])
    case missing
    case failed(String)
  }

  static let unshared = "__ardia_unshared__"
  static let missingPrefix = "the engine has no "
  private static let defaultHandle = UnsafeMutableRawPointer(bitPattern: -2)

  static func has(_ feature: Feature) -> Bool { dlsym(defaultHandle, feature.probe) != nil }

  static var available: Set<String> { Set(Feature.allCases.filter(has).map(\.rawValue)) }

  static func answer(_ json: String) -> Answer {
    guard let reply = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] else { return .failed("the engine's reply isn't JSON") }
    if let error = reply["error"] as? String {
      return error.hasPrefix(missingPrefix) ? .missing : .failed(error)
    }
    return .ok(reply)
  }

  static func routed(profile: String, args: [String: Any]) -> (profile: String, args: [String: Any]) {
    guard ArdiaHost.isPrivateProfile(profile) else { return (profile, args) }
    var marked = args
    marked["incognito"] = true
    return (ArdiaHost.baseProfile(of: profile), marked)
  }

  static func call(_ name: String, profile: String, args: [String: Any], done: @escaping (Answer) -> Void) {
    let route = routed(profile: profile, args: args)
    guard JSONSerialization.isValidJSONObject(route.args), let data = try? JSONSerialization.data(withJSONObject: route.args),
      let json = String(data: data, encoding: .utf8)
    else {
      return done(.failed("the arguments aren't JSON"))
    }
    ArdiaEngineBridge.call(name, profile: route.profile, args: json) { reply in
      let parsed = answer(reply)
      DispatchQueue.main.async { done(parsed) }
    }
  }

  static func count(_ name: String) { ArdiaEvents.emit("webKit.counted", data: ArdiaConsentStamp.begin().onto(["name": name])) }

  @MainActor private static var watchers: [String: Int] = [:]

  @MainActor static func watch(_ feature: Feature, base: String, extensionId: String, on: Bool) {
    guard let name = feature.watchCall else { return }
    let key = "\(feature.rawValue)|\(base)|\(extensionId)"
    let before = watchers[key] ?? 0
    let after = max(0, before + (on ? 1 : -1))
    watchers[key] = after == 0 ? nil : after
    guard (before == 0) != (after == 0) else { return }
    call(name, profile: base, args: ["id": extensionId, "on": after > 0]) { _ in }
  }

  @MainActor private static var observing = false
  @MainActor private static var grantsPending: Set<String> = []

  @available(macOS 15.4, *)
  @MainActor static func observeEngine() {
    guard !observing else { return }
    observing = true
    ArdiaEngineBridge.observe("extensions.storageChanged") { payload in
      guard let profile = payload["profile"] as? String, let id = payload["id"] as? String, let area = payload["area"] as? String else { return }
      let changes = payload["changes"] ?? [String: Any]()
      let contentMayRead = payload["contentMayRead"] as? Bool ?? (area != "session")
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          for bridge in WebKitExtensionBridge.live where bridge.baseProfile == profile {
            bridge.deliverStorageChange(changes, area: area, contentMayRead: contentMayRead, to: id)
          }
        }
      }
    }
    ArdiaEngineBridge.observe("extensions.alarm") { payload in
      guard let profile = payload["profile"] as? String, let id = payload["id"] as? String, let alarm = payload["alarm"] as? [String: Any] else { return }
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          let holders = WebKitExtensionBridge.live.filter { $0.baseProfile == profile && $0.hasExtension(id) }
          let regularHasExtension = holders.contains { !$0.isPrivate }
          for bridge in holders where WebKitExtensionAccess.hearsAlarm(isPrivate: bridge.isPrivate, regularHasExtension: regularHasExtension) {
            bridge.deliverAlarm(alarm, to: id)
          }
        }
      }
    }
    ArdiaEngineBridge.observe("extensions.dnrChanged") { payload in
      guard let profile = payload["profile"] as? String, let id = payload["id"] as? String else { return }
      let kind = payload["kind"] as? String ?? "dynamic"
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          for bridge in WebKitExtensionBridge.live where bridge.baseProfile == profile {
            bridge.deliverSignal(["signal": "dnrChanged", "kinds": [kind]], to: id, api: "declarativeNetRequest")
          }
          count("extensionDnrMirrored")
        }
      }
    }
    ArdiaEngineBridge.observe("extensions.grants") { payload in
      guard let profile = payload["profile"] as? String, let id = payload["id"] as? String else { return }
      let grants = WebKitExtensionGrants.from(payload)
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          let stale = WebKitExtensionBridge.live.contains { $0.baseProfile == profile && $0.grants(of: id).map { $0 != grants } == true }
          guard stale, grantsPending.insert(profile).inserted else { return }
          DispatchQueue.main.async {
            MainActor.assumeIsolated {
              _ = grantsPending.remove(profile)
              count("extensionGrantsChanged")
              ArdiaEvents.emit("webKit.extensionsWanted", data: ArdiaConsentStamp.begin().onto(["profile": profile]))
            }
          }
        }
      }
    }
  }
}
