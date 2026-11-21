package com.ardia.phone

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.view.View
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.ProfileStore
import androidx.webkit.WebStorageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.ardia.browser.BrowserUserAgent
import com.ardia.browser.PageFilter
import com.ardia.browser.PageScripts
import com.ardia.browser.ReadableContent
import com.ardia.research.ResearchLink
import com.ardia.research.ResearchSearch
import java.io.ByteArrayInputStream
import java.util.Locale
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject

internal class ResearchPageLoader(context: Context, private val filter: PageFilter?) {
    private val app = context.applicationContext
    private val separatesProfile = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)
    private val profileName = PROFILE_PREFIX + UUID.randomUUID()
    private var profileMade = false
    private val live = mutableSetOf<WebView>()
    private val reader: String by lazy { app.assets.open("ardia-browser/readable-content.js").bufferedReader().use { it.readText() } }
    private val userAgent: String by lazy { BrowserUserAgent.mobile(WebSettings.getDefaultUserAgent(app)) }

    init {
        sweepStaleProfiles(separatesProfile)
    }

    suspend fun searchLinks(query: String): List<ResearchLink> {
        val request = Request.Builder()
            .url(ResearchSearch.resultsPage(query))
            .header("User-Agent", userAgent)
            .header("Accept-Language", acceptLanguage())
            .build()
        return http(SEARCH_TIMEOUT_SECONDS).exchange(request) { response ->
            if (response.code != 200) return@exchange emptyList()
            ResearchSearch.links(response.boundedText(MAXIMUM_PAGE_BYTES).orEmpty())
        }
    }

    suspend fun read(link: ResearchLink): ReadableContent? = runCatching {
        if (filter?.blocks(link.url, link.url, true) == true) return@runCatching null
        if (separatesProfile) readRendered(link) else readInert(link)
    }.getOrElse { if (it is kotlin.coroutines.cancellation.CancellationException) throw it else null }

    @SuppressLint("RequiresFeature")
    private suspend fun readRendered(link: ResearchLink): ReadableContent? = withContext(Dispatchers.Main.immediate) {
        val web = makeWebView(isolated = true)
        try {
            val loaded = CompletableDeferred<Boolean>()
            web.webViewClient = RenderedClient(loaded)
            web.loadUrl(link.url)
            val finished = withTimeoutOrNull(PAGE_TIMEOUT_MS) { loaded.await() }
            if (finished == false) return@withContext null
            delay(SETTLE_MS)
            extract(web, PageScripts.readerCall(reader))
        } finally {
            release(web)
        }
    }

    private suspend fun readInert(link: ResearchLink): ReadableContent? {
        val request = Request.Builder().url(link.url).header("User-Agent", userAgent).header("Accept-Language", acceptLanguage()).header("Accept", "text/html,application/xhtml+xml").build()
        val page = http(PAGE_TIMEOUT_MS / 1000).exchange(request) { response ->
            val type = response.header("Content-Type").orEmpty().lowercase(Locale.ROOT)
            if (!response.isSuccessful || !(type.contains("html") || type.isEmpty())) return@exchange null
            val finalUrl = response.request.url.toString()
            if (filter?.blocks(finalUrl, finalUrl, true) == true) return@exchange null
            response.boundedText(MAXIMUM_PAGE_BYTES)?.let { finalUrl to it }
        } ?: return null
        return withContext(Dispatchers.Main.immediate) {
            val web = makeWebView(isolated = false)
            try {
                val loaded = CompletableDeferred<Boolean>()
                web.webViewClient = InertClient(loaded)
                web.loadDataWithBaseURL(null, "<!doctype html><title></title>", "text/html", "utf-8", null)
                if (withTimeoutOrNull(PAGE_TIMEOUT_MS) { loaded.await() } != true) return@withContext null
                extract(web, inertReaderCall(page.second, page.first))
            } finally {
                release(web)
            }
        }
    }

    private fun inertReaderCall(html: String, url: String): String =
        "((document, location) => {\n" +
            "const base = document.createElement(\"base\"); base.href = location.href; document.head.prepend(base);\n" +
            "$reader\n})(new DOMParser().parseFromString(${JSONObject.quote(html)}, \"text/html\"), new URL(${JSONObject.quote(url)}))"

    private suspend fun extract(web: WebView, script: String): ReadableContent? {
        val raw = CompletableDeferred<String?>()
        web.evaluateJavascript(script) { raw.complete(it) }
        val json = PageScripts.decodeEvaluationResult(withTimeoutOrNull(EXTRACT_TIMEOUT_MS) { raw.await() }) ?: return null
        return withContext(Dispatchers.Default) { runCatching { ReadableContent.fromJson(json) }.getOrNull() }
    }

    @SuppressLint("SetJavaScriptEnabled", "RequiresFeature")
    private fun makeWebView(isolated: Boolean): WebView {
        val web = WebView(app)
        if (isolated) {
            val profile = ProfileStore.getInstance().getOrCreateProfile(profileName)
            profileMade = true
            WebViewCompat.setProfile(web, profileName)
            profile.cookieManager.setAcceptThirdPartyCookies(web, false)
        }
        web.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = isolated
            blockNetworkLoads = !isolated
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = true
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            setGeolocationEnabled(false)
            userAgentString = userAgent
            cacheMode = WebSettings.LOAD_NO_CACHE
        }
        val metrics = app.resources.displayMetrics
        val width = (PAGE_WIDTH_DP * metrics.density).toInt()
        val height = (PAGE_HEIGHT_DP * metrics.density).toInt()
        web.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
        web.layout(0, 0, width, height)
        live += web
        return web
    }

    private fun release(web: WebView) {
        live -= web
        web.stopLoading()
        web.webViewClient = WebViewClient()
        web.destroy()
    }

    @SuppressLint("RequiresFeature")
    fun finish() {
        for (web in live.toList()) release(web)
        if (!profileMade) return
        profileMade = false
        val store = ProfileStore.getInstance()
        if (runCatching { store.deleteProfile(profileName) }.getOrDefault(false)) return
        val profile = runCatching { store.getProfile(profileName) }.getOrNull() ?: return
        runCatching { profile.cookieManager.removeAllCookies { profile.cookieManager.flush() } }
        runCatching { profile.webStorage.deleteAllData() }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA)) runCatching { WebStorageCompat.deleteBrowsingData(profile.webStorage) {} }
    }

    private inner class RenderedClient(private val loaded: CompletableDeferred<Boolean>) : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val scheme = request.url.scheme?.lowercase(Locale.ROOT)
            return scheme != "https" && scheme != "http"
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val scheme = request.url.scheme?.lowercase(Locale.ROOT)
            if (scheme != "https" && scheme != "http") return blocked()
            val url = request.url.toString()
            val blocks = runCatching { filter?.blocks(url, if (request.isForMainFrame) url else null, request.isForMainFrame) == true }.getOrDefault(false)
            return if (blocks) blocked() else null
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) = Unit

        override fun onPageFinished(view: WebView, url: String) {
            loaded.complete(true)
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) loaded.complete(false)
        }
    }

    private class InertClient(private val loaded: CompletableDeferred<Boolean>) : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse = blocked()

        override fun onPageFinished(view: WebView, url: String) {
            loaded.complete(true)
        }
    }

    companion object {
        private const val PROFILE_PREFIX = "ardia-research-"
        private const val SEARCH_TIMEOUT_SECONDS = 10L
        private const val PAGE_TIMEOUT_MS = 8_000L
        private const val SETTLE_MS = 350L
        private const val EXTRACT_TIMEOUT_MS = 5_000L
        private const val MAXIMUM_PAGE_BYTES = 2L * 1024 * 1024
        private const val PAGE_WIDTH_DP = 390
        private const val PAGE_HEIGHT_DP = 844
        private var swept = false

        private val base: OkHttpClient by lazy {
            OkHttpClient.Builder().cookieJar(CookieJar.NO_COOKIES).cache(null).followRedirects(true).followSslRedirects(true).build()
        }

        private fun http(timeoutSeconds: Long): OkHttpClient = base.newBuilder().callTimeout(timeoutSeconds, TimeUnit.SECONDS).build()

        private fun blocked() = WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))

        private fun acceptLanguage(): String = android.os.LocaleList.getDefault().let { list -> (0 until minOf(list.size(), 3)).joinToString(",") { list[it].toLanguageTag() } }

        @SuppressLint("RequiresFeature")
        private fun sweepStaleProfiles(supported: Boolean) {
            if (swept || !supported) return
            swept = true
            runCatching {
                val store = ProfileStore.getInstance()
                for (stale in store.allProfileNames.filter { it.startsWith(PROFILE_PREFIX) }) runCatching { store.deleteProfile(stale) }
            }
        }
    }
}
