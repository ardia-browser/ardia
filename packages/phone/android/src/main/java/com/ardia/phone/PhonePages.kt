package com.ardia.phone

import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.util.Base64
import android.webkit.WebView
import com.ardia.browser.BrowserUrl
import com.ardia.browser.CaptureRoute
import com.ardia.browser.DevelopmentWebViewEngine
import com.ardia.browser.DownloadFailure
import com.ardia.browser.DownloadOutcome
import com.ardia.browser.DownloadProgress
import com.ardia.browser.Page
import com.ardia.browser.PageEvent
import com.ardia.browser.PageSetup
import com.ardia.browser.PopupRequest
import com.ardia.browser.PrivatePagesUnavailableException
import com.ardia.browser.SystemDownloads
import com.ardia.browser.VisitKind
import com.ardia.browser.WebViewPage
import expo.modules.kotlin.exception.CodedException
import java.lang.ref.WeakReference
import java.util.UUID
import kotlin.math.roundToInt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch

typealias EventSink = (Map<String, Any?>) -> Unit

object PhonePages {
    private var shared: DevelopmentWebViewEngine? = null
    private lateinit var app: Context
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val watchers = HashMap<String, Job>()
    private val popups = HashMap<String, PopupRequest>()
    private var host: WeakReference<Activity>? = null
    private val views = HashMap<String, WeakReference<PageView>>()
    private val visuals = PageVisuals().apply {
        onNoLongerCurrent = { id, change, millis ->
            if (PhoneLab.isOn) android.util.Log.i("PAGELAB", "PAGELAB snapshot $id no longer current: page ${change.word} $millis ms after its capture")
        }
    }
    private var drawWatched: WeakReference<android.view.View>? = null
    private val drawWatch = android.view.ViewTreeObserver.OnDrawListener {
        for ((id, view) in views) {
            if (view.get() != null) visuals.noteDirty(id, page(id)?.view?.value)
        }
    }

    lateinit var sitePreferences: PhoneSitePreferences
        private set
    lateinit var blocking: PhoneBlocking
        private set
    lateinit var sitePermissions: SitePermissionStore
        private set
    lateinit var downloads: SystemDownloads
        private set
    lateinit var snapshots: PageSnapshots
        private set
    val fullscreen = FullscreenHost()

    var pageSink: EventSink? = null
    var downloadSink: EventSink? = null
    var blockingSink: EventSink? = null

    fun hasEngine(): Boolean = shared != null

    private var translations: PhoneTranslation? = null

    fun translation(context: Context): PhoneTranslation = translations ?: PhoneTranslation(context.applicationContext.getSharedPreferences(SITE_PREFERENCES, Context.MODE_PRIVATE)).also { translations = it }

    @Synchronized
    fun engine(context: Context): DevelopmentWebViewEngine = shared ?: run {
        if (UpgradeGate.pending(context)) throw CodedException("ERR_IMPORT_PENDING", "The import from the previous Ardia app has not finished", null)
        create(context.applicationContext)
    }

    private fun create(context: Context): DevelopmentWebViewEngine {
        app = context
        sitePreferences = PhoneSitePreferences(context.getSharedPreferences(SITE_PREFERENCES, Context.MODE_PRIVATE))
        translation(context)
        blocking = PhoneBlocking(context)
        snapshots = PageSnapshots(context, ImageMemory::forget)
        ImageMemory.watch(context)
        sitePermissions = SitePermissionStore(context.getSharedPreferences(SITE_PREFERENCES, Context.MODE_PRIVATE), held = { permission ->
            SitePermissionGate.granted(permission, SitePermissionGate.held(context, permission))
        })
        val made = DevelopmentWebViewEngine(context, sitePreferences)
        made.rememberedPermissions = sitePermissions
        made.filter = blocking.pageFilter(isPrivate = false)
        made.privateFilter = blocking.pageFilter(isPrivate = true)
        made.onPrivateBrowsingEnded = ::privateBrowsingEnded
        made.onNightShadeVerdict = { use -> scope.launch(Dispatchers.IO) { PendingCounts.add(context, PendingCounts.nightShadeField(use), UsageConsent.window(context)) } }
        if (PhoneLab.isOn) {
            made.desktopTrace = { pageId, line ->
                android.util.Log.i("PAGELAB", line)
                send(pageId, "page.desktop", "line" to line)
            }
        }
        shared = made
        downloads = SystemDownloads(context, made)
        host?.get()?.let(made::attach)
        made.warmUp()
        blocking.start()
        scope.launch { downloads.active.collect { list -> downloadSink?.invoke(mapOf("name" to "downloads.progress", "downloads" to list.map(::progress))) } }
        scope.launch { downloads.outcomes.collect { outcome -> downloadSink?.invoke(finished(outcome)) } }
        scope.launch { blocking.changes.collect { blockingSink?.invoke(mapOf("name" to "blocking.state", "state" to blocking.state())) } }
        return made
    }

    fun attach(activity: Activity) {
        host = WeakReference(activity)
        watchDraws(activity.window.decorView)
        if (shared == null && UpgradeGate.pending(activity)) return
        engine(activity).attach(activity)
        blocking.refreshIfDue()
    }

    fun detach(activity: Activity) {
        if (host?.get() === activity) host = null
        if (drawWatched?.get() === activity.window.decorView) watchDraws(null)
        shared?.detach(activity)
        if (fullscreen.isShowing) fullscreen.hide("the activity detached")
    }

    fun hostActivity(): Activity? = host?.get()

    private fun watchDraws(decor: android.view.View?) {
        val watched = drawWatched?.get()
        if (watched === decor) return
        watched?.viewTreeObserver?.takeIf { it.isAlive }?.removeOnDrawListener(drawWatch)
        decor?.viewTreeObserver?.addOnDrawListener(drawWatch)
        drawWatched = decor?.let(::WeakReference)
    }

    fun snapshotIsCurrent(pageId: String): Boolean? = visuals.isCurrent(pageId)

    fun forgetSnapshots(pageId: String) = visuals.forget(pageId)

    fun open(context: Context, pageId: String, setup: PageSetup): Page {
        val engine = engine(context)
        val page = try {
            engine.open(pageId, setup)
        } catch (refused: PrivatePagesUnavailableException) {
            throw privatePagesUnavailable()
        }
        if (!watch(page)) page.request.value?.takeUnless { it.isAnswered }?.let { gateThenSend(page, it) }
        return page
    }

    fun setup(url: String?, title: String?, isPrivate: Boolean, savedState: String?): PageSetup {
        val saved = savedState?.let { runCatching { Base64.decode(it, Base64.NO_WRAP) }.getOrNull() ?: throw PagePayloads.badArgs("savedState is not base64") }
        return when {
            saved != null -> PageSetup(url = url, title = title.orEmpty(), isPrivate = isPrivate, savedState = saved, firstVisit = VisitKind.Restored)
            url != null -> PageSetup.fresh(url, VisitKind.Typed, title = title.orEmpty(), isPrivate = isPrivate)
            else -> PageSetup(title = title.orEmpty(), isPrivate = isPrivate)
        }
    }

    fun page(pageId: String): Page? = shared?.existing(pageId)

    fun revokeSitePermission(origin: String, permission: String?): Boolean {
        val one = permission?.let { SiteCapability.of(it) ?: return false }
        val revoked = sitePermissions.revoke(origin, one)
        if (revoked.isEmpty()) return false
        shared?.forgetGrants(origin, revoked.map(SiteCapability::permission).toSet())
        return true
    }

    fun require(pageId: String): Page = page(pageId) ?: throw CodedException("ERR_NO_PAGE", "No page is open with id $pageId", null)

    fun activate(pageId: String) {
        val engine = shared ?: return
        val page = engine.existing(pageId) ?: return
        engine.open(pageId, PageSetup(isPrivate = page.isPrivate))
    }

    fun viewShows(pageId: String, view: PageView) {
        views[pageId] = WeakReference(view)
        permissionAsks.pump()
    }

    fun viewLeaves(pageId: String, view: PageView) {
        if (views[pageId]?.get() === view) views.remove(pageId)
    }

    fun summarize(pageId: String): Boolean = views[pageId]?.get()?.takeIf { it.page?.id == pageId }?.summarize(PageSummarySession.Trigger.Menu) == true

    fun dismissSummaries() {
        for (view in views.values.mapNotNull { it.get() }) view.dismissSummary(animated = true)
    }

    fun report(pageId: String, name: String, vararg fields: Pair<String, Any?>) = send(pageId, name, *fields)

    fun discardBackgroundPages(keeping: String?) {
        val engine = shared ?: return
        keeping?.let(::activate)
        engine.discardBackgroundPages()
    }

    fun find(pageId: String, text: String) {
        val page = require(pageId)
        if (text.isNotEmpty() && page.find.value?.query == text) return
        page.find(text)
    }

    suspend fun evaluate(pageId: String, script: String): String? {
        activate(pageId)
        val web = require(pageId).view.value as? WebView ?: throw CodedException("ERR_ENGINE", "The page has no web view", null)
        return kotlinx.coroutines.suspendCancellableCoroutine { continuation ->
            web.evaluateJavascript(script) { result -> if (continuation.isActive) continuation.resumeWith(Result.success(result?.takeUnless { it == "null" || it == "undefined" })) }
        }
    }

    fun livePageIds(): List<String> = shared?.livePageIds.orEmpty()

    fun loadHtml(pageId: String, html: String, baseUrl: String) {
        if (!BrowserUrl.isWeb(baseUrl)) throw PagePayloads.badArgs("baseUrl must be an http or https address")
        val page = require(pageId) as? WebViewPage ?: throw CodedException("ERR_ENGINE", "This page engine cannot load HTML", null)
        activate(pageId)
        val web = page.webViewOrNull ?: throw CodedException("ERR_ENGINE", "The page has no web view", null)
        page.startDocumentRequests()
        page.prepareNavigation(web, baseUrl)
        web.loadDataWithBaseURL(baseUrl, html, "text/html", "utf-8", baseUrl)
    }

    fun scrollPosition(pageId: String): Map<String, Any?>? {
        val web = page(pageId)?.view?.value as? WebView ?: return null
        val density = web.resources.displayMetrics.density
        @Suppress("DEPRECATION")
        val contentPixels = web.contentHeight * web.scale
        return mapOf(
            "y" to (web.scrollY / density).toDouble(),
            "viewportWidth" to (web.width / density).toDouble(),
            "viewportHeight" to (web.height / density).toDouble(),
            "contentHeight" to (contentPixels / density).toDouble(),
        )
    }

    suspend fun snapshot(pageId: String, maxWidth: Int, quality: Int, covered: Pair<Double, Double>?): Map<String, Any?>? {
        val page = require(pageId)
        val generation = kotlinx.coroutines.withContext(Dispatchers.Main.immediate) { visuals.generation(pageId) }
        val started = android.os.SystemClock.uptimeMillis()
        val drawn = page.snapshot(maxWidth) ?: return null
        val captured = android.os.SystemClock.uptimeMillis()
        val route = (page as? WebViewPage)?.lastCaptureRoute
        val web = page.view.value
        val shown = views[pageId]?.get()
        val insets = covered ?: shown?.croppedToneInsets()
        val bare = if (route == CaptureRoute.WindowCopy && web != null && web.width > 0 && insets != null) withoutCovered(drawn, web.width, web.resources.displayMetrics.density, insets) else drawn
        val banded = kotlinx.coroutines.withContext(Dispatchers.Main.immediate) { shown?.let { view -> view.bands().takeUnless { it.isEmpty }?.let { view to it } } }
        val picture = banded?.let { (view, bands) -> PageBands.compose(bare, view.width, view.height, bands, view.bandColours().first, view.bandColours().second) } ?: bare
        if (picture !== bare && picture !== drawn) bare.takeIf { it !== drawn }?.recycle()
        val frame = kotlinx.coroutines.withContext(Dispatchers.Main.immediate) { views[pageId]?.get()?.let(::frameInWindow) }
        val decoded = picture.copy(Bitmap.Config.ARGB_8888, false)
        val writeStarted = android.os.SystemClock.uptimeMillis()
        val written = snapshots.publish(pageId, page, picture, decoded, page.isPrivate, quality, ImageMemory::pinDecoded) { uri, generation ->
            if (PhoneLab.isOn) android.util.Log.i("PAGELAB", "PAGELAB snapshot $pageId landed in ${android.os.SystemClock.uptimeMillis() - writeStarted} ms: generation $generation")
            scope.launch { send(pageId, "page.snapshotLanded", "uri" to uri, "generation" to generation.toDouble()) }
        } ?: return null
        if (written["kept"] != true) visuals.captured(pageId, generation)
        val held = written["durable"] == false
        if (PhoneLab.isOn) {
            val done = android.os.SystemClock.uptimeMillis()
            android.util.Log.i("PAGELAB", "PAGELAB snapshot $pageId ${picture.width}x${picture.height} by ${if (route == CaptureRoute.WindowCopy) "window copy" else "view draw"}, captured in ${captured - started} ms, ${if (held) "decoded picture pinned in the image cache, resolved before its JPEG lands" else if (written["kept"] == true) "blank, the previous picture kept" else "not pinned, resolved once its JPEG landed"} ${done - captured} ms after capture, page view in window ${frame ?: "unknown"} (dp), top inset cropped ${insets?.first ?: 0.0} dp")
        }
        return written + ("route" to if (route == CaptureRoute.WindowCopy) "windowCopy" else "draw") + ("frame" to frame)
    }

    private fun frameInWindow(view: android.view.View): Map<String, Double> {
        val at = IntArray(2)
        view.getLocationInWindow(at)
        val density = view.resources.displayMetrics.density.toDouble()
        return mapOf("x" to at[0] / density, "y" to at[1] / density, "width" to view.width / density, "height" to view.height / density)
    }

    private fun withoutCovered(bitmap: Bitmap, viewWidth: Int, density: Float, insets: Pair<Double, Double>): Bitmap {
        val scale = bitmap.width / viewWidth.toFloat()
        val top = (insets.first * density * scale).roundToInt().coerceAtLeast(0)
        val bottom = (insets.second * density * scale).roundToInt().coerceAtLeast(0)
        val height = bitmap.height - top - bottom
        if ((top == 0 && bottom == 0) || height < bitmap.height / 4) return bitmap
        val cropped = Bitmap.createBitmap(bitmap, 0, top, bitmap.width, height)
        if (cropped !== bitmap) bitmap.recycle()
        return cropped
    }

    fun close(pageId: String) {
        permissionAsks.drop(pageId)
        watchers.remove(pageId)?.cancel()
        views.remove(pageId)
        visuals.forget(pageId)
        val page = shared?.existing(pageId)
        if (page != null && fullscreen.owns(page.fullscreen.value)) fullscreen.hide("its page closed")
        popups.entries.removeAll { it.value.openerId == pageId }
        if (::snapshots.isInitialized && page != null) snapshots.close(pageId, page)
        shared?.close(pageId)
        if (::snapshots.isInitialized) {
            val files = snapshots.files(pageId)
            val dropped = ImageMemory.forgetAll(files)
            if (PhoneLab.isOn) android.util.Log.i("PAGELAB", "PAGELAB memory page closed: ${ImageMemory.closeSummary(files.size, dropped)}, image cache ${ImageMemory.cache()?.let(ImageMemory::describe) ?: "unknown"}")
        }
    }

    fun pageIds(): List<String> = watchers.keys.toList()

    fun endPrivateSession() {
        val engine = shared ?: return
        val privateIds = watchers.keys.filter { engine.existing(it)?.isPrivate == true }
        privateIds.forEach(::close)
    }

    fun openPopup(context: Context, pageId: String, popupId: String): Page? {
        val popup = popups.remove(popupId) ?: return null
        val page = try {
            engine(context).openPopup(pageId, popup)
        } catch (refused: PrivatePagesUnavailableException) {
            throw privatePagesUnavailable()
        }
        watch(page)
        return page
    }

    fun dismissPopup(popupId: String): Boolean = popups.remove(popupId) != null

    fun saveState(pageId: String): String? = page(pageId)?.saveState()?.let { Base64.encodeToString(it, Base64.NO_WRAP) }

    private fun holds(permissions: Array<String>): Map<String, Boolean> =
        permissions.associateWith { androidx.core.content.ContextCompat.checkSelfPermission(app, it) == android.content.pm.PackageManager.PERMISSION_GRANTED }

    internal val permissionAsks = SitePermissionAsks(visible = ::isOnScreen, held = ::holds)

    internal var androidPermissionGate: AndroidPermissionGate?
        get() = permissionAsks.gate
        set(value) {
            permissionAsks.gate = value
        }

    private val onScreenRect = android.graphics.Rect()

    private fun isOnScreen(pageId: String): Boolean {
        val activity = host?.get() as? androidx.lifecycle.LifecycleOwner ?: return false
        if (!activity.lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) return false
        val view = views[pageId]?.get() ?: return false
        if (!view.isAttachedToWindow || !view.isShown || view.width <= 0 || view.height <= 0) return false
        if (!view.getGlobalVisibleRect(onScreenRect)) return false
        return onScreenRect.width().toLong() * onScreenRect.height() * 2 >= view.width.toLong() * view.height
    }


    private fun gateThenSend(page: Page, request: com.ardia.browser.PageRequest?) {
        val id = page.id
        val kind = request?.kind
        if (request == null || kind !is com.ardia.browser.PageRequest.Kind.Permission) {
            permissionAsks.drop(id)
            send(id, "page.request", "request" to request?.let { PagePayloads.request(app, it) })
            return
        }
        val needed = PagePayloads.androidPermissions(kind.permission)
        if (SitePermissionGate.granted(kind.permission, holds(needed))) {
            permissionAsks.drop(id)
            send(id, "page.request", "request" to PagePayloads.request(app, request))
            return
        }
        if (permissionAsks.holds(id, request)) return
        if (PhoneLab.isOn && !isOnScreen(id)) android.util.Log.i("PAGELAB", "PAGELAB page request ${PagePayloads.permission(kind.permission)} from a page not on screen: Android is asked once the page shows")
        permissionAsks.hold(SitePermissionAsks.Ask(
            pageId = id,
            needed = needed,
            wanted = { !request.isAnswered && page.request.value === request && shared?.existing(id) === page },
            granted = { held -> SitePermissionGate.granted(kind.permission, held) },
            request = request,
        ) { granted ->
            if (granted) {
                send(id, "page.request", "request" to PagePayloads.request(app, request))
            } else {
                if (PhoneLab.isOn) android.util.Log.i("PAGELAB", "PAGELAB page request ${PagePayloads.permission(kind.permission)} refused by Android: the site's request ends without a dialog")
                request.dismiss()
            }
        })
    }

    private fun watch(page: Page): Boolean {
        if (watchers[page.id]?.isActive == true) return false
        val id = page.id
        watchers[id] = scope.launch {
            launch {
                page.state.collect {
                    translations?.remember(it.url, page.isPrivate)
                    visuals.changed(id, PageVisuals.Change.State)
                    send(id, "page.state", "state" to PagePayloads.state(app, it, page.isPrivate))
                }
            }
            launch { page.find.drop(1).filter { it == null || it.isDone }.collect { send(id, "page.find", "result" to PagePayloads.find(it)) } }
            launch { page.request.collect { request -> gateThenSend(page, request) } }
            launch {
                var shown: com.ardia.browser.FullscreenVideo? = null
                page.fullscreen.drop(1).collect { video ->
                    if (video != null) {
                        fullscreen.show(host?.get(), video)
                        shown = video
                    } else if (fullscreen.owns(shown)) {
                        fullscreen.hide("the page left fullscreen")
                    }
                    send(id, "page.fullscreen", "isFullscreen" to (video != null))
                }
            }
            launch { page.events.collect { event(page, it) } }
        }
        return true
    }

    private fun event(page: Page, event: PageEvent) {
        val id = page.id
        when (event) {
            is PageEvent.Visited -> send(id, "page.visited", "url" to event.url, "title" to event.title, "kind" to PagePayloads.visitKind(event.kind))
            is PageEvent.OpenWindow -> {
                val popupId = UUID.randomUUID().toString()
                popups[popupId] = event.popup
                send(
                    id,
                    "page.popup",
                    "popupId" to popupId,
                    "url" to event.popup.url,
                    "isUserGesture" to event.popup.isUserGesture,
                    "isPrivate" to event.popup.isPrivate,
                )
            }
            is PageEvent.Download -> {
                val download = event.download
                val downloadId = downloads.enqueue(download)
                send(
                    id,
                    "page.download",
                    "downloadId" to downloadId?.toString(),
                    "url" to download.url,
                    "fileName" to download.fileName,
                    "mimeType" to download.mimeType,
                    "contentLength" to download.contentLength.takeIf { it >= 0 }?.toDouble(),
                    "isPrivate" to download.isPrivate,
                )
            }
            is PageEvent.LongPress -> {
                val density = app.resources.displayMetrics.density
                send(id, "page.longPress", "target" to PagePayloads.pressTarget(event.target), "x" to (event.x / density).toDouble(), "y" to (event.y / density).toDouble())
            }
            PageEvent.CloseRequested -> send(id, "page.closeRequested")
            is PageEvent.ExternalAppMissing -> send(id, "page.externalAppMissing", "url" to event.url)
        }
    }

    private fun send(pageId: String, name: String, vararg fields: Pair<String, Any?>) {
        pageSink?.invoke(mapOf("name" to name, "pageId" to pageId, *fields))
    }

    private fun privateBrowsingEnded() {
        sitePreferences.endPrivateBrowsing()
        blocking.endPrivateBrowsing()
        snapshots.endPrivateBrowsing()
        popups.entries.removeAll { it.value.isPrivate }
        pageSink?.invoke(mapOf("name" to "pages.privateSessionEnded"))
    }

    private fun progress(progress: DownloadProgress): Map<String, Any?> = mapOf(
        "id" to progress.id.toString(),
        "fileName" to progress.fileName,
        "bytes" to progress.bytes.toDouble(),
        "total" to progress.total?.toDouble(),
        "fraction" to progress.fraction?.toDouble(),
        "isQueued" to progress.isQueued,
    )

    private fun finished(outcome: DownloadOutcome): Map<String, Any?> = when (outcome) {
        is DownloadOutcome.Finished -> mapOf("name" to "downloads.finished", "fileName" to outcome.fileName, "uri" to outcome.uri?.toString(), "failure" to null)
        is DownloadOutcome.Failed -> mapOf("name" to "downloads.finished", "fileName" to outcome.fileName, "uri" to null, "failure" to downloadFailure(outcome.reason))
    }

    private fun downloadFailure(failure: DownloadFailure): String = when (failure) {
        DownloadFailure.Network -> "network"
        DownloadFailure.Server -> "server"
        DownloadFailure.InsecureRedirect -> "insecureRedirect"
        DownloadFailure.TooManyRedirects -> "tooManyRedirects"
        DownloadFailure.Unsupported -> "unsupported"
        DownloadFailure.Storage -> "storage"
        DownloadFailure.NoSpace -> "noSpace"
        DownloadFailure.PrivateSessionEnded -> "privateSessionEnded"
    }

    private fun privatePagesUnavailable() =
        CodedException("ERR_PRIVATE_PAGES_UNAVAILABLE", "Private pages need a WebView with multi-profile support", null)

    private const val SITE_PREFERENCES = "ardia-site-preferences"
}
