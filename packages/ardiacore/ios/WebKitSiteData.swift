import Foundation
import WebKit

final class WebKitSiteData: NSObject, WKHTTPCookieStoreObserver {
  static let shared = WebKitSiteData()
  static let gateDeadline: TimeInterval = 0.6
  private static let changeDebounce: TimeInterval = 0.3
  private static let maxCookies = 4000

  private var watchingGate = false
  private var gates: [String: () -> Void] = [:]
  private var nextGate = 0
  private let observed = NSMapTable<WKHTTPCookieStore, NSString>.weakToStrongObjects()
  private var snapshots: [String: [String: Int]] = [:]
  private var refreshing: Set<String> = []
  let storage = WebKitSiteStorage()

  func setWatching(_ on: Bool) { watchingGate = on }

  static func gatedHost(of url: URL) -> String? {
    guard let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http", let host = url.host?.lowercased(), !host.isEmpty else { return nil }
    return host
  }

  static func origin(of url: URL) -> String? {
    guard let host = gatedHost(of: url), let scheme = url.scheme?.lowercased() else { return nil }
    return url.port.map { "\(scheme)://\(host):\($0)" } ?? "\(scheme)://\(host)"
  }

  func gate(profile: String, url: URL, from current: URL?, proceed: @escaping () -> Void) {
    guard watchingGate, !WebKitStores.isPrivate(profile), ArdiaEvents.listens("webKit"), let origin = Self.origin(of: url),
      Self.gatedHost(of: url) != current.flatMap(Self.gatedHost(of:))
    else { return proceed() }
    watch(profile: profile)
    nextGate += 1
    let id = "g\(nextGate)"
    gates[id] = proceed
    ArdiaEvents.emit("webKit.siteDataWanted", data: ArdiaConsentStamp.begin().onto(["id": id, "profile": profile, "origin": origin]))
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.gateDeadline) { [weak self] in self?.release(id) }
  }

  func release(_ id: String) { gates.removeValue(forKey: id)?() }

  static func covered(_ domain: String, by domains: [String]) -> Bool {
    let bare = domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
    return !bare.isEmpty && domains.contains { bare == $0 || bare.hasSuffix("." + $0) }
  }

  static func partitioned(_ cookie: HTTPCookie) -> Bool {
    cookie.properties?.keys.contains { $0.rawValue.localizedCaseInsensitiveContains("partition") } == true
  }

  static func engineEntry(_ cookie: HTTPCookie) -> [String: Any] {
    var entry: [String: Any] = [
      "name": cookie.name, "value": cookie.value, "domain": cookie.domain, "path": cookie.path,
      "expires": cookie.expiresDate?.timeIntervalSince1970 ?? -1, "session": cookie.isSessionOnly,
      "httpOnly": cookie.isHTTPOnly, "secure": cookie.isSecure,
    ]
    switch cookie.sameSitePolicy {
    case .some(.sameSiteStrict): entry["sameSite"] = "Strict"
    case .some(.sameSiteLax): entry["sameSite"] = "Lax"
    default: break
    }
    return entry
  }

  private func store(_ profile: String) -> WKWebsiteDataStore? {
    WebKitStores.isPrivate(profile) ? nil : WebKitHub.shared.stores.dataStore(for: profile)
  }

  func read(profile: String, domains: [String], origins: [URL], completion: @escaping ([String: Any]?) -> Void) {
    guard let store = store(profile) else { return completion(nil) }
    watch(profile: profile)
    let wanted = domains.map { $0.lowercased() }.filter { !$0.isEmpty }
    store.httpCookieStore.getAllCookies { [storage] all in
      let cookies = all.lazy.filter { !Self.partitioned($0) && Self.covered($0.domain, by: wanted) }.prefix(Self.maxCookies).map(Self.engineEntry)
      storage.read(profile: profile, store: store, origins: origins) { items in
        completion(["cookies": Array(cookies), "storage": items])
      }
    }
  }

  func write(profile: String, set: [[String: Any]], remove: [[String: Any]], storage writes: [String: [String: Any]], completion: @escaping ([String: Any]?) -> Void) {
    guard let store = store(profile) else { return completion(nil) }
    let cookieStore = store.httpCookieStore
    let made = set.compactMap(WebKitHub.httpCookie(fromEngine:))
    let group = DispatchGroup()
    var removed = 0
    group.enter()
    cookieStore.getAllCookies { all in
      let doomed = all.filter { cookie in
        !Self.partitioned(cookie) && remove.contains { ($0["name"] as? String) == cookie.name && ($0["domain"] as? String)?.lowercased() == cookie.domain.lowercased() && (($0["path"] as? String) ?? "/") == cookie.path }
      }
      removed = doomed.count
      for cookie in doomed {
        group.enter()
        cookieStore.delete(cookie) { group.leave() }
      }
      Self.set(made, in: cookieStore, group: group)
      group.leave()
    }
    var stored = 0
    group.enter()
    storage.write(profile: profile, store: store, writes: writes) { count in
      stored = count
      group.leave()
    }
    group.notify(queue: .main) { [weak self] in
      self?.refresh(profile, announce: false)
      completion(["cookies": made.count, "removed": removed, "storage": stored])
    }
  }

  private static func set(_ cookies: [HTTPCookie], in cookieStore: WKHTTPCookieStore, group: DispatchGroup) {
    guard !cookies.isEmpty else { return }
    if #available(macOS 26.0, *) {
      group.enter()
      cookieStore.setCookies(cookies) { group.leave() }
      return
    }
    for cookie in cookies {
      group.enter()
      cookieStore.setCookie(cookie) { group.leave() }
    }
  }

  func watch(profile: String) {
    guard let store = store(profile) else { return }
    let cookieStore = store.httpCookieStore
    guard observed.object(forKey: cookieStore) == nil else { return }
    observed.setObject(profile as NSString, forKey: cookieStore)
    cookieStore.add(self)
    refresh(profile, announce: false)
  }

  func forget(profile: String) {
    for case let cookieStore as WKHTTPCookieStore in observed.keyEnumerator().allObjects where observed.object(forKey: cookieStore) as String? == profile {
      observed.removeObject(forKey: cookieStore)
      cookieStore.remove(self)
    }
    snapshots.removeValue(forKey: profile)
    storage.close(profile: profile)
  }

  func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
    guard let profile = observed.object(forKey: cookieStore) as String?, !refreshing.contains(profile) else { return }
    refreshing.insert(profile)
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.changeDebounce) { [weak self] in
      self?.refreshing.remove(profile)
      self?.refresh(profile, announce: true)
    }
  }

  private static func fingerprints(_ cookies: [HTTPCookie]) -> [String: Int] {
    var byDomain: [String: Hasher] = [:]
    for cookie in cookies.sorted(by: { ($0.domain, $0.name, $0.path) < ($1.domain, $1.name, $1.path) }) where !partitioned(cookie) {
      let domain = cookie.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
      var hasher = byDomain[domain] ?? Hasher()
      hasher.combine(cookie.name)
      hasher.combine(cookie.path)
      hasher.combine(cookie.value)
      hasher.combine(cookie.expiresDate.map { Int($0.timeIntervalSince1970 / 60) } ?? -1)
      byDomain[domain] = hasher
    }
    return byDomain.mapValues { $0.finalize() }
  }

  private func refresh(_ profile: String, announce: Bool) {
    guard let store = store(profile) else { return }
    store.httpCookieStore.getAllCookies { [weak self] all in
      guard let self else { return }
      let now = Self.fingerprints(all)
      let was = self.snapshots[profile]
      self.snapshots[profile] = now
      guard announce, let was else { return }
      let changed = Set(now.keys).union(was.keys).filter { now[$0] != was[$0] }
      if !changed.isEmpty { ArdiaEvents.emit("webKit.siteCookiesChanged", data: ArdiaConsentStamp.begin().onto(["profile": profile, "domains": Array(changed.prefix(200))])) }
    }
  }
}
