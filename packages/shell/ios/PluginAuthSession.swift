import AppKit
import ArdiaCore
import AuthenticationServices
import Foundation

final class PluginAuthSession: NSObject, ASWebAuthenticationPresentationContextProviding {
  static let timeout: TimeInterval = 5 * 60
  private static var live: [String: PluginAuthSession] = [:]

  private let key: String
  private let plugin: String
  private let run: Int
  private let request: PluginAuthRequest
  private var session: ASWebAuthenticationSession?
  private var reply: (([String: Any]) -> Void)?

  private init(plugin: String, run: Int, request: PluginAuthRequest, reply: @escaping ([String: Any]) -> Void) {
    self.key = "\(plugin)#\(run)"
    self.plugin = plugin
    self.run = run
    self.request = request
    self.reply = reply
  }

  static func start(_ spec: [String: Any], reply: @escaping ([String: Any]) -> Void) {
    guard !LaunchConfig.shared.background else { return reply(PluginHostFetch.failed("a background instance doesn't open sign-in windows")) }
    guard let plugin = spec["plugin"] as? String, let run = (spec["run"] as? NSNumber)?.intValue, let scope = spec["scope"] as? String, let name = spec["pluginName"] as? String,
      let authorize = spec["authorizeUrl"] as? String, let clientId = spec["clientId"] as? String
    else { return reply(PluginHostFetch.failed("signIn needs a plugin, authorizeUrl and clientId")) }
    guard PluginHost.shared.isLive(plugin, run: run) else { return reply(PluginHostFetch.failed("the plugin's run has ended")) }
    guard !live.values.contains(where: { $0.plugin == plugin }) else { return reply(PluginHostFetch.failed("this plugin already has a sign-in open")) }
    guard let state = PluginAuthRequest.randomToken(), let verifier = PluginAuthRequest.randomToken(48) else { return reply(PluginHostFetch.failed("Ardia couldn't make a sign-in secret")) }
    let scopes = spec["scopes"] as? [String] ?? []
    let extra = (spec["extraParams"] as? [String: Any] ?? [:]).compactMapValues { $0 as? String }
    switch PluginAuthRequest.make(authorize: authorize, clientId: clientId, scopes: scopes, scope: scope, name: name, extra: extra, state: state, verifier: verifier) {
    case .failure(let refusal): reply(PluginHostFetch.failed(refusal.reason))
    case .success(let request):
      let made = PluginAuthSession(plugin: plugin, run: run, request: request, reply: reply)
      live[made.key] = made
      made.open()
      DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak made] in made?.end(reason: "the sign-in took longer than \(Int(timeout / 60)) minutes") }
    }
  }

  private func open() {
    let done: (URL?, Error?) -> Void = { [weak self] callback, error in
      DispatchQueue.main.async { self?.finish(callback, error) }
    }
    let made: ASWebAuthenticationSession
    if #available(macOS 14.4, *) {
      made = ASWebAuthenticationSession(url: request.authorizeURL, callback: .customScheme(PluginAuthRequest.scheme), completionHandler: done)
    } else {
      made = ASWebAuthenticationSession(url: request.authorizeURL, callbackURLScheme: PluginAuthRequest.scheme, completionHandler: done)
    }
    made.prefersEphemeralWebBrowserSession = true
    made.presentationContextProvider = self
    session = made
    if !made.start() { finish(nil, nil) }
  }

  static func cancel(plugin: String, run: Int) {
    for session in live.values where session.plugin == plugin && (run == 0 || session.run == run) { session.end(reason: "the plugin stopped") }
  }

  private func end(reason: String) {
    guard let reply else { return }
    self.reply = nil
    let current = session
    session = nil
    Self.live[key] = nil
    current?.cancel()
    reply(["ok": false, "reason": reason, "cancelled": true])
  }

  private func finish(_ callback: URL?, _ error: Error?) {
    guard let reply else { return }
    self.reply = nil
    session = nil
    Self.live[key] = nil
    guard PluginHost.shared.isLive(plugin, run: run) else { return reply(["ok": false, "reason": "the plugin stopped", "cancelled": true]) }
    if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
      return reply(["ok": false, "reason": "you closed the sign-in", "cancelled": true])
    }
    guard let callback else { return reply(PluginHostFetch.failed(error?.localizedDescription ?? "the sign-in didn't start")) }
    switch request.code(from: callback) {
    case .failure(let refusal): reply(PluginHostFetch.failed(refusal.reason))
    case .success(let code): reply(["ok": true, "code": code, "verifier": request.verifier, "redirectUri": request.redirectURI])
    }
  }

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    NSApp.keyWindow ?? NSApp.mainWindow ?? NSApp.windows.first { $0.isVisible } ?? NSWindow()
  }
}
