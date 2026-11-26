import Foundation
import WebKit

final class WebKitPluginWorldHandler: NSObject, WKScriptMessageHandler {
  static let name = "ardiaPluginWorld"
  static let prefix = "ardia-plugin:"
  static let maxJSON = 256 * 1024
  private static var registered: [ObjectIdentifier: Set<String>] = [:]

  private let world: String

  private init(world: String) {
    self.world = world
  }

  static func isPluginWorld(_ world: String) -> Bool {
    guard world.hasPrefix(prefix), world.count <= prefix.count + 123 else { return false }
    let parts = world.dropFirst(prefix.count).split(separator: "~", omittingEmptySubsequences: false)
    let ascii = { (c: Character) in c.isASCII && (c.isLetter || c.isNumber || c == "-" || c == "_") }
    guard (1...2).contains(parts.count), let key = parts.first, (1...82).contains(key.count), key.allSatisfy({ ascii($0) && !$0.isUppercase }) else { return false }
    return parts.count == 1 || ((1...40).contains(parts[1].count) && parts[1].allSatisfy(ascii))
  }

  static func document(of tab: WebKitTab) -> String { "wk-\(tab.browserId)-\(tab.documentSerial)" }

  static let nonceScript =
    "(() => { if (!Object.prototype.hasOwnProperty.call(globalThis, '__ardiaDocNonce')) { const bytes = new Uint8Array(16); crypto.getRandomValues(bytes); "
    + "Object.defineProperty(globalThis, '__ardiaDocNonce', { value: Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''), writable: false, configurable: false }); } "
    + "return globalThis.__ardiaDocNonce; })()"
  static let stale = "__ardia_stale__"

  static func isNonce(_ value: Any?) -> String? {
    guard let text = value as? String, text.count == 32, text.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else { return nil }
    return text
  }

  static func guarded(_ nonce: String, _ expression: String) -> String {
    "(() => { if (globalThis.__ardiaDocNonce !== \"\(nonce)\") return \"\(stale)\"; return (\n\(expression)\n); })()"
  }

  static func staleTeardown(_ document: String) -> String? {
    guard !document.isEmpty, document.count <= 120, document.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
    return "(() => { const host = globalThis.__ardiaWorld; return !!host && host.native === \"\(document)\" && host.teardown(host.doc); })()"
  }

  static func attach(view: WKWebView, world: String) -> WKContentWorld {
    let content = WKContentWorld.world(name: world)
    let controller = view.configuration.userContentController
    let key = ObjectIdentifier(controller)
    var names = registered[key] ?? []
    if !names.contains(world) {
      controller.add(WebKitPluginWorldHandler(world: world), contentWorld: content, name: name)
      names.insert(world)
      registered[key] = names
    }
    return content
  }

  static func detach(view: WKWebView, world: String) {
    let controller = view.configuration.userContentController
    let key = ObjectIdentifier(controller)
    guard registered[key]?.contains(world) == true else { return }
    controller.removeScriptMessageHandler(forName: name, contentWorld: WKContentWorld.world(name: world))
    registered[key]?.remove(world)
    if registered[key]?.isEmpty == true { registered[key] = nil }
  }

  static func detachAll(view: WKWebView?) {
    guard let view else { return }
    let key = ObjectIdentifier(view.configuration.userContentController)
    for world in registered[key] ?? [] { detach(view: view, world: world) }
    registered[key] = nil
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.world.name == world, message.frameInfo.isMainFrame, let webView = message.webView, let tab = WebKitHub.shared.transfers.owner(of: webView), !tab.closed,
      let body = message.body as? [String: Any], body["world"] as? String == world, let json = body["json"] as? String, json.utf8.count <= Self.maxJSON, let tabId = tab.transferKey
    else { return }
    ArdiaEvents.emit("webView.pluginWorld", data: ArdiaConsentStamp.begin().onto(["tabId": tabId, "world": world, "document": Self.document(of: tab), "json": "[\(json)]"]))
  }
}
