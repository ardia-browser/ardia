import CryptoKit
import Foundation

public struct ChatGPTEndpoints: Equatable, Sendable, Codable {
  public var issuer: URL
  public var authorization: URL
  public var token: URL
  public var revocation: URL?
  public var api: URL

  public static let openAIIssuer = URL(string: "https://auth.openai.com")!
  public static let openAIAPI = URL(string: "https://api.openai.com/v1")!

  public init(issuer: URL, authorization: URL, token: URL, revocation: URL?, api: URL) {
    self.issuer = issuer
    self.authorization = authorization
    self.token = token
    self.revocation = revocation
    self.api = api
  }

  public static func discoveryURL(issuer: URL) -> URL {
    issuer.appending(path: ".well-known/openid-configuration")
  }

  public static func fromDiscovery(_ data: Data, issuer: URL, api: URL) throws(ChatGPTFailure) -> ChatGPTEndpoints {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          object["issuer"] as? String == issuer.absoluteString.trimmingSuffix("/") else {
      throw .discoveryFailed
    }
    func endpoint(_ key: String) -> URL? {
      guard let value = object[key] as? String, let url = URL(string: value), url.sameOrigin(as: issuer) else { return nil }
      return url
    }
    guard let authorization = endpoint("authorization_endpoint"), let token = endpoint("token_endpoint") else {
      throw .discoveryFailed
    }
    if object["revocation_endpoint"] != nil, endpoint("revocation_endpoint") == nil { throw .discoveryFailed }
    return ChatGPTEndpoints(issuer: issuer, authorization: authorization, token: token, revocation: endpoint("revocation_endpoint"), api: api)
  }
}

public enum ChatGPTAuth {
  public static let resource = "https://api.openai.com/v1"
  public static let scopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
  public static let planUsageScope = "chatgpt.tokens.use.direct"
  public static let callbackPath = "/auth/callback"
  public static let dynamicClient = "dynamic_agent_client"
  public static let appName = "Ardia"
  public static let finishedScheme = "ardia-chatgpt"
  public static let finishedURL = URL(string: "ardia-chatgpt://signed-in")!

  public static func randomValue() -> String {
    var generator = SystemRandomNumberGenerator()
    let bytes = (0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
    return Data(bytes).base64URLEncoded()
  }

  public static func challenge(for verifier: String) -> String {
    Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncoded()
  }

  public static func isValidClientID(_ value: String) -> Bool {
    value != dynamicClient && (1...200).contains(value.count) && value.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }
  }
}

public struct ChatGPTAuthorization: Sendable {
  public let state: String
  public let nonce: String
  public let verifier: String
  public let port: UInt16
  public let savedClientID: String?
  public let loginHint: String?

  public init(port: UInt16, savedClientID: String?, loginHint: String? = nil, state: String = ChatGPTAuth.randomValue(), nonce: String = ChatGPTAuth.randomValue(), verifier: String = ChatGPTAuth.randomValue()) {
    self.port = port
    self.savedClientID = savedClientID
    self.loginHint = loginHint
    self.state = state
    self.nonce = nonce
    self.verifier = verifier
  }

  public var redirectURI: String { "http://127.0.0.1:\(port)\(ChatGPTAuth.callbackPath)" }

  public func url(endpoint: URL) -> URL {
    var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)!
    var items = [
      URLQueryItem(name: "client_id", value: savedClientID ?? ChatGPTAuth.dynamicClient),
      URLQueryItem(name: "response_type", value: "code"),
      URLQueryItem(name: "redirect_uri", value: redirectURI),
      URLQueryItem(name: "scope", value: ChatGPTAuth.scopes),
      URLQueryItem(name: "resource", value: ChatGPTAuth.resource),
      URLQueryItem(name: "state", value: state),
      URLQueryItem(name: "nonce", value: nonce),
      URLQueryItem(name: "code_challenge_method", value: "S256"),
      URLQueryItem(name: "code_challenge", value: ChatGPTAuth.challenge(for: verifier)),
    ]
    if savedClientID == nil { items.append(URLQueryItem(name: "agent_name_hint", value: ChatGPTAuth.appName)) }
    if let loginHint { items.append(URLQueryItem(name: "login_hint", value: loginHint)) }
    components.percentEncodedQuery = items.map { "\($0.name)=\(Self.formEncoded($0.value ?? ""))" }.joined(separator: "&")
    return components.url!
  }

  public func codeExchange(code: String, clientID: String) -> Data {
    Self.form([
      ("grant_type", "authorization_code"),
      ("client_id", clientID),
      ("code", code),
      ("code_verifier", verifier),
      ("redirect_uri", redirectURI),
      ("resource", ChatGPTAuth.resource),
    ])
  }

  public static func refresh(refreshToken: String, clientID: String) -> Data {
    form([
      ("grant_type", "refresh_token"),
      ("client_id", clientID),
      ("refresh_token", refreshToken),
      ("resource", ChatGPTAuth.resource),
    ])
  }

  public static func revocation(refreshToken: String, clientID: String) -> Data {
    form([("token", refreshToken), ("token_type_hint", "refresh_token"), ("client_id", clientID)])
  }

  static let formAllowed: CharacterSet = {
    var set = CharacterSet.alphanumerics
    set.insert(charactersIn: "-._~")
    return set
  }()

  static func formEncoded(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: formAllowed) ?? value
  }

  static func form(_ pairs: [(String, String)]) -> Data {
    Data(pairs.map { "\($0.0)=\(formEncoded($0.1))" }.joined(separator: "&").utf8)
  }
}

public struct LoopbackRequest: Equatable, Sendable {
  public enum Outcome: Equatable, Sendable {
    case code(code: String, clientID: String)
    case denied(String)
    case incomplete
  }

  public enum Reply: Equatable, Sendable {
    case notFound
    case badState
    case finish(Outcome)
  }

  public static func evaluate(_ head: String, port: UInt16, state: String, savedClientID: String?) -> Reply {
    let lines = head.components(separatedBy: "\r\n")
    let requestLine = lines.first?.split(separator: " ", omittingEmptySubsequences: true) ?? []
    guard requestLine.count == 3, requestLine[0] == "GET" else { return .notFound }
    let host = lines.dropFirst().first { $0.lowercased().hasPrefix("host:") }.map { $0.dropFirst(5).trimmingCharacters(in: .whitespaces) }
    guard host == "127.0.0.1:\(port)",
          let components = URLComponents(string: "http://127.0.0.1:\(port)\(requestLine[1])"),
          components.path == ChatGPTAuth.callbackPath else { return .notFound }
    let items = components.queryItems ?? []
    func values(_ name: String) -> [String] { items.filter { $0.name == name }.compactMap(\.value) }
    let states = values("state")
    guard states.count == 1, constantTimeEqual(states[0], state) else { return .badState }
    if let error = values("error").first { return .finish(.denied(error)) }
    let codes = values("code")
    let returnedClients = values("client_id")
    guard codes.count == 1, !codes[0].isEmpty, returnedClients.count <= 1 else { return .finish(.incomplete) }
    guard let clientID = returnedClients.first ?? savedClientID, ChatGPTAuth.isValidClientID(clientID) else { return .finish(.incomplete) }
    if let savedClientID, let returned = returnedClients.first, returned != savedClientID { return .finish(.incomplete) }
    return .finish(.code(code: codes[0], clientID: clientID))
  }

  public static func response(for reply: Reply) -> Data {
    let headers = "Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n"
    switch reply {
    case .notFound:
      return Data("HTTP/1.1 404 Not Found\r\n\(headers)Content-Length: 0\r\n\r\n".utf8)
    case .badState:
      let body = "Invalid sign-in state. Start again from Ardia."
      return Data("HTTP/1.1 400 Bad Request\r\n\(headers)Content-Type: text/plain; charset=utf-8\r\nContent-Length: \(body.utf8.count)\r\n\r\n\(body)".utf8)
    case .finish:
      let url = ChatGPTAuth.finishedURL.absoluteString
      let body = "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\"><title>Return to Ardia</title><body style=\"font:17px system-ui;margin:20vh 24px\"><h1>Return to Ardia</h1><p><a href=\"\(url)\">Back to Ardia</a></p>"
      return Data("HTTP/1.1 302 Found\r\n\(headers)Location: \(url)\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(body.utf8.count)\r\n\r\n\(body)".utf8)
    }
  }

  static func constantTimeEqual(_ lhs: String, _ rhs: String) -> Bool {
    let a = Array(lhs.utf8)
    let b = Array(rhs.utf8)
    guard a.count == b.count else { return false }
    return zip(a, b).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
  }
}

public struct ChatGPTTokens: Equatable, Sendable, Codable {
  public var accessToken: String
  public var refreshToken: String
  public var expiresAt: Date
  public var scopes: [String]
  public var idToken: String?

  public init(accessToken: String, refreshToken: String, expiresAt: Date, scopes: [String], idToken: String?) {
    self.accessToken = accessToken
    self.refreshToken = refreshToken
    self.expiresAt = expiresAt
    self.scopes = scopes
    self.idToken = idToken
  }

  public func needsRefresh(at date: Date = .now) -> Bool { expiresAt.timeIntervalSince(date) < 120 }

  public static func parse(_ data: Data, previousScopes: [String]? = nil, now: Date = .now) throws(ChatGPTFailure) -> ChatGPTTokens {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw .invalidTokenResponse }
    guard let scope = (object["scope"] as? String).map({ $0.split(whereSeparator: \.isWhitespace).map(String.init) }) ?? previousScopes else {
      throw .invalidTokenResponse
    }
    guard scope.contains(ChatGPTAuth.planUsageScope) else { throw .planUsageNotGranted }
    guard let access = object["access_token"] as? String, !access.isEmpty,
          (object["token_type"] as? String)?.lowercased() == "bearer",
          let expires = (object["expires_in"] as? NSNumber)?.doubleValue, expires > 0,
          let refresh = object["refresh_token"] as? String, !refresh.isEmpty else {
      throw .invalidTokenResponse
    }
    if let idToken = object["id_token"], (idToken as? String)?.isEmpty ?? true { throw .invalidIdentity }
    return ChatGPTTokens(accessToken: access, refreshToken: refresh, expiresAt: now.addingTimeInterval(expires), scopes: scope, idToken: object["id_token"] as? String)
  }
}

public struct ChatGPTIdentity: Equatable, Sendable, Codable {
  public var subject: String
  public var email: String?
  public var name: String?

  public init(subject: String, email: String?, name: String?) {
    self.subject = subject
    self.email = email
    self.name = name
  }

  public static func verify(idToken: String, issuer: URL, clientID: String, nonce: String?, now: Date = .now) throws(ChatGPTFailure) -> ChatGPTIdentity {
    let parts = idToken.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 3, let header = Data(base64URLEncoded: String(parts[0])),
          (try? JSONSerialization.jsonObject(with: header) as? [String: Any])?["alg"] as? String == "RS256",
          let payload = Data(base64URLEncoded: String(parts[1])),
          let claims = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
      throw .invalidIdentity
    }
    let audiences: [String] = (claims["aud"] as? String).map { [$0] } ?? (claims["aud"] as? [String]) ?? []
    let azp = claims["azp"] as? String
    guard claims["iss"] as? String == issuer.absoluteString.trimmingSuffix("/"),
          audiences.contains(clientID),
          audiences.count == 1 || azp == clientID,
          azp == nil || azp == clientID,
          let expires = (claims["exp"] as? NSNumber)?.doubleValue, Date(timeIntervalSince1970: expires + 5) > now,
          claims["iat"] is NSNumber,
          let subject = claims["sub"] as? String, !subject.isEmpty,
          nonce == nil || claims["nonce"] as? String == nonce else {
      throw .invalidIdentity
    }
    return ChatGPTIdentity(subject: subject, email: claims["email"] as? String, name: claims["name"] as? String)
  }
}

public enum ChatGPTFailure: Error, Equatable, Sendable {
  case cancelled
  case discoveryFailed
  case signInIncomplete
  case denied
  case invalidTokenResponse
  case invalidIdentity
  case planUsageNotGranted
  case accountMismatch
  case expired
  case notEligible
  case usageLimit
  case unsupported
  case rejected(Int?)
  case unavailable
  case network
  case streamInterrupted

  static let reauthenticationCodes: Set<String> = [
    "invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused",
  ]

  public static func api(_ data: Data?, status: Int?) -> ChatGPTFailure {
    var detail = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
    for _ in 0..<4 {
      if let inner = detail["error"] as? [String: Any] { detail = inner }
      else if let inner = detail["response"] as? [String: Any] { detail = inner }
      else if let inner = detail["detail"] as? [String: Any] { detail = inner }
      else { break }
    }
    let code = (detail["error"] as? String) ?? (detail["code"] as? String) ?? ""
    return classify(code: code, status: status)
  }

  public static func classify(code: String, status: Int?) -> ChatGPTFailure {
    let normalized = code.replacingOccurrences(of: "subscription_sharing_v2_", with: "subscription_sharing_")
    switch normalized {
    case "subscription_sharing_user_not_eligible", "subscription_sharing_invalid_user", "subscription_sharing_v2_client_not_enabled", "subscription_sharing_client_not_enabled":
      return .notEligible
    case "subscription_sharing_usage_limit_exceeded":
      return .usageLimit
    case "subscription_sharing_route_not_supported", "subscription_sharing_unsupported_capability", "model_not_found":
      return .unsupported
    case "subscription_sharing_usage_unavailable", "subscription_sharing_user_unavailable":
      return .unavailable
    case "access_denied":
      return .denied
    default:
      break
    }
    if reauthenticationCodes.contains(normalized) { return .expired }
    switch status {
    case 401: return .rejected(401)
    case 429: return .usageLimit
    case .some(500...): return .unavailable
    default: return .rejected(status)
    }
  }

  public var requiresSignIn: Bool {
    switch self {
    case .expired, .accountMismatch, .planUsageNotGranted, .invalidIdentity: true
    default: false
    }
  }

  public var message: String {
    switch self {
    case .cancelled: String(localized: "Sign-in was cancelled.")
    case .discoveryFailed: String(localized: "Couldn’t reach ChatGPT’s sign-in. Try again in a moment.")
    case .signInIncomplete: String(localized: "ChatGPT didn’t finish connecting Ardia. Try signing in again.")
    case .denied: String(localized: "Sign-in wasn’t completed. You can try again when you’re ready.")
    case .invalidTokenResponse, .invalidIdentity: String(localized: "ChatGPT sent back something Ardia couldn’t verify. Sign in again.")
    case .planUsageNotGranted: String(localized: "ChatGPT didn’t allow Ardia to use your plan. Sign in again and allow it.")
    case .accountMismatch: String(localized: "That’s a different ChatGPT account. Sign in with the one you connected.")
    case .expired: String(localized: "Your ChatGPT connection expired. Sign in again.")
    case .notEligible: String(localized: "Your ChatGPT plan can’t be used in other apps. It takes Plus or Pro.")
    case .usageLimit: String(localized: "You’ve hit your ChatGPT limit for Ardia. Check usage in ChatGPT’s settings.")
    case .unsupported: String(localized: "ChatGPT doesn’t support this request with your plan.")
    case .rejected: String(localized: "ChatGPT turned down the request.")
    case .unavailable: String(localized: "ChatGPT is busy right now. Try again shortly.")
    case .network: String(localized: "Couldn’t reach ChatGPT. Check your connection.")
    case .streamInterrupted: String(localized: "ChatGPT stopped before finishing the answer.")
    }
  }
}

extension Data {
  public func base64URLEncoded() -> String {
    base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  public init?(base64URLEncoded value: String) {
    var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
    self.init(base64Encoded: base64)
  }
}

extension URL {
  func sameOrigin(as other: URL) -> Bool {
    scheme == other.scheme && host == other.host && port == other.port
  }
}

extension String {
  func trimmingSuffix(_ suffix: String) -> String {
    hasSuffix(suffix) ? String(dropLast(suffix.count)) : self
  }
}
