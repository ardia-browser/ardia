import Foundation
import Testing
@testable import ArdiaBrowser

@Suite struct ChatGPTTests {
  static let issuer = URL(string: "https://auth.openai.com")!

  static func jwt(_ claims: [String: Any], alg: String = "RS256") -> String {
    let header = try! JSONSerialization.data(withJSONObject: ["alg": alg, "typ": "JWT"])
    let payload = try! JSONSerialization.data(withJSONObject: claims)
    return "\(header.base64URLEncoded()).\(payload.base64URLEncoded()).c2ln"
  }

  static func claims(_ overrides: [String: Any] = [:]) -> [String: Any] {
    var claims: [String: Any] = [
      "iss": "https://auth.openai.com", "aud": "oaiapp_abc", "sub": "user-1", "exp": Date.now.timeIntervalSince1970 + 600,
      "iat": Date.now.timeIntervalSince1970, "nonce": "n1", "email": "a@b.c", "name": "A",
    ]
    for (key, value) in overrides { claims[key] = value }
    return claims
  }

  @Test func challengeMatchesTheRFC7636Example() {
    #expect(ChatGPTAuth.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
  }

  @Test func randomValuesAreURLSafeAndFresh() {
    let a = ChatGPTAuth.randomValue()
    #expect(a.count == 43)
    #expect(a != ChatGPTAuth.randomValue())
    #expect(a.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
  }

  @Test func firstSignInRegistersWithTheDynamicClient() throws {
    let request = ChatGPTAuthorization(port: 51234, savedClientID: nil, state: "s 1", nonce: "n1", verifier: "v1")
    let url = request.url(endpoint: URL(string: "https://auth.openai.com/api/accounts/authorize")!)
    let items = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
    let query = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
    #expect(query["client_id"] == "dynamic_agent_client")
    #expect(query["agent_name_hint"] == "Ardia")
    #expect(query["redirect_uri"] == "http://127.0.0.1:51234/auth/callback")
    #expect(query["scope"] == "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct")
    #expect(query["resource"] == "https://api.openai.com/v1")
    #expect(query["code_challenge_method"] == "S256")
    #expect(query["code_challenge"] == ChatGPTAuth.challenge(for: "v1"))
    #expect(query["state"] == "s 1")
    #expect(url.absoluteString.contains("scope=openid%20profile"))
    #expect(!url.absoluteString.contains("+"))
  }

  @Test func laterSignInsReuseTheIssuedClient() throws {
    let request = ChatGPTAuthorization(port: 1, savedClientID: "oaiapp_abc", loginHint: "a@b.c")
    let items = try #require(URLComponents(url: request.url(endpoint: Self.issuer), resolvingAgainstBaseURL: false)?.queryItems)
    #expect(items.first { $0.name == "client_id" }?.value == "oaiapp_abc")
    #expect(items.contains { $0.name == "agent_name_hint" } == false)
    #expect(items.first { $0.name == "login_hint" }?.value == "a@b.c")
  }

  @Test func codeExchangeAndRefreshCarryTheResource() {
    let request = ChatGPTAuthorization(port: 9, savedClientID: nil, state: "s", nonce: "n", verifier: "v")
    let exchange = String(decoding: request.codeExchange(code: "c+1", clientID: "oaiapp_abc"), as: UTF8.self)
    #expect(exchange == "grant_type=authorization_code&client_id=oaiapp_abc&code=c%2B1&code_verifier=v&redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fauth%2Fcallback&resource=https%3A%2F%2Fapi.openai.com%2Fv1")
    let refresh = String(decoding: ChatGPTAuthorization.refresh(refreshToken: "r", clientID: "oaiapp_abc"), as: UTF8.self)
    #expect(refresh == "grant_type=refresh_token&client_id=oaiapp_abc&refresh_token=r&resource=https%3A%2F%2Fapi.openai.com%2Fv1")
    #expect(!refresh.contains("scope"))
  }

  @Test func loopbackAcceptsOnlyTheMatchingCallback() {
    func head(_ target: String, host: String = "127.0.0.1:4000", method: String = "GET") -> String {
      "\(method) \(target) HTTP/1.1\r\nHost: \(host)\r\nAccept: */*\r\n\r\n"
    }
    let ok = LoopbackRequest.evaluate(head("/auth/callback?code=abc&state=s1&client_id=oaiapp_x"), port: 4000, state: "s1", savedClientID: nil)
    #expect(ok == .finish(.code(code: "abc", clientID: "oaiapp_x")))
    #expect(LoopbackRequest.evaluate(head("/favicon.ico"), port: 4000, state: "s1", savedClientID: nil) == .notFound)
    #expect(LoopbackRequest.evaluate(head("/auth/callback?code=abc&state=s1", host: "evil.test"), port: 4000, state: "s1", savedClientID: nil) == .notFound)
    #expect(LoopbackRequest.evaluate(head("/auth/callback?code=abc&state=s1", method: "POST"), port: 4000, state: "s1", savedClientID: nil) == .notFound)
    #expect(LoopbackRequest.evaluate(head("/auth/callback?code=abc&state=s2"), port: 4000, state: "s1", savedClientID: nil) == .badState)
    #expect(LoopbackRequest.evaluate(head("/auth/callback?code=abc&state=s1&state=s1"), port: 4000, state: "s1", savedClientID: nil) == .badState)
    #expect(LoopbackRequest.evaluate(head("/auth/callback?error=access_denied&state=s1"), port: 4000, state: "s1", savedClientID: nil) == .finish(.denied("access_denied")))
    #expect(LoopbackRequest.evaluate(head("/auth/callback?code=abc&state=s1"), port: 4000, state: "s1", savedClientID: nil) == .finish(.incomplete))
    #expect(LoopbackRequest.evaluate(head("/auth/callback?code=abc&state=s1&client_id=dynamic_agent_client"), port: 4000, state: "s1", savedClientID: nil) == .finish(.incomplete))
    #expect(LoopbackRequest.evaluate(head("/auth/callback?code=abc&state=s1"), port: 4000, state: "s1", savedClientID: "oaiapp_saved") == .finish(.code(code: "abc", clientID: "oaiapp_saved")))
    #expect(LoopbackRequest.evaluate(head("/auth/callback?code=abc&state=s1&client_id=oaiapp_other"), port: 4000, state: "s1", savedClientID: "oaiapp_saved") == .finish(.incomplete))
  }

  @Test func finishingRedirectsBackIntoTheApp() {
    let reply = String(decoding: LoopbackRequest.response(for: .finish(.incomplete)), as: UTF8.self)
    #expect(reply.hasPrefix("HTTP/1.1 302 Found\r\n"))
    #expect(reply.contains("Location: ardia-chatgpt://signed-in\r\n"))
    #expect(reply.contains("Cache-Control: no-store"))
  }

  @Test func tokensNeedPlanUsageAndARefreshToken() throws {
    func json(_ object: [String: Any]) -> Data { try! JSONSerialization.data(withJSONObject: object) }
    let full: [String: Any] = ["access_token": "a", "refresh_token": "r", "token_type": "Bearer", "expires_in": 3600, "scope": "openid offline_access chatgpt.tokens.use.direct", "id_token": "x.y.z"]
    let now = Date(timeIntervalSince1970: 1000)
    let tokens = try ChatGPTTokens.parse(json(full), now: now)
    #expect(tokens.expiresAt == Date(timeIntervalSince1970: 4600))
    #expect(tokens.needsRefresh(at: Date(timeIntervalSince1970: 4500)))
    #expect(!tokens.needsRefresh(at: Date(timeIntervalSince1970: 4000)))
    var noPlan = full
    noPlan["scope"] = "openid offline_access"
    #expect(throws: ChatGPTFailure.planUsageNotGranted) { try ChatGPTTokens.parse(json(noPlan)) }
    var noRefresh = full
    noRefresh.removeValue(forKey: "refresh_token")
    #expect(throws: ChatGPTFailure.invalidTokenResponse) { try ChatGPTTokens.parse(json(noRefresh)) }
    var refreshWithoutScope = full
    refreshWithoutScope.removeValue(forKey: "scope")
    #expect(try ChatGPTTokens.parse(json(refreshWithoutScope), previousScopes: tokens.scopes).scopes == tokens.scopes)
    #expect(throws: ChatGPTFailure.invalidTokenResponse) { try ChatGPTTokens.parse(json(refreshWithoutScope)) }
  }

  @Test func identityChecksIssuerAudienceNonceAndExpiry() throws {
    let identity = try ChatGPTIdentity.verify(idToken: Self.jwt(Self.claims()), issuer: Self.issuer, clientID: "oaiapp_abc", nonce: "n1")
    #expect(identity == ChatGPTIdentity(subject: "user-1", email: "a@b.c", name: "A"))
    let bad: [[String: Any]] = [
      Self.claims(["iss": "https://evil.test"]),
      Self.claims(["aud": "oaiapp_other"]),
      Self.claims(["nonce": "n2"]),
      Self.claims(["exp": Date.now.timeIntervalSince1970 - 60]),
      Self.claims(["sub": ""]),
      Self.claims(["aud": ["oaiapp_abc", "other"]]),
      Self.claims(["azp": "other"]),
    ]
    for claims in bad {
      #expect(throws: ChatGPTFailure.invalidIdentity) { try ChatGPTIdentity.verify(idToken: Self.jwt(claims), issuer: Self.issuer, clientID: "oaiapp_abc", nonce: "n1") }
    }
    #expect(throws: ChatGPTFailure.invalidIdentity) { try ChatGPTIdentity.verify(idToken: Self.jwt(Self.claims(), alg: "none"), issuer: Self.issuer, clientID: "oaiapp_abc", nonce: "n1") }
    #expect(try ChatGPTIdentity.verify(idToken: Self.jwt(Self.claims(["aud": ["oaiapp_abc", "other"], "azp": "oaiapp_abc"])), issuer: Self.issuer, clientID: "oaiapp_abc", nonce: "n1").subject == "user-1")
  }

  @Test func refreshKeepsTheSameAccount() throws {
    let endpoints = ChatGPTEndpoints(issuer: Self.issuer, authorization: Self.issuer, token: Self.issuer, revocation: nil, api: ChatGPTEndpoints.openAIAPI)
    let tokens = ChatGPTTokens(accessToken: "a", refreshToken: "r", expiresAt: .now, scopes: [], idToken: nil)
    var connection = ChatGPTConnection(clientID: "oaiapp_abc", identity: ChatGPTIdentity(subject: "user-1", email: nil, name: nil), tokens: tokens, endpoints: endpoints)
    var next = tokens
    next.accessToken = "b"
    next.idToken = Self.jwt(Self.claims(["sub": "user-2"]))
    #expect(throws: ChatGPTFailure.accountMismatch) { try connection.refreshed(with: next) }
    next.idToken = Self.jwt(Self.claims())
    try connection.refreshed(with: next)
    #expect(connection.tokens.accessToken == "b")
    #expect(connection.identity.email == "a@b.c")
  }

  @Test func discoveryStaysOnTheIssuersOrigin() throws {
    func json(_ object: [String: Any]) -> Data { try! JSONSerialization.data(withJSONObject: object) }
    let good: [String: Any] = [
      "issuer": "https://auth.openai.com",
      "authorization_endpoint": "https://auth.openai.com/api/accounts/authorize",
      "token_endpoint": "https://auth.openai.com/api/accounts/oauth/token",
      "revocation_endpoint": "https://auth.openai.com/api/accounts/oauth/revoke",
    ]
    let endpoints = try ChatGPTEndpoints.fromDiscovery(json(good), issuer: Self.issuer, api: ChatGPTEndpoints.openAIAPI)
    #expect(endpoints.token.path == "/api/accounts/oauth/token")
    var elsewhere = good
    elsewhere["token_endpoint"] = "https://evil.test/token"
    #expect(throws: ChatGPTFailure.discoveryFailed) { try ChatGPTEndpoints.fromDiscovery(json(elsewhere), issuer: Self.issuer, api: ChatGPTEndpoints.openAIAPI) }
    var otherIssuer = good
    otherIssuer["issuer"] = "https://evil.test"
    #expect(throws: ChatGPTFailure.discoveryFailed) { try ChatGPTEndpoints.fromDiscovery(json(otherIssuer), issuer: Self.issuer, api: ChatGPTEndpoints.openAIAPI) }
  }

  @Test func errorsMapToWhatTheUserCanDo() {
    func body(_ code: String) -> Data { Data(#"{"error":{"code":"\#(code)","message":"x"}}"#.utf8) }
    #expect(ChatGPTFailure.api(body("subscription_sharing_usage_limit_exceeded"), status: 429) == .usageLimit)
    #expect(ChatGPTFailure.api(body("subscription_sharing_v2_user_not_eligible"), status: 403) == .notEligible)
    #expect(ChatGPTFailure.api(body("subscription_sharing_route_not_supported"), status: 403) == .unsupported)
    #expect(ChatGPTFailure.api(Data(#"{"error":"invalid_grant"}"#.utf8), status: 400) == .expired)
    #expect(ChatGPTFailure.api(nil, status: 503) == .unavailable)
    #expect(ChatGPTFailure.api(nil, status: 401) == .rejected(401))
    #expect(ChatGPTFailure.expired.requiresSignIn)
    #expect(!ChatGPTFailure.usageLimit.requiresSignIn)
  }

  @Test func requestBodyFollowsPlanUsageRules() throws {
    let data = ChatGPTResponses.body(model: "gpt-x", instructions: "Be brief.", prompt: "Q")
    let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(object["store"] as? Bool == false)
    #expect(object["stream"] as? Bool == true)
    #expect(object["instructions"] as? String == "Be brief.")
    #expect((object["input"] as? [[String: String]]) == [["role": "user", "content": "Q"]])
    #expect(Set(object.keys) == ["model", "instructions", "input", "store", "stream"])
  }

  @Test func streamEventsBecomeDeltasAndAnEnd() {
    var parser = ServerSentEvents()
    let lines = [
      "event: response.created", #"data: {"type":"response.created"}"#,
      "event: response.output_text.delta", #"data: {"type":"response.output_text.delta","delta":"Hel"}"#,
      ": keep-alive",
      "data: {\"type\":\"response.output_text.delta\",", "data: \"delta\":\"lo\"}",
      #"data: {"type":"response.completed","response":{}}"#,
    ]
    let events = lines.compactMap { parser.feed($0) }.map { ChatGPTResponses.event($0, status: 200) }
    #expect(events == [.ignored, .delta("Hel"), .delta("lo"), .completed])
    let failed = ChatGPTResponses.event(#"{"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}"#, status: 200)
    #expect(failed == .failed(.usageLimit))
    #expect(ChatGPTResponses.event(#"{"type":"response.incomplete"}"#, status: 200) == .incomplete)
  }

  @Test func catalogKeepsListedModels() throws {
    let data = Data(#"{"models":[{"slug":"gpt-a","display_name":"GPT A","visibility":"list"},{"slug":"hidden","display_name":"H","visibility":"hide"}]}"#.utf8)
    #expect(try ChatGPTModel.catalog(data) == [ChatGPTModel(slug: "gpt-a", displayName: "GPT A")])
    #expect(try ChatGPTModel.catalog(Data(#"{"data":[{"id":"gpt-b"}]}"#.utf8)) == [ChatGPTModel(slug: "gpt-b", displayName: "gpt-b")])
  }
}
