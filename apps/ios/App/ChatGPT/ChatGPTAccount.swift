import ArdiaBrowser
import AuthenticationServices
import Foundation
import Observation
import SwiftUI

@MainActor
@Observable
final class ChatGPTAccount {
  static let connectionKey = "connection"
  static var registrationKey: String { "registration \(issuer.absoluteString)" }
  static let issuerOverrideKey = "ArdiaChatGPTIssuer"
  static let apiOverrideKey = "ArdiaChatGPTAPI"
  static let usageURL = URL(string: "https://chatgpt.com/settings/usage")!

  private(set) var connection: ChatGPTConnection?
  private(set) var isSigningIn = false
  private(set) var problem: String?

  @ObservationIgnored private var refreshing: Task<ChatGPTConnection, Error>?

  init() {
    connection = KeychainSecret.read(Self.connectionKey).flatMap { try? JSONDecoder().decode(ChatGPTConnection.self, from: $0) }
    if let connection, connection.endpoints.issuer != Self.issuer { self.connection = nil }
  }

  var isConnected: Bool { connection != nil }
  var model: ChatGPTModel? { connection?.model }
  var models: [ChatGPTModel] { connection?.models ?? [] }
  var accountLabel: String? { connection.map { $0.identity.email ?? $0.identity.name ?? String(localized: "ChatGPT account") } }

  static var issuer: URL {
    #if DEBUG
    if let value = UserDefaults.standard.string(forKey: issuerOverrideKey), let url = URL(string: value) { return url }
    #endif
    return ChatGPTEndpoints.openAIIssuer
  }

  static var api: URL {
    #if DEBUG
    if let value = UserDefaults.standard.string(forKey: apiOverrideKey), let url = URL(string: value) { return url }
    #endif
    return ChatGPTEndpoints.openAIAPI
  }

  func choose(_ model: ChatGPTModel) {
    guard var connection else { return }
    connection.chosenModel = model.slug
    save(connection)
  }

  func clearProblem() { problem = nil }

  @discardableResult
  func signIn(using session: WebAuthenticationSession) async -> Bool {
    guard !isSigningIn else { return false }
    isSigningIn = true
    problem = nil
    defer { isSigningIn = false }
    do {
      let connection = try await authorize(using: session)
      save(connection)
      await loadModels()
      return true
    } catch ChatGPTFailure.cancelled {
      return false
    } catch let failure as ChatGPTFailure {
      problem = failure.message
      return false
    } catch {
      problem = ChatGPTFailure.network.message
      return false
    }
  }

  func disconnect() async {
    if let refreshing { _ = try? await refreshing.value }
    guard let connection else { return }
    self.connection = nil
    KeychainSecret.delete(Self.connectionKey)
    if await !revoke(connection) {
      problem = String(localized: "Disconnected on this iPhone, but OpenAI didn’t confirm it. You can also remove Ardia in ChatGPT’s settings.")
    }
  }

  private func revoke(_ connection: ChatGPTConnection) async -> Bool {
    guard let revocation = connection.endpoints.revocation else { return false }
    var request = URLRequest(url: revocation, timeoutInterval: 10)
    request.httpMethod = "POST"
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    request.httpBody = ChatGPTAuthorization.revocation(refreshToken: connection.tokens.refreshToken, clientID: connection.clientID)
    for attempt in 0..<2 {
      let status = (try? await ChatGPTHTTP.data(for: request))?.1
      if status == 200 { return true }
      guard attempt == 0, status.map({ $0 >= 500 }) ?? true else { return false }
      try? await Task.sleep(for: .milliseconds(300))
    }
    return false
  }

  func validConnection(forceRefresh: Bool = false) async throws -> ChatGPTConnection {
    guard let connection else { throw ChatGPTFailure.expired }
    guard forceRefresh || connection.tokens.needsRefresh() else { return connection }
    if let refreshing { return try await refreshing.value }
    let task = Task { try await self.refresh(connection) }
    refreshing = task
    defer { refreshing = nil }
    return try await task.value
  }

  func currentModel() async throws -> ChatGPTModel {
    if let model { return model }
    await loadModels()
    guard let model else { throw ChatGPTFailure.unsupported }
    return model
  }

  func failed(_ failure: ChatGPTFailure) {
    guard failure.requiresSignIn else { return }
    signOutLocally(failure)
  }

  private func authorize(using session: WebAuthenticationSession) async throws -> ChatGPTConnection {
    let endpoints = try await discover()
    let previousSubject = connection?.identity.subject
    let server = try LoopbackCallbackServer.start()
    defer { server.stop() }
    let savedClientID = KeychainSecret.read(Self.registrationKey).map { String(decoding: $0, as: UTF8.self) }.flatMap { ChatGPTAuth.isValidClientID($0) ? $0 : nil }
    let authorization = ChatGPTAuthorization(port: server.port, savedClientID: savedClientID, loginHint: connection?.identity.email)
    server.expect(state: authorization.state, savedClientID: savedClientID)
    var browserFailed = false
    do {
      _ = try await session.authenticate(
        using: authorization.url(endpoint: endpoints.authorization),
        callback: .customScheme(ChatGPTAuth.finishedScheme),
        preferredBrowserSession: .shared,
        additionalHeaderFields: [:]
      )
    } catch {
      browserFailed = true
    }
    switch server.receivedOutcome {
    case nil:
      throw browserFailed ? ChatGPTFailure.cancelled : ChatGPTFailure.signInIncomplete
    case .denied(let code):
      throw ChatGPTFailure.classify(code: code, status: nil)
    case .incomplete:
      throw ChatGPTFailure.signInIncomplete
    case .code(let code, let clientID):
      KeychainSecret.write(Data(clientID.utf8), account: Self.registrationKey)
      var request = URLRequest(url: endpoints.token, timeoutInterval: 30)
      request.httpMethod = "POST"
      request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
      request.setValue("application/json", forHTTPHeaderField: "Accept")
      request.httpBody = authorization.codeExchange(code: code, clientID: clientID)
      let (data, status) = try await ChatGPTHTTP.data(for: request)
      guard status == 200 else { throw ChatGPTFailure.api(data, status: status) }
      let tokens = try ChatGPTTokens.parse(data)
      guard let idToken = tokens.idToken else { throw ChatGPTFailure.invalidIdentity }
      let identity = try await verifiedIdentity(idToken: idToken, endpoints: endpoints, clientID: clientID, nonce: authorization.nonce)
      if let previousSubject, identity.subject != previousSubject { throw ChatGPTFailure.accountMismatch }
      let previous = connection?.chosenModel
      return ChatGPTConnection(clientID: clientID, identity: identity, tokens: tokens, endpoints: endpoints, chosenModel: previous)
    }
  }

  private func discover() async throws -> ChatGPTEndpoints {
    let issuer = Self.issuer
    let (data, status) = try await ChatGPTHTTP.data(for: URLRequest(url: ChatGPTEndpoints.discoveryURL(issuer: issuer), timeoutInterval: 15))
    guard status == 200 else { throw ChatGPTFailure.discoveryFailed }
    return try ChatGPTEndpoints.fromDiscovery(data, issuer: issuer, api: Self.api)
  }

  private func refresh(_ previous: ChatGPTConnection) async throws -> ChatGPTConnection {
    var request = URLRequest(url: previous.endpoints.token, timeoutInterval: 30)
    request.httpMethod = "POST"
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.httpBody = ChatGPTAuthorization.refresh(refreshToken: previous.tokens.refreshToken, clientID: previous.clientID)
    let (data, status) = try await ChatGPTHTTP.data(for: request)
    do {
      guard status == 200 else { throw ChatGPTFailure.api(data, status: status) }
      let tokens = try ChatGPTTokens.parse(data, previousScopes: previous.tokens.scopes)
      var next = connection ?? previous
      next.tokens = tokens
      save(next)
      if let idToken = tokens.idToken {
        do {
          try next.confirm(await verifiedIdentity(idToken: idToken, endpoints: next.endpoints, clientID: next.clientID, nonce: nil))
          save(next)
        } catch ChatGPTFailure.unavailable {
        }
      }
      return next
    } catch let failure as ChatGPTFailure {
      if failure.requiresSignIn { signOutLocally(failure) }
      throw failure
    }
  }

  private func verifiedIdentity(idToken: String, endpoints: ChatGPTEndpoints, clientID: String, nonce: String?) async throws -> ChatGPTIdentity {
    let keys: Data
    do {
      let (data, status) = try await ChatGPTHTTP.data(for: URLRequest(url: endpoints.jwks, timeoutInterval: 15))
      guard status == 200 else { throw ChatGPTFailure.unavailable }
      keys = data
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw ChatGPTFailure.unavailable
    }
    try ChatGPTSignature.verify(idToken: idToken, jwks: keys)
    return try ChatGPTIdentity.verify(idToken: idToken, issuer: endpoints.issuer, clientID: clientID, nonce: nonce)
  }

  private func loadModels() async {
    guard let connection else { return }
    do {
      let current = try await validConnection()
      var request = URLRequest(url: current.endpoints.api.appending(path: "models"), timeoutInterval: 20)
      request.setValue("Bearer \(current.tokens.accessToken)", forHTTPHeaderField: "Authorization")
      request.setValue("application/json", forHTTPHeaderField: "Accept")
      let (data, status) = try await ChatGPTHTTP.data(for: request)
      guard status == 200 else { throw ChatGPTFailure.api(data, status: status) }
      let models = try ChatGPTModel.catalog(data)
      guard var latest = self.connection, latest.identity.subject == connection.identity.subject else { return }
      latest.models = models
      save(latest)
    } catch let failure as ChatGPTFailure {
      failed(failure)
    } catch {}
  }

  private func save(_ connection: ChatGPTConnection) {
    self.connection = connection
    guard let data = try? JSONEncoder().encode(connection) else { return }
    if !KeychainSecret.write(data, account: Self.connectionKey) { KeychainSecret.write(data, account: Self.connectionKey) }
  }

  private func signOutLocally(_ failure: ChatGPTFailure) {
    connection = nil
    KeychainSecret.delete(Self.connectionKey)
    problem = failure.message
  }
}

enum ChatGPTHTTP {
  static let session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    configuration.httpShouldSetCookies = false
    return URLSession(configuration: configuration, delegate: RefuseRedirects(), delegateQueue: nil)
  }()

  static func data(for request: URLRequest) async throws -> (Data, Int) {
    do {
      let (data, response) = try await session.data(for: request)
      return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
    } catch is CancellationError {
      throw CancellationError()
    } catch let error as URLError where error.code == .cancelled {
      throw CancellationError()
    } catch {
      throw ChatGPTFailure.network
    }
  }

  nonisolated final class RefuseRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
      completionHandler(nil)
    }
  }
}
