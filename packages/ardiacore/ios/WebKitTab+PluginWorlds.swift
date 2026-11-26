import Foundation
import WebKit

extension WebKitTab {
  static let pluginStylesWorld = "ardia-plugin-styles"

  func pluginDocument(_ completion: @escaping (String?) -> Void) {
    completion(closed || webView == nil ? nil : WebKitPluginWorldHandler.document(of: self))
  }

  private func pluginNonce(_ world: String, document: String, view: WKWebView, content: WKContentWorld, then: @escaping (String?) -> Void) {
    let serial = documentSerial
    if let known = pluginNonces[world], known.serial == serial { return then(known.nonce) }
    view.evaluateJavaScript(WebKitPluginWorldHandler.nonceScript, in: nil, in: content) { [weak self] result in
      guard let self, !self.closed, self.documentSerial == serial, WebKitPluginWorldHandler.document(of: self) == document, case .success(let value) = result,
        let nonce = WebKitPluginWorldHandler.isNonce(value)
      else { return then(nil) }
      self.pluginNonces = self.pluginNonces.filter { $0.value.serial == serial }
      self.pluginNonces[world] = (serial, nonce)
      then(nonce)
    }
  }

  func runPluginWorld(_ world: String, source: String, document: String, completion: @escaping (Bool) -> Void) {
    let plugin = WebKitPluginWorldHandler.isPluginWorld(world)
    guard plugin || world == Self.pluginStylesWorld, !closed, let view = webView, WebKitPluginWorldHandler.document(of: self) == document else { return completion(false) }
    let content = plugin ? WebKitPluginWorldHandler.attach(view: view, world: world) : WKContentWorld.world(name: world)
    pluginNonce(world, document: document, view: view, content: content) { [weak self, weak view] nonce in
      guard let self, let view, let nonce, !self.closed, self.webView === view, WebKitPluginWorldHandler.document(of: self) == document else { return completion(false) }
      view.evaluateJavaScript(WebKitPluginWorldHandler.guarded(nonce, source), in: nil, in: content) { [weak self, weak view] result in
        guard let self, WebKitPluginWorldHandler.document(of: self) == document else {
          if plugin, let view, let stale = WebKitPluginWorldHandler.staleTeardown(document) { view.evaluateJavaScript(stale, in: nil, in: content) { _ in } }
          return completion(false)
        }
        guard case .success(let value) = result, (value as? String) != WebKitPluginWorldHandler.stale else { return completion(false) }
        completion((value as? Bool) ?? ((value as? String).map { !$0.isEmpty } ?? true))
      }
    }
  }

  func postPluginWorld(_ world: String, expression: String, document: String) {
    guard WebKitPluginWorldHandler.isPluginWorld(world), !closed, let view = webView, WebKitPluginWorldHandler.document(of: self) == document else { return }
    let content = WKContentWorld.world(name: world)
    pluginNonce(world, document: document, view: view, content: content) { [weak self, weak view] nonce in
      guard let self, let view, let nonce, self.webView === view, WebKitPluginWorldHandler.document(of: self) == document else { return }
      view.evaluateJavaScript(WebKitPluginWorldHandler.guarded(nonce, expression), in: nil, in: content) { _ in }
    }
  }

  func removePluginWorld(_ world: String, teardown: String) {
    guard let view = webView else { return }
    view.evaluateJavaScript(teardown, in: nil, in: WKContentWorld.world(name: world)) { _ in }
    if WebKitPluginWorldHandler.isPluginWorld(world) { WebKitPluginWorldHandler.detach(view: view, world: world) }
  }
}
