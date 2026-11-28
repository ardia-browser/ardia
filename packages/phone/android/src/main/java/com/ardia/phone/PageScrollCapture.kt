package com.ardia.phone

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.graphics.HardwareRenderer
import android.graphics.Rect
import android.graphics.RenderNode
import android.os.Build
import android.os.CancellationSignal
import android.os.SystemClock
import android.util.Log
import android.view.Choreographer
import android.view.ScrollCaptureSession
import android.view.Surface
import android.webkit.WebView
import androidx.annotation.RequiresApi
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.ardia.browser.PageCapture
import java.util.function.Consumer
import kotlin.coroutines.cancellation.CancellationException
import kotlin.coroutines.resume
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

@RequiresApi(Build.VERSION_CODES.S)
internal class PageScrollCapture(private val host: Host) {
    interface Host {
        fun capturableWebView(): WebView?

        fun scrollBounds(): Rect
    }

    enum class Outcome(val wire: String) { Started("started"), Complete("complete"), Cancelled("cancelled"), Failed("failed") }

    private class Session(val web: WebView, val key: String, val start: Int, val viewport: Int, val scrollBar: Boolean, val startedAt: Long) {
        val node = RenderNode("ardiaScrollCapture")
        private var renderer: HardwareRenderer? = null
        private var surface: Surface? = null
        var marked = false
        var fixedHidden = false
        var cut = false
        var failed = false
        var tiles = 0
        var lastArea: Rect? = null
        var lastShot: Bitmap? = null
        var lastAnswer: Rect? = null

        fun forget() {
            lastShot?.recycle()
            lastShot = null
            lastArea = null
            lastAnswer = null
        }

        fun rendererFor(target: Surface): HardwareRenderer {
            val current = renderer
            if (current != null && surface === target) return current
            current?.destroy()
            return HardwareRenderer().also {
                it.setContentRoot(node)
                it.setSurface(target)
                renderer = it
                surface = target
            }
        }

        fun release() {
            forget()
            renderer?.destroy()
            renderer = null
            surface = null
            node.discardDisplayList()
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val turns = Mutex()
    private var session: Session? = null

    fun search(signal: CancellationSignal?, onReady: Consumer<Rect>?) {
        onReady ?: return
        val web = host.capturableWebView()
        val bounds = host.scrollBounds()
        if (web == null || bounds.isEmpty) {
            onReady.accept(Rect())
            return
        }
        val job = scope.launch {
            val zoomed = evaluateNumber(web, PageScrollScripts.ZOOMED, SEARCH_WAIT_MILLIS)
            val offered = zoomed == 0 && host.capturableWebView() === web
            lab { if (offered) "offered ${bounds.width()}x${bounds.height()}" else "refused: ${if (zoomed == null) "the page didn't answer" else if (zoomed != 0) "pinch-zoomed" else "the page changed"}" }
            onReady.accept(if (offered) Rect(bounds) else Rect())
        }
        signal?.setOnCancelListener { job.cancel() }
    }

    fun start(signal: CancellationSignal?, onReady: Runnable?) {
        val job = scope.launch {
            turns.withLock {
                finish()
                session = host.capturableWebView()?.let { begin(it) }
            }
            onReady?.run()
        }
        signal?.setOnCancelListener {
            job.cancel()
            scope.launch { withContext(NonCancellable) { turns.withLock { finish() } } }
        }
    }

    fun request(captureSession: ScrollCaptureSession?, signal: CancellationSignal?, captureArea: Rect?, onComplete: Consumer<Rect>?) {
        onComplete ?: return
        val width = captureSession?.scrollBounds?.width()
        if (captureSession == null || captureArea == null || width == null) {
            lab { "tile refused: the system sent no ${if (captureSession == null) "session" else if (captureArea == null) "area" else "scroll bounds"}" }
            onComplete.accept(Rect())
            return
        }
        val area = Rect(captureArea)
        val job = scope.launch {
            val captured = try {
                turns.withLock { tile(captureSession, width, area) }
            } catch (cancelled: CancellationException) {
                session?.cut = true
                throw cancelled
            }
            onComplete.accept(captured)
        }
        signal?.setOnCancelListener { job.cancel() }
    }

    fun end(onReady: Runnable?) {
        scope.launch {
            withContext(NonCancellable) { turns.withLock { finish() } }
            onReady?.run()
        }
    }

    private suspend fun begin(web: WebView): Session? {
        val begun = Session(web, PageScrollScripts.newKey(), web.scrollY, web.height, web.isVerticalScrollBarEnabled, SystemClock.uptimeMillis())
        when (evaluateNumber(web, PageScrollScripts.script(PageScrollScripts.MARK, begun.key))) {
            1 -> begun.marked = true
            2 -> {
                lab { "refused at start: pinch-zoomed" }
                return null
            }
            else -> {
                lab { "refused at start: the page didn't answer" }
                return null
            }
        }
        web.isVerticalScrollBarEnabled = false
        report(Outcome.Started)
        lab { "started at ${begun.start} in a ${web.width}x${begun.viewport} viewport" }
        return begun
    }

    private suspend fun tile(captureSession: ScrollCaptureSession, width: Int, area: Rect): Rect {
        val current = session ?: return Rect()
        if (current.failed) return Rect()
        val web = current.web
        if (!web.isAttachedToWindow || web.width != width || web.height != current.viewport) return failed(current, "the page view changed")
        val repeated = current.lastShot
        val repeatedAnswer = current.lastAnswer
        if (repeated != null && repeatedAnswer != null && current.lastArea == area) {
            if (!present(current, captureSession, width, repeated)) return failed(current, "the capture surface is gone")
            lab { "tile ${area.top}..${area.bottom}: asked again, presented the same rows" }
            return Rect(repeatedAnswer)
        }
        current.forget()
        val pageHeight = ScrollCapturePlan.pageHeight(reportedHeight(web), current.viewport)
        val wantsFixed = ScrollCapturePlan.withinStart(area.top, area.bottom, current.viewport)
        val restyled = wantsFixed == current.fixedHidden
        if (restyled) {
            val source = if (wantsFixed) PageScrollScripts.SHOW_FIXED else PageScrollScripts.HIDE_FIXED
            val changed = evaluateNumber(web, PageScrollScripts.script(source, current.key)) ?: return failed(current, "the page didn't answer")
            if (changed < 0) return failed(current, "the page changed")
            current.fixedHidden = !wantsFixed
        }
        val target = ScrollCapturePlan.scrollFor(current.start, area.top, area.bottom, current.viewport, pageHeight)
        val scale = scaleOf(web)
        val moves = web.scrollY != target
        val scriptLanded = evaluateNumber(web, PageScrollScripts.script(PageScrollScripts.SCROLL, current.key, ScrollCapturePlan.cssPixels(target, scale))) ?: return failed(current, "the page didn't answer")
        if (scriptLanded < 0) return failed(current, "the page changed")
        if (moves || restyled) awaitPaint(web)
        if (!ScrollCapturePlan.landedWhereAsked(scriptLanded, scale, web.scrollY)) {
            awaitPaint(web)
            lab { "scroll settled late: the page said ${scriptLanded}css, the view ${web.scrollY}px" }
        }
        val landed = web.scrollY
        val planned = ScrollCapturePlan.tile(current.start, area.top, area.bottom, landed, current.viewport, pageHeight)
        if (planned == null) {
            lab { "tile ${area.top}..${area.bottom}: outside the page (height $pageHeight)" }
            return Rect()
        }
        val shot = drawn(web, Rect(0, planned.sourceTop, web.width, planned.sourceTop + planned.rows)) ?: return failed(current, "the page didn't draw")
        currentCoroutineContext().ensureActive()
        if (!present(current, captureSession, width, shot)) {
            shot.recycle()
            return failed(current, "the capture surface is gone")
        }
        val answer = Rect(area.left, planned.top, area.right, planned.bottom)
        current.lastArea = Rect(area)
        current.lastShot = shot
        current.lastAnswer = answer
        current.tiles += 1
        lab { "tile ${area.top}..${area.bottom}: drew ${planned.top}..${planned.bottom} from scroll $landed${if (wantsFixed) " with fixed elements" else ""}" }
        return Rect(answer)
    }

    private fun present(current: Session, captureSession: ScrollCaptureSession, width: Int, shot: Bitmap): Boolean {
        val surface: Surface = captureSession.surface ?: return false
        return try {
            val node = current.node
            node.setPosition(0, 0, width, shot.height)
            val canvas = node.beginRecording(width, shot.height)
            try {
                canvas.drawBitmap(shot, null, Rect(0, 0, width, shot.height), null)
            } finally {
                node.endRecording()
            }
            current.rendererFor(surface).createRenderRequest().setWaitForPresent(true).syncAndDraw()
            true
        } catch (gone: IllegalStateException) {
            false
        } catch (gone: IllegalArgumentException) {
            false
        }
    }

    private fun failed(current: Session, reason: String): Rect {
        current.failed = true
        lab { "failed: $reason" }
        return Rect()
    }

    private suspend fun finish() {
        val ended = session ?: return
        session = null
        ended.release()
        val web = ended.web
        web.isVerticalScrollBarEnabled = ended.scrollBar
        val restored = evaluateNumber(web, PageScrollScripts.script(PageScrollScripts.SHOW_FIXED, ended.key, ScrollCapturePlan.cssPixels(ended.start, scaleOf(web))))
        evaluateNumber(web, PageScrollScripts.script(PageScrollScripts.DROP, ended.key))
        val outcome = when {
            ended.failed || restored == null || restored < 0 -> Outcome.Failed
            ended.cut -> Outcome.Cancelled
            else -> Outcome.Complete
        }
        report(outcome)
        lab { "ended ${outcome.wire} after ${ended.tiles} tile(s) in ${SystemClock.uptimeMillis() - ended.startedAt} ms; ${if (restored != null && restored >= 0) "restored the styles and the scroll to ${ended.start}" else "the page changed, so its scroll is left alone"}" }
    }

    private fun report(outcome: Outcome) {
        PhonePages.pageSink?.invoke(mapOf("name" to EVENT, "outcome" to outcome.wire))
    }

    @Suppress("DEPRECATION")
    private fun scaleOf(web: WebView): Double = web.scale.toDouble()

    @Suppress("DEPRECATION")
    private fun reportedHeight(web: WebView): Double = web.contentHeight.toDouble() * web.scale

    private suspend fun drawn(web: WebView, region: Rect): Bitmap? {
        val first = PageCapture.drawView(web, region, region.width(), region.height())
        if (!PageCapture.isBlank(first, blackIsBlank = true)) return first
        first.recycle()
        awaitPaint(web)
        val second = PageCapture.drawView(web, region, region.width(), region.height())
        if (!PageCapture.isBlank(second, blackIsBlank = false)) return second
        second.recycle()
        return null
    }

    @SuppressLint("RequiresFeature")
    private suspend fun awaitPaint(web: WebView) {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.VISUAL_STATE_CALLBACK)) {
            withTimeoutOrNull(VISUAL_STATE_WAIT_MILLIS) {
                suspendCancellableCoroutine { continuation ->
                    WebViewCompat.postVisualStateCallback(web, visualRequests++) { if (continuation.isActive) continuation.resume(Unit) }
                }
            }
        }
        withTimeoutOrNull(FRAME_WAIT_MILLIS) {
            suspendCancellableCoroutine { continuation ->
                val callback = Choreographer.FrameCallback { if (continuation.isActive) continuation.resume(Unit) }
                Choreographer.getInstance().postFrameCallback(callback)
                continuation.invokeOnCancellation { Choreographer.getInstance().removeFrameCallback(callback) }
            }
        }
    }

    private suspend fun evaluateNumber(web: WebView, script: String, wait: Long = SCRIPT_WAIT_MILLIS): Int? = withTimeoutOrNull(wait) {
        suspendCancellableCoroutine { continuation ->
            web.evaluateJavascript(script) { result -> if (continuation.isActive) continuation.resume(result?.toIntOrNull()) }
        }
    }

    private inline fun lab(line: () -> String) {
        if (PhoneLab.isOn) Log.i("PAGELAB", "PAGELAB scroll capture ${line()}")
    }

    companion object {
        const val EVENT = "pages.scrollCapture"
        private const val VISUAL_STATE_WAIT_MILLIS = 500L
        private const val FRAME_WAIT_MILLIS = 100L
        private const val SCRIPT_WAIT_MILLIS = 2_000L
        private const val SEARCH_WAIT_MILLIS = 400L
        private var visualRequests = 0L
    }
}
