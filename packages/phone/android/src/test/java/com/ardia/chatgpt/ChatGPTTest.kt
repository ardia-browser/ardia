package com.ardia.chatgpt

import com.ardia.phone.ChatGPTAccountState
import java.net.URLDecoder
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.RSAPublicKey
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ChatGPTTest {
    private val issuer = "https://auth.openai.com"

    private fun encoded(value: JSONObject): String = value.toString().toByteArray().base64Url()

    private fun jwt(claims: JSONObject, alg: String = "RS256"): String = "${encoded(JSONObject().put("alg", alg).put("typ", "JWT"))}.${encoded(claims)}.c2ln"

    private fun claims(vararg overrides: Pair<String, Any>): JSONObject {
        val now = System.currentTimeMillis() / 1000.0
        val claims = JSONObject().put("iss", issuer).put("aud", "oaiapp_abc").put("sub", "user-1").put("exp", now + 600).put("iat", now).put("nonce", "n1").put("email", "a@b.c").put("name", "A")
        for ((key, value) in overrides) claims.put(key, value)
        return claims
    }

    private inline fun <reified T : ChatGPTFailure> expectFailure(block: () -> Unit) {
        try {
            block()
            fail("expected ${T::class.simpleName}")
        } catch (failure: ChatGPTFailure) {
            assertTrue("got $failure", failure is T)
        }
    }

    private fun query(url: String): Map<String, String> = url.substringAfter('?').split('&').associate { pair ->
        URLDecoder.decode(pair.substringBefore('='), "UTF-8") to URLDecoder.decode(pair.substringAfter('='), "UTF-8")
    }

    @Test
    fun challengeMatchesTheRfc7636Example() {
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", ChatGPTAuth.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
    }

    @Test
    fun randomValuesAreUrlSafeAndFresh() {
        val value = ChatGPTAuth.randomValue()
        assertEquals(43, value.length)
        assertNotEquals(value, ChatGPTAuth.randomValue())
        assertTrue(value.all { it.isLetterOrDigit() || it == '-' || it == '_' })
    }

    @Test
    fun firstSignInRegistersWithTheDynamicClient() {
        val url = ChatGPTAuthorization(51234, null, state = "s 1", nonce = "n1", verifier = "v1").url("https://auth.openai.com/api/accounts/authorize")
        val query = query(url)
        assertEquals("dynamic_agent_client", query["client_id"])
        assertEquals("Ardia", query["agent_name_hint"])
        assertEquals("http://127.0.0.1:51234/auth/callback", query["redirect_uri"])
        assertEquals("openid profile email offline_access resource.invoke chatgpt.tokens.use.direct", query["scope"])
        assertEquals("https://api.openai.com/v1", query["resource"])
        assertEquals("S256", query["code_challenge_method"])
        assertEquals(ChatGPTAuth.challenge("v1"), query["code_challenge"])
        assertEquals("s 1", query["state"])
        assertTrue(url.contains("scope=openid%20profile"))
        assertFalse(url.contains("+"))
    }

    @Test
    fun laterSignInsReuseTheIssuedClient() {
        val query = query(ChatGPTAuthorization(1, "oaiapp_abc", "a@b.c").url(issuer))
        assertEquals("oaiapp_abc", query["client_id"])
        assertFalse(query.containsKey("agent_name_hint"))
        assertEquals("a@b.c", query["login_hint"])
    }

    @Test
    fun codeExchangeAndRefreshCarryTheResource() {
        val request = ChatGPTAuthorization(9, null, state = "s", nonce = "n", verifier = "v")
        assertEquals(
            "grant_type=authorization_code&client_id=oaiapp_abc&code=c%2B1&code_verifier=v&redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fauth%2Fcallback&resource=https%3A%2F%2Fapi.openai.com%2Fv1",
            request.codeExchange("c+1", "oaiapp_abc"),
        )
        val refresh = ChatGPTAuthorization.refresh("r", "oaiapp_abc")
        assertEquals("grant_type=refresh_token&client_id=oaiapp_abc&refresh_token=r&resource=https%3A%2F%2Fapi.openai.com%2Fv1", refresh)
        assertFalse(refresh.contains("scope"))
    }

    @Test
    fun loopbackAcceptsOnlyTheMatchingCallback() {
        fun head(target: String, host: String = "127.0.0.1:4000", method: String = "GET") = "$method $target HTTP/1.1\r\nHost: $host\r\nAccept: */*\r\n\r\n"
        fun evaluate(head: String, saved: String? = null) = LoopbackRequest.evaluate(head, 4000, "s1", saved)
        val finish = { outcome: LoopbackRequest.Outcome -> LoopbackRequest.Reply.Finish(outcome) }
        assertEquals(finish(LoopbackRequest.Outcome.Code("abc", "oaiapp_x")), evaluate(head("/auth/callback?code=abc&state=s1&client_id=oaiapp_x")))
        assertEquals(LoopbackRequest.Reply.NotFound, evaluate(head("/favicon.ico")))
        assertEquals(LoopbackRequest.Reply.NotFound, evaluate(head("/auth/callback?code=abc&state=s1", host = "evil.test")))
        assertEquals(LoopbackRequest.Reply.NotFound, evaluate(head("/auth/callback?code=abc&state=s1", method = "POST")))
        assertEquals(LoopbackRequest.Reply.BadState, evaluate(head("/auth/callback?code=abc&state=s2")))
        assertEquals(LoopbackRequest.Reply.BadState, evaluate(head("/auth/callback?code=abc&state=s1&state=s1")))
        assertEquals(finish(LoopbackRequest.Outcome.Denied("access_denied")), evaluate(head("/auth/callback?error=access_denied&state=s1")))
        assertEquals(finish(LoopbackRequest.Outcome.Incomplete), evaluate(head("/auth/callback?code=abc&state=s1")))
        assertEquals(finish(LoopbackRequest.Outcome.Incomplete), evaluate(head("/auth/callback?code=abc&state=s1&client_id=dynamic_agent_client")))
        assertEquals(finish(LoopbackRequest.Outcome.Code("abc", "oaiapp_saved")), evaluate(head("/auth/callback?code=abc&state=s1"), "oaiapp_saved"))
        assertEquals(finish(LoopbackRequest.Outcome.Incomplete), evaluate(head("/auth/callback?code=abc&state=s1&client_id=oaiapp_other"), "oaiapp_saved"))
    }

    @Test
    fun finishingRedirectsBackIntoTheApp() {
        val reply = String(LoopbackRequest.response(LoopbackRequest.Reply.Finish(LoopbackRequest.Outcome.Incomplete)))
        assertTrue(reply.startsWith("HTTP/1.1 302 Found\r\n"))
        assertTrue(reply.contains("Location: ardia-chatgpt://signed-in\r\n"))
        assertTrue(reply.contains("Cache-Control: no-store"))
    }

    @Test
    fun tokensNeedPlanUsageAndARefreshToken() {
        fun full() = JSONObject().put("access_token", "a").put("refresh_token", "r").put("token_type", "Bearer").put("expires_in", 3600).put("scope", "openid offline_access chatgpt.tokens.use.direct").put("id_token", "x.y.z")
        val tokens = ChatGPTTokens.parse(full().toString(), now = 1_000_000)
        assertEquals(4_600_000L, tokens.expiresAt)
        assertTrue(tokens.needsRefresh(4_500_000))
        assertFalse(tokens.needsRefresh(4_000_000))
        expectFailure<ChatGPTFailure.PlanUsageNotGranted> { ChatGPTTokens.parse(full().put("scope", "openid offline_access").toString()) }
        expectFailure<ChatGPTFailure.InvalidTokenResponse> { ChatGPTTokens.parse(full().apply { remove("refresh_token") }.toString()) }
        val withoutScope = full().apply { remove("scope") }.toString()
        assertEquals(tokens.scopes, ChatGPTTokens.parse(withoutScope, tokens.scopes).scopes)
        expectFailure<ChatGPTFailure.InvalidTokenResponse> { ChatGPTTokens.parse(withoutScope) }
        expectFailure<ChatGPTFailure.InvalidIdentity> { ChatGPTTokens.parse(full().put("id_token", "").toString()) }
    }

    @Test
    fun identityChecksIssuerAudienceNonceAndExpiry() {
        assertEquals(ChatGPTIdentity("user-1", "a@b.c", "A"), ChatGPTIdentity.verify(jwt(claims()), issuer, "oaiapp_abc", "n1"))
        val now = System.currentTimeMillis() / 1000.0
        val bad = listOf(
            claims("iss" to "https://evil.test"),
            claims("aud" to "oaiapp_other"),
            claims("nonce" to "n2"),
            claims("exp" to now - 60),
            claims("sub" to ""),
            claims("aud" to JSONArray(listOf("oaiapp_abc", "other"))),
            claims("azp" to "other"),
        )
        for (claim in bad) expectFailure<ChatGPTFailure.InvalidIdentity> { ChatGPTIdentity.verify(jwt(claim), issuer, "oaiapp_abc", "n1") }
        expectFailure<ChatGPTFailure.InvalidIdentity> { ChatGPTIdentity.verify(jwt(claims(), alg = "none"), issuer, "oaiapp_abc", "n1") }
        assertEquals("user-1", ChatGPTIdentity.verify(jwt(claims("aud" to JSONArray(listOf("oaiapp_abc", "other")), "azp" to "oaiapp_abc")), issuer, "oaiapp_abc", "n1").subject)
    }

    @Test
    fun refreshKeepsTheSameAccount() {
        val endpoints = ChatGPTEndpoints(issuer, issuer, issuer, null, issuer, ChatGPTEndpoints.OPENAI_API)
        val connection = ChatGPTConnection("oaiapp_abc", ChatGPTIdentity("user-1", null, null), ChatGPTTokens("a", "r", 0, emptyList(), null), endpoints)
        expectFailure<ChatGPTFailure.AccountMismatch> { connection.confirmed(ChatGPTIdentity("user-2", null, null)) }
        assertEquals("a@b.c", connection.confirmed(ChatGPTIdentity("user-1", "a@b.c", null)).identity.email)
        assertEquals(connection, ChatGPTConnection.fromJson(connection.toJson()))
    }

    @Test
    fun pendingRotationPersistsSeparatelyFromTheVerifiedTokens() {
        val endpoints = ChatGPTEndpoints(issuer, issuer, issuer, null, issuer, ChatGPTEndpoints.OPENAI_API)
        val original = ChatGPTTokens("access", "refresh", 0, emptyList(), null)
        val pending = ChatGPTTokens("next access", "next refresh", Long.MAX_VALUE, emptyList(), "unchecked ID token")
        val connection = ChatGPTConnection("oaiapp_abc", ChatGPTIdentity("user-1", null, null), original, endpoints, pendingTokens = pending)

        val restored = ChatGPTConnection.fromJson(connection.toJson())

        assertEquals(original, restored?.tokens)
        assertEquals(pending, restored?.pendingTokens)
    }

    @Test
    fun expiredIdentityCanIdentifyAStoredRotationWithoutAuthorizingItsAccessToken() {
        val token = jwt(claims("exp" to 100.0))
        val checked = ChatGPTIdentity.check(token, issuer, "oaiapp_abc", "n1", now = 106_000)
        assertEquals("user-1", checked.identity.subject)
        assertTrue(checked.expired)
        expectFailure<ChatGPTFailure.InvalidIdentity> { checked.requireCurrent() }
    }

    private fun keyPair(): KeyPair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()

    private fun unsigned(value: java.math.BigInteger): ByteArray = value.toByteArray().dropWhile { it == 0.toByte() }.toByteArray()

    private fun sign(claims: JSONObject, keys: KeyPair, kid: String = "k1"): String {
        val input = "${encoded(JSONObject().put("alg", "RS256").put("kid", kid))}.${encoded(claims)}"
        val signature = Signature.getInstance("SHA256withRSA").run {
            initSign(keys.private)
            update(input.toByteArray())
            sign()
        }
        return "$input.${signature.base64Url()}"
    }

    @Test
    fun signatureMustComeFromTheIssuersKey() {
        val keys = keyPair()
        val other = keyPair()
        val public = keys.public as RSAPublicKey
        val jwk = JSONObject().put("kty", "RSA").put("kid", "k1").put("use", "sig").put("alg", "RS256").put("n", unsigned(public.modulus).base64Url()).put("e", unsigned(public.publicExponent).base64Url())
        val jwks = JSONObject().put("keys", JSONArray().put(jwk)).toString()
        val token = sign(claims(), keys)
        ChatGPTSignature.verify(token, jwks)
        expectFailure<ChatGPTFailure.InvalidIdentity> { ChatGPTSignature.verify(sign(claims(), other), jwks) }
        expectFailure<ChatGPTFailure.InvalidIdentity> { ChatGPTSignature.verify(sign(claims(), keys, kid = "k2"), jwks) }
        val parts = token.split('.')
        val tampered = "${parts[0]}.${encoded(claims("sub" to "someone-else"))}.${parts[2]}"
        expectFailure<ChatGPTFailure.InvalidIdentity> { ChatGPTSignature.verify(tampered, jwks) }
        expectFailure<ChatGPTFailure.InvalidIdentity> { ChatGPTSignature.verify(jwt(claims()), jwks) }
    }

    @Test
    fun discoveryStaysOnTheIssuersOrigin() {
        fun good() = JSONObject()
            .put("issuer", "https://auth.openai.com")
            .put("authorization_endpoint", "https://auth.openai.com/api/accounts/authorize")
            .put("token_endpoint", "https://auth.openai.com/api/accounts/oauth/token")
            .put("revocation_endpoint", "https://auth.openai.com/api/accounts/oauth/revoke")
            .put("jwks_uri", "https://auth.openai.com/.well-known/jwks.json")
        val endpoints = ChatGPTEndpoints.fromDiscovery(good().toString(), issuer, ChatGPTEndpoints.OPENAI_API)
        assertEquals("https://auth.openai.com/api/accounts/oauth/token", endpoints.token)
        expectFailure<ChatGPTFailure.DiscoveryFailed> { ChatGPTEndpoints.fromDiscovery(good().put("token_endpoint", "https://evil.test/token").toString(), issuer, ChatGPTEndpoints.OPENAI_API) }
        expectFailure<ChatGPTFailure.DiscoveryFailed> { ChatGPTEndpoints.fromDiscovery(good().apply { remove("jwks_uri") }.toString(), issuer, ChatGPTEndpoints.OPENAI_API) }
        expectFailure<ChatGPTFailure.DiscoveryFailed> { ChatGPTEndpoints.fromDiscovery(good().put("issuer", "https://evil.test").toString(), issuer, ChatGPTEndpoints.OPENAI_API) }
        expectFailure<ChatGPTFailure.DiscoveryFailed> { ChatGPTEndpoints.fromDiscovery(good().put("revocation_endpoint", "https://evil.test/revoke").toString(), issuer, ChatGPTEndpoints.OPENAI_API) }
    }

    @Test
    fun errorsMapToWhatTheUserCanDo() {
        fun body(code: String) = """{"error":{"code":"$code","message":"x"}}"""
        assertEquals(ChatGPTFailure.UsageLimit, ChatGPTFailure.api(body("subscription_sharing_usage_limit_exceeded"), 429))
        assertEquals(ChatGPTFailure.NotEligible, ChatGPTFailure.api(body("subscription_sharing_v2_user_not_eligible"), 403))
        assertEquals(ChatGPTFailure.Unsupported, ChatGPTFailure.api(body("subscription_sharing_route_not_supported"), 403))
        assertEquals(ChatGPTFailure.Expired, ChatGPTFailure.api("""{"error":"invalid_grant"}""", 400))
        assertEquals(ChatGPTFailure.Unavailable, ChatGPTFailure.api(null, 503))
        assertEquals(ChatGPTFailure.Rejected(401), ChatGPTFailure.api(null, 401))
        assertTrue(ChatGPTFailure.Expired.requiresSignIn)
        assertFalse(ChatGPTFailure.UsageLimit.requiresSignIn)
    }

    @Test
    fun disconnectMakesTheAccountUnavailableWhileRetainingTheConnectionForRevocation() {
        val endpoints = ChatGPTEndpoints(issuer, issuer, issuer, null, issuer, ChatGPTEndpoints.OPENAI_API)
        val connection = ChatGPTConnection("oaiapp_abc", ChatGPTIdentity("user-1", null, null), ChatGPTTokens("a", "r", 0, emptyList(), null), endpoints)
        val connected = ChatGPTAccountState(connection = connection)
        val disconnecting = connected.copy(isDisconnecting = true)
        assertTrue(connected.isConnected)
        assertFalse(disconnecting.isConnected)
        assertEquals(connection, disconnecting.connection)
        assertEquals(null, disconnecting.accountLabel)
    }

    @Test
    fun requestBodyFollowsPlanUsageRules() {
        val body = JSONObject(ChatGPTResponses.body("gpt-x", "Be brief.", "Q"))
        assertEquals(false, body.getBoolean("store"))
        assertEquals(true, body.getBoolean("stream"))
        assertEquals("Be brief.", body.getString("instructions"))
        assertEquals("user", body.getJSONArray("input").getJSONObject(0).getString("role"))
        assertEquals("Q", body.getJSONArray("input").getJSONObject(0).getString("content"))
        assertEquals(setOf("model", "instructions", "input", "store", "stream"), body.keys().asSequence().toSet())
        assertEquals("high", JSONObject(ChatGPTResponses.body("gpt-a", "", "Q", "high")).getJSONObject("reasoning").getString("effort"))
    }

    @Test
    fun streamEventsBecomeDeltasAndAnEnd() {
        val parser = ServerSentEvents()
        val lines = listOf(
            "event: response.created", """data: {"type":"response.created"}""",
            "event: response.output_text.delta", """data: {"type":"response.output_text.delta","delta":"Hel"}""",
            ": keep-alive",
            "data: {\"type\":\"response.output_text.delta\",", "data: \"delta\":\"lo\"}",
            """data: {"type":"response.completed","response":{}}""",
        )
        val events = lines.mapNotNull { parser.feed(it) }.map { ChatGPTResponses.event(it, 200) }
        assertEquals(listOf(ChatGPTResponses.Event.Ignored, ChatGPTResponses.Event.Delta("Hel"), ChatGPTResponses.Event.Delta("lo"), ChatGPTResponses.Event.Completed), events)
        assertEquals(ChatGPTResponses.Event.Failed(ChatGPTFailure.UsageLimit), ChatGPTResponses.event("""{"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}""", 200))
        assertEquals(ChatGPTResponses.Event.Incomplete, ChatGPTResponses.event("""{"type":"response.incomplete"}""", 200))
    }

    @Test
    fun catalogKeepsListedModelsAndThinkingLevels() {
        assertEquals(listOf(ChatGPTModel("gpt-a", "GPT A")), ChatGPTModel.catalog("""{"models":[{"slug":"gpt-a","display_name":"GPT A","visibility":"list"},{"slug":"hidden","display_name":"H","visibility":"hide"}]}"""))
        assertEquals(listOf(ChatGPTModel("gpt-b", "gpt-b")), ChatGPTModel.catalog("""{"data":[{"id":"gpt-b"}]}"""))
        val model = ChatGPTModel.catalog("""{"models":[{"slug":"gpt-a","display_name":"GPT A","visibility":"list","default_reasoning_level":"medium","supported_reasoning_levels":[{"effort":"low"},{"effort":"medium"},{"effort":"medium"},{"effort":"Not One"},{"effort":"high"}]}]}""").first()
        assertEquals(listOf("low", "medium", "high"), model.efforts)
        assertEquals("medium", model.defaultEffort)
    }
}
