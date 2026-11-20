import AppKit
import CryptoKit
import WebKit

@available(macOS 15.4, *)
final class WebKitExtensionHub: NSObject, WKWebExtensionControllerDelegate {
  struct Loaded {
    let id: String
    let context: WKWebExtensionContext
    let signature: String
    let apis: Set<String>
    var nativeMessaging: Bool
    var grants: WebKitExtensionGrants
    var sidePanel: WebKitExtensionSidePanel
  }

  let profile: String
  let store: WebKitStores.StoreID
  let isPrivate: Bool
  let controller: WKWebExtensionController
  private(set) var bridge: WebKitExtensionBridge!
  var loaded: [String: Loaded] = [:]
  var windows: [ObjectIdentifier: WebKitExtensionWindow] = [:]
  var allSites: Set<String> = []
  var activeTabs: [ObjectIdentifier: ActiveTab] = [:]
  var reportedTabs: [ObjectIdentifier: ReportedTab] = [:]
  var placements: [ObjectIdentifier: Placement] = [:]
  var openedTabs: Set<ObjectIdentifier> = []
  var announcedWindows: Set<ObjectIdentifier> = []
  var leaving: [String: Leaving] = [:]
  var requests: [String: Request] = [:]
  var arrivals: [String: Arrival] = [:]
  private var syncing: Task<Void, Never>?
  private(set) var closed = false
  @MainActor static var tabLayout = TabLayout()
  @MainActor static var nextRequest = 0

  struct ActiveTab {
    weak var tab: WebKitTab?
  }

  struct ReportedTab: Equatable {
    let url: URL?
    let title: String?
    let loading: Bool
  }

  init(profile: String, store: WebKitStores.StoreID) {
    self.profile = profile
    self.store = store
    isPrivate = WebKitStores.isPrivate(profile)
    let configuration = isPrivate ? WKWebExtensionController.Configuration.nonPersistent() : WKWebExtensionController.Configuration(identifier: Self.identifier(profile))
    configuration.defaultWebsiteDataStore = WebKitHub.shared.stores.dataStore(for: profile)
    controller = WKWebExtensionController(configuration: configuration)
    super.init()
    bridge = WebKitExtensionBridge(hub: self)
    controller.delegate = self
  }

  static func identifier(_ profile: String) -> UUID {
    let scope = LaunchConfig.shared.dataDirectory ?? ""
    var bytes = Array(SHA256.hash(data: Data("ardia.webkit.extensions|\(scope)|\(profile)".utf8)).prefix(16))
    bytes[6] = (bytes[6] & 0x0F) | 0x50
    bytes[8] = (bytes[8] & 0x3F) | 0x80
    return bytes.withUnsafeBufferPointer { NSUUID(uuidBytes: $0.baseAddress!) as UUID }
  }

  static func pattern(_ site: String) -> WKWebExtension.MatchPattern? {
    if let pattern = try? WKWebExtension.MatchPattern(string: site) { return pattern }
    let host = site.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    guard !host.isEmpty, !host.contains("://") else { return nil }
    return try? WKWebExtension.MatchPattern(string: "*://\(host)/*")
  }

  func loadedExtension(_ id: String) -> Loaded? { loaded[id] }

  static func hostPatterns(_ webExtension: WKWebExtension) -> Set<WKWebExtension.MatchPattern> {
    let scripts = webExtension.manifest["content_scripts"] as? [[String: Any]] ?? []
    let matches = WebKitExtensionStaging.hostMatches(contentScripts: scripts)
    return webExtension.requestedPermissionMatchPatterns.union(matches.compactMap { try? WKWebExtension.MatchPattern(string: $0) })
  }

  private func grant(_ context: WKWebExtensionContext, _ wanted: WebKitExtensions.Wanted) {
    let webExtension = context.webExtension
    let forever = Date.distantFuture
    let optional = webExtension.optionalPermissions.filter { wanted.grants.apis.contains($0.rawValue) }
    context.grantedPermissions = Dictionary(uniqueKeysWithValues: webExtension.requestedPermissions.union(optional).map { ($0, forever) })
    let optionalHosts = webExtension.optionalPermissionMatchPatterns.filter { wanted.grants.hosts.contains($0.string) }
    let patterns = wanted.allSites ? Self.hostPatterns(webExtension).union(optionalHosts) : Set(wanted.sites.compactMap(Self.pattern))
    context.grantedPermissionMatchPatterns = Dictionary(uniqueKeysWithValues: patterns.map { ($0, forever) })
    context.hasAccessToPrivateData = isPrivate || wanted.incognito
    if wanted.allSites { allSites.insert(wanted.id) } else { allSites.remove(wanted.id) }
  }

  func sync(_ wanted: [WebKitExtensions.Wanted], done: @escaping ([String], [String]) -> Void) {
    let previous = syncing
    syncing = Task { @MainActor in
      await previous?.value
      guard !closed else { return done([], []) }
      let ids = Set(wanted.map(\.id))
      for id in loaded.keys where !ids.contains(id) { unload(id) }
      var ready: [String] = []
      var failed: [String] = []
      for want in wanted {
        if var current = loaded[want.id], current.signature == want.signature {
          grant(current.context, want)
          current.grants = want.grants
          if current.nativeMessaging, !want.nativeMessaging { bridge.closeHosts(of: want.id) }
          current.nativeMessaging = want.nativeMessaging
          loaded[want.id] = current
          ready.append(want.id)
          continue
        }
        if loaded[want.id] != nil { unload(want.id) }
        do {
          let webExtension = try await WKWebExtension(resourceBaseURL: want.folder)
          guard !closed else { continue }
          let context = WKWebExtensionContext(for: webExtension)
          context.uniqueIdentifier = want.id
          if let base = URL(string: "webkit-extension://\(want.id)/") { context.baseURL = base }
          context.isInspectable = WebKitHub.inspectable && !isPrivate
          context.inspectionName = want.name
          grant(context, want)
          try controller.load(context)
          loaded[want.id] = Loaded(
            id: want.id, context: context, signature: want.signature, apis: want.apis, nativeMessaging: want.nativeMessaging, grants: want.grants,
            sidePanel: WebKitExtensionSidePanel(manifest: webExtension.manifest))
          ready.append(want.id)
          for tab in openTabs() {
            context.didOpenTab(tab)
            openedTabs.insert(ObjectIdentifier(tab))
          }
          if isPrivate { ArdiaEvents.emit("webKit.counted", data: ArdiaConsentStamp.begin().onto(["name": "privateExtensionLoaded"])) }
        } catch {
          NSLog("[webkit] extension %@ didn't load: %@", want.id, error.localizedDescription)
          failed.append(want.id)
        }
      }
      layoutChanged()
      bridge.announce()
      done(ready, failed)
    }
  }

  private func unload(_ id: String) {
    guard let entry = loaded.removeValue(forKey: id) else { return }
    allSites.remove(id)
    bridge.dropExtension(id)
    try? controller.unload(entry.context)
  }

  func unloadAll() {
    closed = true
    loaded.keys.forEach(unload)
    bridge.closeAll()
    for id in Array(requests.keys) { answered(id, ["error": "The extension isn't loaded."]) }
    for (key, arrival) in arrivals {
      arrivals.removeValue(forKey: key)
      arrival.timeout.cancel()
      arrival.done(nil)
    }
  }

  func startDownload(_ options: [String: Any]) throws -> [String: Any] {
    guard let text = options["url"] as? String, let url = URL(string: text), let scheme = url.scheme?.lowercased(), ["http", "https", "data"].contains(scheme) else {
      throw WebKitExtensionBridge.failure("Invalid URL.")
    }
    var request = URLRequest(url: url)
    if (options["method"] as? String)?.uppercased() == "POST" { request.httpMethod = "POST" }
    for header in options["headers"] as? [[String: Any]] ?? [] {
      guard let name = header["name"] as? String, let value = header["value"] as? String else { continue }
      guard !WebKitExtensionAccess.isForbiddenHeader(name) else { throw WebKitExtensionBridge.failure("Unsafe request header name") }
      request.setValue(value, forHTTPHeaderField: name)
    }
    if let body = options["body"] as? String { request.httpBody = Data(body.utf8) }
    let view: WKWebView = openTabs().first?.webView ?? WebKitHub.shared.resumeHost(for: profile)
    let owner = profile
    view.startDownload(using: request) { [weak view] download in WebKitHub.shared.downloads.adopt(download, profile: owner, webView: view) }
    var started: [String: Any] = ["url": url.absoluteString]
    if let filename = options["filename"] as? String { started["filename"] = filename }
    return started
  }

  func webExtensionController(_ controller: WKWebExtensionController, sendMessage message: Any, toApplicationWithIdentifier applicationIdentifier: String?,
                              for extensionContext: WKWebExtensionContext, replyHandler: @escaping (Any?, (any Error)?) -> Void) {
    bridge.sendMessage(message, to: applicationIdentifier, from: extensionContext, reply: replyHandler)
  }

  func webExtensionController(_ controller: WKWebExtensionController, connectUsing port: WKWebExtension.MessagePort, for extensionContext: WKWebExtensionContext,
                              completionHandler: @escaping ((any Error)?) -> Void) {
    bridge.connect(port, from: extensionContext, completion: completionHandler)
  }
}
