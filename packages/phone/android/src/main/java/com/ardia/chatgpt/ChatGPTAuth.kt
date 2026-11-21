package com.ardia.chatgpt

import java.math.BigInteger
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.Signature
import java.security.spec.RSAPublicKeySpec
import java.util.Base64
import org.json.JSONArray
import org.json.JSONObject

data class ChatGPTEndpoints(val issuer: String, val authorization: String, val token: String, val revocation: String?, val jwks: String, val api: String) {
    fun toJson(): JSONObject = JSONObject().put("issuer", issuer).put("authorization", authorization).put("token", token).put("revocation", revocation ?: JSONObject.NULL).put("jwks", jwks).put("api", api)

    companion object {
        const val OPENAI_ISSUER = "https://auth.openai.com"
        const val OPENAI_API = "https://api.openai.com/v1"

        fun discoveryUrl(issuer: String): String = issuer.trimEnd('/') + "/.well-known/openid-configuration"

        fun fromJson(value: JSONObject): ChatGPTEndpoints = ChatGPTEndpoints(
            value.getString("issuer"), value.getString("authorization"), value.getString("token"),
            if (value.isNull("revocation")) null else value.getString("revocation"), value.getString("jwks"), value.getString("api"),
        )

        fun fromDiscovery(body: String, issuer: String, api: String): ChatGPTEndpoints {
            val value = runCatching { JSONObject(body) }.getOrNull() ?: throw ChatGPTFailure.DiscoveryFailed
            if (value.optString("issuer") != issuer.trimEnd('/')) throw ChatGPTFailure.DiscoveryFailed
            fun endpoint(key: String): String? {
                val raw = value.opt(key) as? String ?: return null
                return if (sameOrigin(raw, issuer)) raw else null
            }
            val authorization = endpoint("authorization_endpoint") ?: throw ChatGPTFailure.DiscoveryFailed
            val token = endpoint("token_endpoint") ?: throw ChatGPTFailure.DiscoveryFailed
            val jwks = endpoint("jwks_uri") ?: throw ChatGPTFailure.DiscoveryFailed
            if (value.has("revocation_endpoint") && endpoint("revocation_endpoint") == null) throw ChatGPTFailure.DiscoveryFailed
            return ChatGPTEndpoints(issuer, authorization, token, endpoint("revocation_endpoint"), jwks, api)
        }

        fun sameOrigin(url: String, other: String): Boolean {
            val a = runCatching { URI(url) }.getOrNull() ?: return false
            val b = runCatching { URI(other) }.getOrNull() ?: return false
            return a.scheme != null && a.scheme == b.scheme && a.host != null && a.host == b.host && a.port == b.port
        }
    }
}

object ChatGPTAuth {
    const val RESOURCE = "https://api.openai.com/v1"
    const val SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
    const val PLAN_USAGE_SCOPE = "chatgpt.tokens.use.direct"
    const val CALLBACK_PATH = "/auth/callback"
    const val DYNAMIC_CLIENT = "dynamic_agent_client"
    const val APP_NAME = "Ardia"
    const val FINISHED_SCHEME = "ardia-chatgpt"
    const val FINISHED_URL = "ardia-chatgpt://signed-in"

    private val random = SecureRandom()

    fun randomValue(): String = ByteArray(32).also(random::nextBytes).base64Url()

    fun challenge(verifier: String): String = MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()).base64Url()

    fun isValidClientId(value: String): Boolean = value != DYNAMIC_CLIENT && value.length in 1..200 && value.all { it.code < 128 && (it.isLetterOrDigit() || it == '_' || it == '-') }
}

class ChatGPTAuthorization(
    val port: Int,
    val savedClientId: String?,
    val loginHint: String? = null,
    val state: String = ChatGPTAuth.randomValue(),
    val nonce: String = ChatGPTAuth.randomValue(),
    val verifier: String = ChatGPTAuth.randomValue(),
) {
    val redirectUri: String get() = "http://127.0.0.1:$port${ChatGPTAuth.CALLBACK_PATH}"

    fun url(endpoint: String): String {
        val items = mutableListOf(
            "client_id" to (savedClientId ?: ChatGPTAuth.DYNAMIC_CLIENT),
            "response_type" to "code",
            "redirect_uri" to redirectUri,
            "scope" to ChatGPTAuth.SCOPES,
            "resource" to ChatGPTAuth.RESOURCE,
            "state" to state,
            "nonce" to nonce,
            "code_challenge_method" to "S256",
            "code_challenge" to ChatGPTAuth.challenge(verifier),
        )
        if (savedClientId == null) items += "agent_name_hint" to ChatGPTAuth.APP_NAME
        if (loginHint != null) items += "login_hint" to loginHint
        val separator = if (endpoint.contains('?')) "&" else "?"
        return endpoint + separator + form(items)
    }

    fun codeExchange(code: String, clientId: String): String = form(
        listOf("grant_type" to "authorization_code", "client_id" to clientId, "code" to code, "code_verifier" to verifier, "redirect_uri" to redirectUri, "resource" to ChatGPTAuth.RESOURCE),
    )

    companion object {
        fun refresh(refreshToken: String, clientId: String): String = form(listOf("grant_type" to "refresh_token", "client_id" to clientId, "refresh_token" to refreshToken, "resource" to ChatGPTAuth.RESOURCE))

        fun revocation(refreshToken: String, clientId: String): String = form(listOf("token" to refreshToken, "token_type_hint" to "refresh_token", "client_id" to clientId))

        fun encoded(value: String): String = URLEncoder.encode(value, "UTF-8").replace("+", "%20").replace("*", "%2A").replace("%7E", "~")

        fun form(pairs: List<Pair<String, String>>): String = pairs.joinToString("&") { "${it.first}=${encoded(it.second)}" }
    }
}

object LoopbackRequest {
    sealed class Outcome {
        data class Code(val code: String, val clientId: String) : Outcome()
        data class Denied(val error: String) : Outcome()
        data object Incomplete : Outcome()
    }

    sealed class Reply {
        data object NotFound : Reply()
        data object BadState : Reply()
        data class Finish(val outcome: Outcome) : Reply()
    }

    fun evaluate(head: String, port: Int, state: String, savedClientId: String?): Reply {
        val lines = head.split("\r\n")
        val requestLine = lines.firstOrNull()?.split(' ')?.filter { it.isNotEmpty() }.orEmpty()
        if (requestLine.size != 3 || requestLine[0] != "GET") return Reply.NotFound
        val host = lines.drop(1).firstOrNull { it.lowercase().startsWith("host:") }?.drop(5)?.trim()
        if (host != "127.0.0.1:$port") return Reply.NotFound
        val target = requestLine[1]
        if (target.substringBefore('?') != ChatGPTAuth.CALLBACK_PATH) return Reply.NotFound
        val items = target.substringAfter('?', "").split('&').filter { it.isNotEmpty() }.map { pair ->
            decoded(pair.substringBefore('=')) to decoded(pair.substringAfter('=', ""))
        }
        fun values(name: String) = items.filter { it.first == name }.mapNotNull { it.second }
        val states = values("state")
        if (states.size != 1 || !constantTimeEqual(states[0], state)) return Reply.BadState
        values("error").firstOrNull()?.let { return Reply.Finish(Outcome.Denied(it)) }
        val codes = values("code")
        val returnedClients = values("client_id")
        if (codes.size != 1 || codes[0].isEmpty() || returnedClients.size > 1) return Reply.Finish(Outcome.Incomplete)
        val clientId = returnedClients.firstOrNull() ?: savedClientId
        if (clientId == null || !ChatGPTAuth.isValidClientId(clientId)) return Reply.Finish(Outcome.Incomplete)
        if (savedClientId != null && returnedClients.isNotEmpty() && returnedClients[0] != savedClientId) return Reply.Finish(Outcome.Incomplete)
        return Reply.Finish(Outcome.Code(codes[0], clientId))
    }

    private fun decoded(value: String): String? = runCatching { URLDecoder.decode(value, "UTF-8") }.getOrNull()

    fun response(reply: Reply): ByteArray {
        val headers = "Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n"
        return when (reply) {
            Reply.NotFound -> "HTTP/1.1 404 Not Found\r\n${headers}Content-Length: 0\r\n\r\n".toByteArray()
            Reply.BadState -> {
                val body = "Invalid sign-in state. Start again from Ardia."
                "HTTP/1.1 400 Bad Request\r\n${headers}Content-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.toByteArray().size}\r\n\r\n$body".toByteArray()
            }
            is Reply.Finish -> {
                val url = ChatGPTAuth.FINISHED_URL
                val body = "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\"><title>Return to Ardia</title><body style=\"font:17px system-ui;margin:20vh 24px\"><h1>Return to Ardia</h1><p><a href=\"$url\">Back to Ardia</a></p>"
                "HTTP/1.1 302 Found\r\n${headers}Location: $url\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${body.toByteArray().size}\r\n\r\n$body".toByteArray()
            }
        }
    }

    fun constantTimeEqual(lhs: String, rhs: String): Boolean = MessageDigest.isEqual(lhs.toByteArray(), rhs.toByteArray())
}

data class ChatGPTTokens(val accessToken: String, val refreshToken: String, val expiresAt: Long, val scopes: List<String>, val idToken: String?) {
    fun needsRefresh(now: Long = System.currentTimeMillis()): Boolean = expiresAt - now < 120_000

    fun toJson(): JSONObject = JSONObject().put("accessToken", accessToken).put("refreshToken", refreshToken).put("expiresAt", expiresAt).put("scopes", JSONArray(scopes)).put("idToken", idToken ?: JSONObject.NULL)

    companion object {
        fun fromJson(value: JSONObject): ChatGPTTokens = ChatGPTTokens(
            value.getString("accessToken"), value.getString("refreshToken"), value.getLong("expiresAt"),
            value.getJSONArray("scopes").let { array -> List(array.length()) { array.getString(it) } },
            if (value.isNull("idToken")) null else value.getString("idToken"),
        )

        fun parse(body: String, previousScopes: List<String>? = null, now: Long = System.currentTimeMillis()): ChatGPTTokens {
            val value = runCatching { JSONObject(body) }.getOrNull() ?: throw ChatGPTFailure.InvalidTokenResponse
            val scopes = (value.opt("scope") as? String)?.split(Regex("\\s+"))?.filter { it.isNotEmpty() } ?: previousScopes ?: throw ChatGPTFailure.InvalidTokenResponse
            if (ChatGPTAuth.PLAN_USAGE_SCOPE !in scopes) throw ChatGPTFailure.PlanUsageNotGranted
            val access = value.opt("access_token") as? String
            val refresh = value.opt("refresh_token") as? String
            val expires = (value.opt("expires_in") as? Number)?.toDouble()
            if (access.isNullOrEmpty() || (value.opt("token_type") as? String)?.lowercase() != "bearer" || expires == null || expires <= 0 || refresh.isNullOrEmpty()) {
                throw ChatGPTFailure.InvalidTokenResponse
            }
            val idToken = if (value.has("id_token")) value.opt("id_token") as? String else null
            if (value.has("id_token") && idToken.isNullOrEmpty()) throw ChatGPTFailure.InvalidIdentity
            return ChatGPTTokens(access, refresh, now + (expires * 1000).toLong(), scopes, idToken)
        }
    }
}

data class ChatGPTIdentity(val subject: String, val email: String?, val name: String?) {
    fun toJson(): JSONObject = JSONObject().put("subject", subject).put("email", email ?: JSONObject.NULL).put("name", name ?: JSONObject.NULL)

    data class Checked(val identity: ChatGPTIdentity, val expired: Boolean) {
        fun requireCurrent(): ChatGPTIdentity {
            if (expired) throw ChatGPTFailure.InvalidIdentity
            return identity
        }
    }

    companion object {
        fun fromJson(value: JSONObject): ChatGPTIdentity = ChatGPTIdentity(value.getString("subject"), value.optNullable("email"), value.optNullable("name"))

        fun verify(idToken: String, issuer: String, clientId: String, nonce: String?, now: Long = System.currentTimeMillis()): ChatGPTIdentity =
            check(idToken, issuer, clientId, nonce, now).requireCurrent()

        fun check(idToken: String, issuer: String, clientId: String, nonce: String?, now: Long = System.currentTimeMillis()): Checked {
            val parts = idToken.split('.')
            if (parts.size != 3) throw ChatGPTFailure.InvalidIdentity
            val header = parts[0].base64UrlJson() ?: throw ChatGPTFailure.InvalidIdentity
            if (header.optString("alg") != "RS256") throw ChatGPTFailure.InvalidIdentity
            val claims = parts[1].base64UrlJson() ?: throw ChatGPTFailure.InvalidIdentity
            val audiences = when (val aud = claims.opt("aud")) {
                is String -> listOf(aud)
                is JSONArray -> List(aud.length()) { aud.optString(it) }
                else -> emptyList()
            }
            val azp = claims.opt("azp") as? String
            val expires = (claims.opt("exp") as? Number)?.toDouble()
            val subject = claims.opt("sub") as? String
            val valid = claims.opt("iss") as? String == issuer.trimEnd('/') &&
                clientId in audiences &&
                (audiences.size == 1 || azp == clientId) &&
                (azp == null || azp == clientId) &&
                expires != null && expires.isFinite() && expires > 0 &&
                claims.opt("iat") is Number &&
                !subject.isNullOrEmpty() &&
                (nonce == null || claims.opt("nonce") as? String == nonce)
            if (!valid) throw ChatGPTFailure.InvalidIdentity
            val identity = ChatGPTIdentity(subject!!, claims.opt("email") as? String, claims.opt("name") as? String)
            return Checked(identity, (expires!! + 5) * 1000 <= now)
        }
    }
}

object ChatGPTSignature {
    fun verify(idToken: String, jwks: String) {
        val parts = idToken.split('.')
        if (parts.size != 3) throw ChatGPTFailure.InvalidIdentity
        val header = parts[0].base64UrlJson() ?: throw ChatGPTFailure.InvalidIdentity
        if (header.optString("alg") != "RS256") throw ChatGPTFailure.InvalidIdentity
        val signature = parts[2].base64UrlBytes()?.takeIf { it.isNotEmpty() } ?: throw ChatGPTFailure.InvalidIdentity
        val keys = runCatching { JSONObject(jwks).getJSONArray("keys") }.getOrNull() ?: throw ChatGPTFailure.InvalidIdentity
        val usable = List(keys.length()) { keys.optJSONObject(it) }.filterNotNull().filter { key ->
            key.optString("kty") == "RSA" && (!key.has("use") || key.optString("use") == "sig") && (!key.has("alg") || key.optString("alg") == "RS256")
        }
        val kid = header.opt("kid") as? String
        val candidates = if (kid != null) usable.filter { it.opt("kid") as? String == kid } else if (usable.size == 1) usable else emptyList()
        val jwk = candidates.firstOrNull() ?: throw ChatGPTFailure.InvalidIdentity
        val modulus = (jwk.opt("n") as? String)?.base64UrlBytes() ?: throw ChatGPTFailure.InvalidIdentity
        val exponent = (jwk.opt("e") as? String)?.base64UrlBytes() ?: throw ChatGPTFailure.InvalidIdentity
        if (modulus.dropWhile { it == 0.toByte() }.size < 256) throw ChatGPTFailure.InvalidIdentity
        val verified = runCatching {
            val key = KeyFactory.getInstance("RSA").generatePublic(RSAPublicKeySpec(BigInteger(1, modulus), BigInteger(1, exponent)))
            Signature.getInstance("SHA256withRSA").run {
                initVerify(key)
                update("${parts[0]}.${parts[1]}".toByteArray())
                verify(signature)
            }
        }.getOrDefault(false)
        if (!verified) throw ChatGPTFailure.InvalidIdentity
    }
}

sealed class ChatGPTFailure : Exception() {
    data object Cancelled : ChatGPTFailure()
    data object DiscoveryFailed : ChatGPTFailure()
    data object SignInIncomplete : ChatGPTFailure()
    data object Denied : ChatGPTFailure()
    data object InvalidTokenResponse : ChatGPTFailure()
    data object InvalidIdentity : ChatGPTFailure()
    data object PlanUsageNotGranted : ChatGPTFailure()
    data object AccountMismatch : ChatGPTFailure()
    data object Expired : ChatGPTFailure()
    data object NotEligible : ChatGPTFailure()
    data object UsageLimit : ChatGPTFailure()
    data object Unsupported : ChatGPTFailure()
    data class Rejected(val status: Int?) : ChatGPTFailure()
    data object Unavailable : ChatGPTFailure()
    data object Network : ChatGPTFailure()
    data object StreamInterrupted : ChatGPTFailure()

    val requiresSignIn: Boolean get() = this is Expired || this is AccountMismatch || this is PlanUsageNotGranted || this is InvalidIdentity

    override val message: String
        get() = when (this) {
            Cancelled -> "Sign-in was cancelled."
            DiscoveryFailed -> "Couldn’t reach ChatGPT’s sign-in. Try again in a moment."
            SignInIncomplete -> "ChatGPT didn’t finish connecting Ardia. Try signing in again."
            Denied -> "Sign-in wasn’t completed. You can try again when you’re ready."
            InvalidTokenResponse, InvalidIdentity -> "ChatGPT sent back something Ardia couldn’t verify. Sign in again."
            PlanUsageNotGranted -> "ChatGPT didn’t allow Ardia to use your plan. Sign in again and allow it."
            AccountMismatch -> "That’s a different ChatGPT account. Sign in with the one you connected."
            Expired -> "Your ChatGPT connection expired. Sign in again."
            NotEligible -> "Your ChatGPT plan can’t be used in other apps. It takes Plus or Pro."
            UsageLimit -> "You’ve hit your ChatGPT limit for Ardia. Check usage in ChatGPT’s settings."
            Unsupported -> "ChatGPT doesn’t support this request with your plan."
            is Rejected -> "ChatGPT turned down the request."
            Unavailable -> "ChatGPT is busy right now. Try again shortly."
            Network -> "Couldn’t reach ChatGPT. Check your connection."
            StreamInterrupted -> "ChatGPT stopped before finishing the answer."
        }

    companion object {
        private val reauthenticationCodes = setOf("invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused")

        fun api(body: String?, status: Int?): ChatGPTFailure {
            var detail = body?.let { runCatching { JSONObject(it) }.getOrNull() } ?: JSONObject()
            repeat(4) {
                detail = detail.optJSONObject("error") ?: detail.optJSONObject("response") ?: detail.optJSONObject("detail") ?: return@repeat
            }
            val code = (detail.opt("error") as? String) ?: (detail.opt("code") as? String) ?: ""
            return classify(code, status)
        }

        fun classify(code: String, status: Int?): ChatGPTFailure {
            val normalized = code.replace("subscription_sharing_v2_", "subscription_sharing_")
            when (normalized) {
                "subscription_sharing_user_not_eligible", "subscription_sharing_invalid_user", "subscription_sharing_client_not_enabled" -> return NotEligible
                "subscription_sharing_usage_limit_exceeded" -> return UsageLimit
                "subscription_sharing_route_not_supported", "subscription_sharing_unsupported_capability", "model_not_found" -> return Unsupported
                "subscription_sharing_usage_unavailable", "subscription_sharing_user_unavailable" -> return Unavailable
                "access_denied" -> return Denied
            }
            if (normalized in reauthenticationCodes) return Expired
            return when {
                status == 401 -> Rejected(401)
                status == 429 -> UsageLimit
                status != null && status >= 500 -> Unavailable
                else -> Rejected(status)
            }
        }
    }
}

internal fun ByteArray.base64Url(): String = Base64.getUrlEncoder().withoutPadding().encodeToString(this)

internal fun String.base64UrlBytes(): ByteArray? = runCatching { Base64.getUrlDecoder().decode(trimEnd('=')) }.getOrNull()

internal fun String.base64UrlJson(): JSONObject? = base64UrlBytes()?.let { runCatching { JSONObject(String(it)) }.getOrNull() }

internal fun JSONObject.optNullable(key: String): String? = if (isNull(key)) null else opt(key) as? String
