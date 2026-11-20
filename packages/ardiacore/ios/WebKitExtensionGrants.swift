import Foundation
import WebKit

struct WebKitExtensionGrants: Equatable {
  var apis: Set<String> = []
  var hosts: Set<String> = []

  static let none = WebKitExtensionGrants()

  static func read(profile: String) -> [String: WebKitExtensionGrants] {
    let directory = URL(fileURLWithPath: ArdiaServices.profileDirectory(profile), isDirectory: true)
    var grants: [String: WebKitExtensionGrants] = [:]
    for file in ["Secure Preferences", "Preferences"] {
      for (id, found) in parse(directory.appendingPathComponent(file)) { grants[id, default: .none].merge(found) }
    }
    return grants
  }

  static func parse(_ file: URL) -> [String: WebKitExtensionGrants] {
    guard let data = try? Data(contentsOf: file),
      let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let settings = (root["extensions"] as? [String: Any])?["settings"] as? [String: Any]
    else { return [:] }
    var grants: [String: WebKitExtensionGrants] = [:]
    for (id, value) in settings {
      guard let entry = value as? [String: Any] else { continue }
      var found = WebKitExtensionGrants()
      let runtimeOnly = entry["withholding_permissions"] as? Bool == true || entry["runtime_granted_permissions"] is [String: Any]
      for key in ["granted_permissions", "runtime_granted_permissions"] {
        guard let set = entry[key] as? [String: Any] else { continue }
        found.apis.formUnion(names(set["api"]))
        found.apis.formUnion(names(set["manifest_permissions"]))
        guard !runtimeOnly || key == "runtime_granted_permissions" else { continue }
        found.hosts.formUnion(names(set["explicit_host"]))
        found.hosts.formUnion(names(set["scriptable_host"]))
      }
      if !found.apis.isEmpty || !found.hosts.isEmpty { grants[id] = found }
    }
    return grants
  }

  private static func names(_ value: Any?) -> [String] {
    (value as? [Any] ?? []).compactMap { item in
      if let name = item as? String { return name }
      return (item as? [String: Any])?.keys.first
    }
  }

  static func from(_ entry: [String: Any]) -> WebKitExtensionGrants {
    WebKitExtensionGrants(apis: Set(entry["apis"] as? [String] ?? []), hosts: Set(entry["hosts"] as? [String] ?? []))
  }

  @MainActor static func live(profile: String, ids: [String], done: @escaping ([String: WebKitExtensionGrants]?) -> Void) {
    guard !ids.isEmpty, WebKitExtensionShared.has(.grants) else { return done(nil) }
    WebKitExtensionShared.call("ac_extension_grants_get", profile: profile, args: ["ids": ids]) { answer in
      guard case .ok(let body) = answer, let list = body["grants"] as? [[String: Any]] else {
        WebKitExtensionShared.count("extensionGrantsFallback")
        return done(nil)
      }
      var grants: [String: WebKitExtensionGrants] = [:]
      for entry in list { if let id = entry["id"] as? String { grants[id] = from(entry) } }
      WebKitExtensionShared.count("extensionGrantsLive")
      done(grants)
    }
  }

  private struct Ask {
    let profile: String
    let extensionId: String
    let apis: [String]
    let hosts: [String]
    let done: (WebKitExtensionGrants?) -> Void
  }

  static let promptDeadline: TimeInterval = 600
  @MainActor private static var asking: [String: (token: UUID, ask: Ask)] = [:]
  @MainActor private static var waiting: [String: [Ask]] = [:]

  @MainActor static func request(profile: String, extensionId: String, apis: [String], hosts: [String], done: @escaping (WebKitExtensionGrants?) -> Void) {
    guard WebKitExtensionShared.has(.grants) else { return done(nil) }
    let asker = "\(ArdiaHost.baseProfile(of: profile))|\(extensionId)"
    let ask = Ask(profile: profile, extensionId: extensionId, apis: apis, hosts: hosts, done: done)
    guard asking[asker] == nil else { return waiting[asker, default: []].append(ask) }
    prompt(ask, asker: asker)
  }

  @MainActor private static func prompt(_ ask: Ask, asker: String) {
    let token = UUID()
    asking[asker] = (token, ask)
    DispatchQueue.main.asyncAfter(deadline: .now() + promptDeadline) {
      MainActor.assumeIsolated { settle(asker, token: token, with: nil) }
    }
    let args: [String: Any] = ["id": ask.extensionId, "apis": ask.apis, "hosts": ask.hosts, "prompt": true]
    WebKitExtensionShared.call("ac_extension_grants_request", profile: ask.profile, args: args) { answer in
      guard case .ok(let body) = answer, body["granted"] as? Bool == true else { return settle(asker, token: token, with: nil) }
      WebKitExtensionShared.count("extensionGrantWritten")
      settle(asker, token: token, with: from(body))
    }
  }

  @MainActor private static func settle(_ asker: String, token: UUID, with grants: WebKitExtensionGrants?) {
    guard let current = asking[asker], current.token == token else { return }
    asking[asker] = nil
    current.ask.done(grants)
    guard var queue = waiting[asker], !queue.isEmpty else { return waiting[asker] = nil }
    let next = queue.removeFirst()
    waiting[asker] = queue.isEmpty ? nil : queue
    prompt(next, asker: asker)
  }

  @available(macOS 15.4, *)
  func allows(_ url: URL) -> Bool {
    hosts.contains { host in (try? WKWebExtension.MatchPattern(string: host))?.matches(url) == true }
  }

  mutating func merge(_ other: WebKitExtensionGrants) {
    apis.formUnion(other.apis)
    hosts.formUnion(other.hosts)
  }
}
