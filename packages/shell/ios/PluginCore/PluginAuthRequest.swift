import CryptoKit
import Foundation
import Security

struct PluginAuthRequest: Equatable {
  static let scheme = "ardia-auth"
  static let maxScopes = 32
  static let maxExtraParams = 16
  static let reservedParams: Set<String> = ["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope"]

  let authorizeURL: URL
  let redirectURI: String
  let state: String
  let verifier: String

  static func randomToken(_ count: Int = 32) -> String? {
    var bytes = [UInt8](repeating: 0, count: count)
    guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else { return nil }
    return base64URL(Data(bytes))
  }

  static func base64URL(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  static func challenge(for verifier: String) -> String {
    base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
  }

  static func redirectURI(scope: String, name: String) -> String? {
    let label = "^[a-z0-9][a-z0-9-]{0,63}$"
    guard scope.range(of: label, options: .regularExpression) != nil, name.range(of: label, options: .regularExpression) != nil else { return nil }
    return "\(Self.scheme)://\(scope)/\(name)/callback"
  }

  static func make(
    authorize: String, clientId: String, scopes: [String], scope: String, name: String, extra: [String: String], state: String, verifier: String
  ) -> Result<PluginAuthRequest, FolderRefusal> {
    guard let redirect = redirectURI(scope: scope, name: name) else { return .failure(FolderRefusal(reason: "the plugin id can't make a sign-in address")) }
    guard authorize.count <= 4096, var parts = URLComponents(string: authorize), parts.scheme?.lowercased() == "https", let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil
    else { return .failure(FolderRefusal(reason: "authorizeUrl must be an https address")) }
    guard !clientId.isEmpty, clientId.count <= 512 else { return .failure(FolderRefusal(reason: "clientId must be 1 to 512 characters")) }
    guard scopes.count <= maxScopes, scopes.allSatisfy({ !$0.isEmpty && $0.count <= 256 && !$0.contains(" ") }) else { return .failure(FolderRefusal(reason: "scopes must be up to \(maxScopes) words without spaces")) }
    guard extra.count <= maxExtraParams, extra.keys.allSatisfy({ !reservedParams.contains($0.lowercased()) && !$0.isEmpty && $0.count <= 64 }), extra.values.allSatisfy({ $0.count <= 1024 })
    else { return .failure(FolderRefusal(reason: "extraParams can't set Ardia's own sign-in parameters")) }
    var query = (parts.queryItems ?? []).filter { !reservedParams.contains($0.name.lowercased()) }
    query.append(URLQueryItem(name: "response_type", value: "code"))
    query.append(URLQueryItem(name: "client_id", value: clientId))
    query.append(URLQueryItem(name: "redirect_uri", value: redirect))
    query.append(URLQueryItem(name: "state", value: state))
    query.append(URLQueryItem(name: "code_challenge", value: challenge(for: verifier)))
    query.append(URLQueryItem(name: "code_challenge_method", value: "S256"))
    if !scopes.isEmpty { query.append(URLQueryItem(name: "scope", value: scopes.joined(separator: " "))) }
    for key in extra.keys.sorted() { query.append(URLQueryItem(name: key, value: extra[key])) }
    parts.queryItems = query
    parts.fragment = nil
    guard let url = parts.url else { return .failure(FolderRefusal(reason: "authorizeUrl isn't valid")) }
    return .success(PluginAuthRequest(authorizeURL: url, redirectURI: redirect, state: state, verifier: verifier))
  }

  func code(from callback: URL) -> Result<String, FolderRefusal> {
    guard let expected = URLComponents(string: redirectURI), let given = URLComponents(url: callback, resolvingAgainstBaseURL: false),
      given.scheme?.lowercased() == expected.scheme, given.host?.lowercased() == expected.host, given.path == expected.path, given.user == nil, given.port == nil
    else { return .failure(FolderRefusal(reason: "the sign-in came back to the wrong address")) }
    let items = given.queryItems ?? []
    let value = { (name: String) -> String? in
      let found = items.filter { $0.name == name }
      return found.count == 1 ? found[0].value : nil
    }
    if let error = value("error") { return .failure(FolderRefusal(reason: "the provider refused the sign-in (\(String(error.prefix(80))))")) }
    guard let returned = value("state"), returned == state else { return .failure(FolderRefusal(reason: "the sign-in's state didn't match, so Ardia dropped it")) }
    guard let code = value("code"), !code.isEmpty, code.count <= 4096 else { return .failure(FolderRefusal(reason: "the sign-in came back without a code")) }
    return .success(code)
  }
}
