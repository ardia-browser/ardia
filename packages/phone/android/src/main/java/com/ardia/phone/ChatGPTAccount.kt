package com.ardia.phone

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import com.ardia.chatgpt.ChatGPTAuth
import com.ardia.chatgpt.ChatGPTAuthorization
import com.ardia.chatgpt.ChatGPTConnection
import com.ardia.chatgpt.ChatGPTEndpoints
import com.ardia.chatgpt.ChatGPTFailure
import com.ardia.chatgpt.ChatGPTIdentity
import com.ardia.chatgpt.ChatGPTModel
import com.ardia.chatgpt.ChatGPTResponses
import com.ardia.chatgpt.ChatGPTSignature
import com.ardia.chatgpt.ChatGPTTokens
import com.ardia.chatgpt.LoopbackRequest
import com.ardia.chatgpt.ServerSentEvents
import com.ardia.sync.KeystoreKeyStore
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.CookieJar
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

internal data class ChatGPTAccountState(
    val connection: ChatGPTConnection? = null,
    val isSigningIn: Boolean = false,
    val problem: String? = null,
    val isDisconnecting: Boolean = false,
) {
    val isConnected: Boolean get() = connection != null && !isDisconnecting
    val accountLabel: String? get() = connection?.takeIf { isConnected }?.let { it.identity.email ?: it.identity.name ?: "ChatGPT account" }
}

internal class ChatGPTAccount(context: Context) {
    private val app = context.applicationContext
    private val secrets = KeystoreKeyStore(File(app.noBackupFilesDir, "ChatGPT"), alias = "Ardia ChatGPT Key")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mutableState = MutableStateFlow(ChatGPTAccountState(connection = loadConnection()))
    private var refreshing: Deferred<Unit>? = null
    private var connectionGeneration = 0L
    private var disconnecting: Boolean
        get() = mutableState.value.isDisconnecting
        set(value) = mutableState.update { it.copy(isDisconnecting = value) }

    val state: StateFlow<ChatGPTAccountState> = mutableState.asStateFlow()
    val isConnected: Boolean get() = state.value.isConnected
    var onDisconnected: (() -> Unit)? = null

    private val connection: ChatGPTConnection? get() = state.value.connection

    private fun loadConnection(): ChatGPTConnection? {
        val stored = secrets.load(CONNECTION_KEY)?.let { ChatGPTConnection.fromJson(String(it)) } ?: return null
        return stored.takeIf { it.endpoints.issuer == issuer }
    }

    private val registrationKey: String
        get() = "registration-" + MessageDigest.getInstance("SHA-256").digest(issuer.toByteArray()).joinToString("") { "%02x".format(it) }.take(16)

    private val issuer: String get() = ChatGPTEndpoints.OPENAI_ISSUER

    private val api: String get() = ChatGPTEndpoints.OPENAI_API

    fun choose(slug: String) {
        val current = connection ?: return
        if (current.models.none { it.slug == slug }) return
        save(current.copy(chosenModel = slug))
    }

    fun chooseEffort(effort: String?) {
        val current = connection ?: return
        save(current.copy(chosenEffort = effort))
    }

    fun clearProblem() = mutableState.update { it.copy(problem = null) }

    fun noteProblem(message: String) = mutableState.update { it.copy(problem = message) }

    suspend fun signIn(activity: Activity): Boolean {
        if (disconnecting || state.value.isSigningIn) return false
        val generation = connectionGeneration
        mutableState.update { it.copy(isSigningIn = true, problem = null) }
        return try {
            val made = authorize(activity)
            if (disconnecting || generation != connectionGeneration) return false
            connectionGeneration++
            refreshing = null
            save(made)
            loadModels()
            isConnected
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: ChatGPTFailure) {
            if (failure !is ChatGPTFailure.Cancelled) noteProblem(failure.message)
            false
        } catch (error: Exception) {
            noteProblem(ChatGPTFailure.Network.message)
            false
        } finally {
            mutableState.update { it.copy(isSigningIn = false) }
        }
    }

    suspend fun disconnect() {
        val original = connection ?: return
        if (disconnecting) return
        disconnecting = true
        withContext(NonCancellable) {
            try {
                onDisconnected?.invoke()
                refreshing?.let { runCatching { it.await() } }
                val current = connection ?: original
                forget()
                if (!revoke(current)) noteProblem("Disconnected on this phone, but OpenAI didn’t confirm it. You can also remove Ardia in ChatGPT’s settings.")
            } finally {
                disconnecting = false
            }
        }
    }

    private fun forget() {
        connectionGeneration++
        refreshing = null
        secrets.delete(CONNECTION_KEY)
        mutableState.update { it.copy(connection = null) }
    }

    private suspend fun revoke(connection: ChatGPTConnection): Boolean {
        val endpoint = connection.endpoints.revocation ?: return false
        val refreshToken = (connection.pendingTokens ?: connection.tokens).refreshToken
        repeat(2) { attempt ->
            val request = Request.Builder().url(endpoint).post(ChatGPTAuthorization.revocation(refreshToken, connection.clientId).toRequestBody(FORM)).build()
            val status = runCatching { ChatGPTHttp.send(request, timeoutSeconds = 10).second }.getOrNull()
            if (status == 200) return true
            if (attempt == 1 || (status != null && status < 500)) return false
            delay(300)
        }
        return false
    }

    suspend fun validConnection(forceRefresh: Boolean = false): ChatGPTConnection {
        if (disconnecting) throw ChatGPTFailure.Expired
        val current = connection ?: throw ChatGPTFailure.Expired
        val generation = connectionGeneration
        val task = refreshing ?: run {
            if (!forceRefresh && current.pendingTokens == null && !current.tokens.needsRefresh()) return current
            scope.async(start = CoroutineStart.LAZY) {
                try {
                    refresh(current, generation)
                } finally {
                    if (generation == connectionGeneration) refreshing = null
                }
            }.also { refreshing = it }
        }
        task.await()
        if (disconnecting) throw ChatGPTFailure.Expired
        return currentConnection(generation)
    }

    suspend fun currentModel(): ChatGPTModel {
        connection?.model?.let { return it }
        loadModels()
        return connection?.model ?: throw ChatGPTFailure.Unsupported
    }

    private fun failed(failure: ChatGPTFailure, generation: Long) {
        if (failure.requiresSignIn && !disconnecting && generation == connectionGeneration) signOutLocally(failure)
    }

    private suspend fun authorize(activity: Activity): ChatGPTConnection {
        val endpoints = discover()
        val previousSubject = connection?.identity?.subject
        var started: LoopbackCallbackServer? = null
        try {
            val server = withContext(Dispatchers.IO) { LoopbackCallbackServer.start().also { started = it } }
            val savedClientId = secrets.load(registrationKey)?.let { String(it) }?.takeIf(ChatGPTAuth::isValidClientId)
            val authorization = ChatGPTAuthorization(server.port, savedClientId, connection?.identity?.email)
            server.expect(authorization.state, savedClientId)
            val returned = BrowserReturn(activity)
            try {
                openBrowser(activity, authorization.url(endpoints.authorization))
                val raced = withTimeoutOrNull(SIGN_IN_TIMEOUT_MS) {
                    select<LoopbackRequest.Outcome?> {
                        server.outcome.onAwait { it }
                        returned.cameBackEmpty.onAwait { null }
                    }
                }
                val outcome = raced ?: if (server.outcome.isCompleted) server.outcome.await() else throw ChatGPTFailure.Cancelled
                return finish(outcome, authorization, endpoints, previousSubject)
            } finally {
                returned.stop()
            }
        } finally {
            withContext(NonCancellable + Dispatchers.IO) { started?.stop() }
        }
    }

    private suspend fun finish(outcome: LoopbackRequest.Outcome, authorization: ChatGPTAuthorization, endpoints: ChatGPTEndpoints, previousSubject: String?): ChatGPTConnection = when (outcome) {
        is LoopbackRequest.Outcome.Denied -> throw ChatGPTFailure.classify(outcome.error, null)
        LoopbackRequest.Outcome.Incomplete -> throw ChatGPTFailure.SignInIncomplete
        is LoopbackRequest.Outcome.Code -> {
            secrets.save(outcome.clientId.toByteArray(), registrationKey)
            val request = Request.Builder().url(endpoints.token).header("Accept", "application/json").post(authorization.codeExchange(outcome.code, outcome.clientId).toRequestBody(FORM)).build()
            val (body, status) = ChatGPTHttp.send(request, timeoutSeconds = 30)
            if (status != 200) throw ChatGPTFailure.api(body, status)
            val tokens = ChatGPTTokens.parse(body)
            val idToken = tokens.idToken ?: throw ChatGPTFailure.InvalidIdentity
            val identity = checkedIdentity(idToken, endpoints, outcome.clientId, authorization.nonce).requireCurrent()
            if (previousSubject != null && identity.subject != previousSubject) throw ChatGPTFailure.AccountMismatch
            ChatGPTConnection(outcome.clientId, identity, tokens, endpoints, chosenModel = connection?.chosenModel)
        }
    }

    private fun openBrowser(activity: Activity, url: String) {
        val uri = Uri.parse(url)
        val provider = CustomTabsClient.getPackageName(activity, null, false)?.takeIf { it != activity.packageName }
        if (provider != null) {
            val tab = CustomTabsIntent.Builder().setShareState(CustomTabsIntent.SHARE_STATE_OFF).setShowTitle(true).build()
            tab.intent.setPackage(provider)
            if (runCatching { tab.launchUrl(activity, uri) }.isSuccess) return
        }
        val view = Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)
        val other = activity.packageManager.queryIntentActivities(view, 0).map { it.activityInfo.packageName }.firstOrNull { it != activity.packageName }
        if (other != null) view.setPackage(other)
        runCatching { activity.startActivity(view) }.onFailure { throw ChatGPTFailure.SignInIncomplete }
    }

    private suspend fun discover(): ChatGPTEndpoints {
        val issuer = issuer
        val (body, status) = ChatGPTHttp.send(Request.Builder().url(ChatGPTEndpoints.discoveryUrl(issuer)).build(), timeoutSeconds = 15)
        if (status != 200) throw ChatGPTFailure.DiscoveryFailed
        return ChatGPTEndpoints.fromDiscovery(body, issuer, api)
    }

    private fun currentConnection(generation: Long): ChatGPTConnection =
        connection?.takeIf { generation == connectionGeneration } ?: throw ChatGPTFailure.Expired

    private suspend fun refresh(previous: ChatGPTConnection, generation: Long) {
        try {
            val pending = previous.pendingTokens
            if (pending != null) {
                val idToken = pending.idToken ?: throw ChatGPTFailure.InvalidIdentity
                val checked = checkedIdentity(idToken, previous.endpoints, previous.clientId, null)
                val verified = currentConnection(generation).confirmed(checked.identity)
                if (!checked.expired && !pending.needsRefresh()) {
                    save(verified.copy(tokens = pending, pendingTokens = null))
                    return
                }
            }
            val currentTokens = pending ?: previous.tokens
            val request = Request.Builder().url(previous.endpoints.token).header("Accept", "application/json").post(ChatGPTAuthorization.refresh(currentTokens.refreshToken, previous.clientId).toRequestBody(FORM)).build()
            val (body, status) = ChatGPTHttp.send(request, timeoutSeconds = 30)
            if (status != 200) throw ChatGPTFailure.api(body, status)
            publishRotation(ChatGPTTokens.parse(body, currentTokens.scopes), generation)
        } catch (failure: ChatGPTFailure) {
            failed(failure, generation)
            throw failure
        }
    }

    private suspend fun publishRotation(tokens: ChatGPTTokens, generation: Long) {
        val latest = currentConnection(generation)
        val idToken = tokens.idToken
        if (idToken == null) {
            save(latest.copy(tokens = tokens, pendingTokens = null))
            return
        }
        save(latest.copy(pendingTokens = tokens))
        val identity = checkedIdentity(idToken, latest.endpoints, latest.clientId, null).requireCurrent()
        save(currentConnection(generation).confirmed(identity).copy(tokens = tokens, pendingTokens = null))
    }

    private suspend fun checkedIdentity(idToken: String, endpoints: ChatGPTEndpoints, clientId: String, nonce: String?): ChatGPTIdentity.Checked {
        val keys = try {
            val (body, status) = ChatGPTHttp.send(Request.Builder().url(endpoints.jwks).build(), timeoutSeconds = 15)
            if (status != 200) throw ChatGPTFailure.Unavailable
            body
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            throw ChatGPTFailure.Unavailable
        }
        return withContext(Dispatchers.Default) {
            ChatGPTSignature.verify(idToken, keys)
            ChatGPTIdentity.check(idToken, endpoints.issuer, clientId, nonce)
        }
    }

    private suspend fun loadModels() {
        val before = connection ?: return
        val generation = connectionGeneration
        try {
            val current = validConnection()
            val request = Request.Builder().url(current.endpoints.api.trimEnd('/') + "/models").header("Authorization", "Bearer ${current.tokens.accessToken}").header("Accept", "application/json").build()
            val (body, status) = ChatGPTHttp.send(request, timeoutSeconds = 20)
            if (status != 200) throw ChatGPTFailure.api(body, status)
            val models = ChatGPTModel.catalog(body)
            val latest = connection ?: return
            if (disconnecting || generation != connectionGeneration || latest.identity.subject != before.identity.subject) return
            save(latest.copy(models = models))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: ChatGPTFailure) {
            failed(failure, generation)
        } catch (error: Exception) {
        }
    }

    private fun save(next: ChatGPTConnection) {
        mutableState.update { it.copy(connection = next) }
        val data = next.toJson().toByteArray()
        if (!secrets.save(data, CONNECTION_KEY)) secrets.save(data, CONNECTION_KEY)
    }

    private fun signOutLocally(failure: ChatGPTFailure) {
        forget()
        noteProblem(failure.message)
    }

    suspend fun streamAnswer(instructions: String, prompt: String, onText: (String) -> Unit): ChatGPTModel {
        val generation = connectionGeneration
        val model = currentModel()
        var current = validConnection()
        repeat(2) { attempt ->
            try {
                stream(current, model, instructions, prompt, onText)
                return model
            } catch (failure: ChatGPTFailure) {
                if (failure is ChatGPTFailure.Rejected && failure.status == 401 && attempt == 0) {
                    current = validConnection(forceRefresh = true)
                } else {
                    failed(failure, generation)
                    throw failure
                }
            }
        }
        throw ChatGPTFailure.Rejected(401)
    }

    private suspend fun stream(connection: ChatGPTConnection, model: ChatGPTModel, instructions: String, prompt: String, onText: (String) -> Unit) {
        val request = Request.Builder()
            .url(connection.endpoints.api.trimEnd('/') + "/responses")
            .header("Authorization", "Bearer ${connection.tokens.accessToken}")
            .header("Accept", "text/event-stream")
            .post(ChatGPTResponses.body(model.slug, instructions, prompt, connection.effort).toRequestBody(JSON))
            .build()
        ChatGPTHttp.exchange(request, timeoutSeconds = 180) { response ->
            val status = response.code
            if (status != 200) throw ChatGPTFailure.api(runCatching { response.peekBody(MAXIMUM_ERROR_BYTES).string() }.getOrNull(), status)
            val source = response.body?.source() ?: throw ChatGPTFailure.StreamInterrupted
            val events = ServerSentEvents()
            var text = ""
            while (true) {
                val line = try {
                    source.readUtf8Line()
                } catch (error: IOException) {
                    currentCoroutineContext().ensureActive()
                    throw ChatGPTFailure.StreamInterrupted
                } ?: break
                currentCoroutineContext().ensureActive()
                val payload = events.feed(line) ?: continue
                when (val event = ChatGPTResponses.event(payload, status)) {
                    is ChatGPTResponses.Event.Delta -> {
                        text += event.text
                        if (text.length > MAXIMUM_ANSWER_CHARACTERS) throw ChatGPTFailure.StreamInterrupted
                        val shown = text
                        withContext(Dispatchers.Main.immediate) { onText(shown) }
                    }
                    ChatGPTResponses.Event.Completed -> {
                        if (text.isBlank()) throw ChatGPTFailure.Rejected(null)
                        return@exchange
                    }
                    is ChatGPTResponses.Event.Failed -> throw event.failure
                    ChatGPTResponses.Event.Incomplete -> throw ChatGPTFailure.StreamInterrupted
                    ChatGPTResponses.Event.Ignored -> Unit
                }
            }
            currentCoroutineContext().ensureActive()
            throw ChatGPTFailure.StreamInterrupted
        }
    }

    private class BrowserReturn(private val activity: Activity) : Application.ActivityLifecycleCallbacks {
        val cameBackEmpty = CompletableDeferred<Unit>()
        private var left = false
        private var waiting: kotlinx.coroutines.Job? = null
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

        init {
            activity.application.registerActivityLifecycleCallbacks(this)
        }

        fun stop() {
            activity.application.unregisterActivityLifecycleCallbacks(this)
            scope.coroutineContext.job.cancel()
        }

        override fun onActivityPaused(paused: Activity) {
            if (paused === activity) left = true
            waiting?.cancel()
        }

        override fun onActivityResumed(resumed: Activity) {
            if (resumed !== activity || !left) return
            waiting = scope.launch {
                delay(RETURN_GRACE_MS)
                cameBackEmpty.complete(Unit)
            }
        }

        override fun onActivityCreated(created: Activity, savedInstanceState: Bundle?) = Unit
        override fun onActivityStarted(started: Activity) = Unit
        override fun onActivityStopped(stopped: Activity) = Unit
        override fun onActivitySaveInstanceState(saved: Activity, outState: Bundle) = Unit
        override fun onActivityDestroyed(destroyed: Activity) {
            if (destroyed === activity) cameBackEmpty.complete(Unit)
        }
    }

    companion object {
        const val USAGE_URL = "https://chatgpt.com/settings/usage"
        private const val CONNECTION_KEY = "connection"
        private const val SIGN_IN_TIMEOUT_MS = 10 * 60_000L
        private const val RETURN_GRACE_MS = 2_000L
        private const val MAXIMUM_ANSWER_CHARACTERS = 64 * 1024
        private const val MAXIMUM_ERROR_BYTES = 64L * 1024
        private val FORM = "application/x-www-form-urlencoded".toMediaType()
        private val JSON = "application/json".toMediaType()
    }
}

internal object ChatGPTHttp {
    private const val MAXIMUM_BODY_BYTES = 1024L * 1024

    private val base: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .cookieJar(CookieJar.NO_COOKIES)
            .cache(null)
            .build()
    }

    private fun client(timeoutSeconds: Long): OkHttpClient = base.newBuilder().callTimeout(timeoutSeconds, TimeUnit.SECONDS).readTimeout(timeoutSeconds, TimeUnit.SECONDS).build()

    suspend fun send(request: Request, timeoutSeconds: Long): Pair<String, Int> = exchange(request, timeoutSeconds) { response ->
        (response.boundedText(MAXIMUM_BODY_BYTES) ?: throw ChatGPTFailure.Network) to response.code
    }

    suspend fun <T> exchange(request: Request, timeoutSeconds: Long, read: suspend (Response) -> T): T = try {
        client(timeoutSeconds).exchange(request, read)
    } catch (unreachable: HttpUnreachable) {
        throw ChatGPTFailure.Network
    }
}
