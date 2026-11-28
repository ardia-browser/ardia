package com.ardia.phone

import android.graphics.Bitmap
import android.graphics.HardwareRenderer
import android.graphics.Rect
import android.graphics.RenderNode
import android.os.Build
import android.os.CancellationSignal
import android.os.SystemClock
import android.util.Log
import android.view.ScrollCaptureSession
import android.view.Surface
import androidx.annotation.RequiresApi
import java.util.function.Consumer
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

internal interface CapturePage {
    val width: Int
    val height: Int
    val scrollY: Int
    val attached: Boolean
    val scale: Double
    val documentHeight: Double
    var scrollBarShown: Boolean

    suspend fun evaluate(script: String, waitMillis: Long): Int?

    suspend fun awaitPaint()

    suspend fun draw(region: Rect): Bitmap?
}

internal fun interface TileSurface {
    fun present(shot: Bitmap, width: Int): Int?
}

@RequiresApi(Build.VERSION_CODES.S)
internal class PageScrollCapture(private val host: Host, private val idleLimitMillis: Long = IDLE_LIMIT_MILLIS) {
    interface Host {
        fun capturablePage(): CapturePage?

        fun scrollBounds(): Rect
    }

    enum class Outcome(val wire: String) { Started("started"), Complete("complete"), Cancelled("cancelled"), Failed("failed") }

    private class Rendered {
        val node = RenderNode("ardiaScrollCapture")
        private var renderer: HardwareRenderer? = null
        private var surface: Surface? = null

        fun present(target: Surface?, shot: Bitmap, width: Int): Int? {
            target ?: return null
            return try {
                node.setPosition(0, 0, width, shot.height)
                val canvas = node.beginRecording(width, shot.height)
                try {
                    canvas.drawBitmap(shot, null, Rect(0, 0, width, shot.height), null)
                } finally {
                    node.endRecording()
                }
                rendererFor(target).createRenderRequest().setWaitForPresent(true).syncAndDraw()
            } catch (gone: IllegalStateException) {
                null
            } catch (gone: IllegalArgumentException) {
                null
            }
        }

        private fun rendererFor(target: Surface): HardwareRenderer {
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
            renderer?.destroy()
            renderer = null
            surface = null
            node.discardDisplayList()
        }
    }

    private class Session(val page: CapturePage, val key: String, val start: Int, val viewport: Int, val scrollBar: Boolean, val startedAt: Long) {
        val rendered by lazy { Rendered() }
        private var renders = false
        var fixedHidden = false
        var cut = false
        var failed = false
        var tiles = 0
        var lastArea: Rect? = null
        var lastShot: Bitmap? = null
        var lastAnswer: Rect? = null

        fun present(target: Surface?, shot: Bitmap, width: Int): Int? {
            renders = true
            return rendered.present(target, shot, width)
        }

        fun forget() {
            lastShot?.recycle()
            lastShot = null
            lastArea = null
            lastAnswer = null
        }

        fun release() {
            forget()
            if (renders) rendered.release()
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val turns = Mutex()
    private var session: Session? = null
    private var activity = 0L
    private var watchdog: Job? = null

    fun search(signal: CancellationSignal?, onReady: Consumer<Rect>?) {
        onReady ?: return
        val page = host.capturablePage()
        val bounds = host.scrollBounds()
        if (page == null || bounds.isEmpty) {
            onReady.accept(Rect())
            return
        }
        val job = scope.launch {
            val zoomed = page.evaluate(PageScrollScripts.ZOOMED, SEARCH_WAIT_MILLIS)
            val offered = zoomed == 0 && host.capturablePage() == page
            lab { if (offered) "offered ${bounds.width()}x${bounds.height()}" else "refused: ${if (zoomed == null) "the page didn't answer" else if (zoomed != 0) "pinch-zoomed" else "the page changed"}" }
            onReady.accept(if (offered) Rect(bounds) else Rect())
        }
        signal?.setOnCancelListener { job.cancel() }
    }

    fun start(signal: CancellationSignal?, onReady: Runnable?) {
        val job = scope.launch {
            open()
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
                tile(width, area) { shot, wide -> session?.present(captureSession.surface, shot, wide) }
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
            close()
            onReady?.run()
        }
    }

    internal suspend fun open() {
        turns.withLock {
            finish()
            session = host.capturablePage()?.let { begin(it) }
        }
        watch()
    }

    internal suspend fun close() {
        withContext(NonCancellable) { turns.withLock { finish() } }
    }

    internal suspend fun tile(width: Int, area: Rect, surface: TileSurface): Rect {
        activity += 1
        try {
            return turns.withLock { tileLocked(width, area, surface) }
        } finally {
            watch()
        }
    }

    private fun watch() {
        watchdog?.cancel()
        val watched = session ?: return
        val seen = ++activity
        watchdog = scope.launch {
            delay(idleLimitMillis)
            turns.withLock {
                if (session !== watched || activity != seen) return@withLock
                watched.cut = true
                lab { "the system went quiet for $idleLimitMillis ms without ending the session; ending it here" }
                finish()
            }
        }
    }

    private suspend fun begin(page: CapturePage): Session? {
        val begun = Session(page, PageScrollScripts.newKey(), page.scrollY, page.height, page.scrollBarShown, SystemClock.uptimeMillis())
        when (page.evaluate(PageScrollScripts.script(PageScrollScripts.MARK, begun.key), SCRIPT_WAIT_MILLIS)) {
            1 -> Unit
            2 -> {
                lab { "refused at start: pinch-zoomed" }
                return null
            }
            else -> {
                lab { "refused at start: the page didn't answer" }
                return null
            }
        }
        page.scrollBarShown = false
        report(Outcome.Started)
        lab { "started at ${begun.start} in a ${page.width}x${begun.viewport} viewport" }
        return begun
    }

    private suspend fun tileLocked(width: Int, area: Rect, surface: TileSurface): Rect {
        val current = session ?: return Rect()
        if (current.failed) return Rect()
        val page = current.page
        if (!page.attached || page.width != width || page.height != current.viewport) return abandon(current, "the page view changed")
        val repeated = current.lastShot
        val repeatedAnswer = current.lastAnswer
        if (repeated != null && repeatedAnswer != null && current.lastArea == area) {
            if (!publishable(current)) return abandon(current, "the page changed or stopped being capturable")
            if (!presented(surface, repeated, width)) return abandon(current, "the tile never reached the capture surface")
            lab { "tile ${area.top}..${area.bottom}: asked again, presented the same rows" }
            return Rect(repeatedAnswer)
        }
        current.forget()
        val key = current.key
        val pageHeight = ScrollCapturePlan.pageHeight(page.documentHeight, current.viewport)
        val wantsFixed = ScrollCapturePlan.withinStart(area.top, area.bottom, current.viewport)
        val restyled = wantsFixed == current.fixedHidden
        if (restyled) {
            val source = if (wantsFixed) PageScrollScripts.SHOW_FIXED else PageScrollScripts.HIDE_FIXED
            val changed = page.evaluate(PageScrollScripts.script(source, key), SCRIPT_WAIT_MILLIS) ?: return abandon(current, "the page didn't answer")
            if (changed < 0) return abandon(current, "the page changed")
            current.fixedHidden = !wantsFixed
        }
        val target = ScrollCapturePlan.scrollFor(current.start, area.top, area.bottom, current.viewport, pageHeight)
        val scale = page.scale
        val moves = page.scrollY != target
        val scriptLanded = page.evaluate(PageScrollScripts.script(PageScrollScripts.SCROLL, key, ScrollCapturePlan.cssPixels(target, scale)), SCRIPT_WAIT_MILLIS) ?: return abandon(current, "the page didn't answer")
        if (scriptLanded < 0) return abandon(current, "the page changed")
        if (moves || restyled) page.awaitPaint()
        if (!ScrollCapturePlan.landedWhereAsked(scriptLanded, scale, page.scrollY)) {
            page.awaitPaint()
            lab { "scroll settled late: the page said ${scriptLanded}css, the view ${page.scrollY}px" }
        }
        val landed = page.scrollY
        val planned = ScrollCapturePlan.tile(current.start, area.top, area.bottom, landed, current.viewport, pageHeight)
        if (planned == null) {
            lab { "tile ${area.top}..${area.bottom}: outside the page (height $pageHeight)" }
            return Rect()
        }
        val shot = page.draw(Rect(0, planned.sourceTop, page.width, planned.sourceTop + planned.rows)) ?: return abandon(current, "the page didn't draw")
        try {
            currentCoroutineContext().ensureActive()
            if (!publishable(current)) {
                shot.recycle()
                return abandon(current, "the page changed or stopped being capturable")
            }
        } catch (cancelled: CancellationException) {
            shot.recycle()
            throw cancelled
        }
        if (!presented(surface, shot, width)) {
            shot.recycle()
            return abandon(current, "the tile never reached the capture surface")
        }
        val answer = Rect(area.left, planned.top, area.right, planned.bottom)
        current.lastArea = Rect(area)
        current.lastShot = shot
        current.lastAnswer = answer
        current.tiles += 1
        lab { "tile ${area.top}..${area.bottom}: drew ${planned.top}..${planned.bottom} from scroll $landed${if (wantsFixed) " with fixed elements" else ""}" }
        return Rect(answer)
    }

    private suspend fun publishable(current: Session): Boolean =
        host.capturablePage() == current.page && current.page.evaluate(PageScrollScripts.script(PageScrollScripts.OWNS, current.key), SCRIPT_WAIT_MILLIS) == 1

    private fun presented(surface: TileSurface, shot: Bitmap, width: Int): Boolean {
        val first = surface.present(shot, width)
        if (ScrollCapturePlan.presented(first)) return true
        lab { "a tile frame wasn't presented (sync result $first); presenting it again" }
        val second = surface.present(shot, width)
        if (ScrollCapturePlan.presented(second)) return true
        lab { "a tile frame wasn't presented again (sync result $second)" }
        return false
    }

    private suspend fun abandon(current: Session, reason: String): Rect {
        current.failed = true
        lab { "failed: $reason" }
        if (session === current) finish()
        return Rect()
    }

    private suspend fun finish() {
        val ended = session ?: return
        session = null
        watchdog?.takeIf { it !== currentCoroutineContext()[Job] }?.cancel()
        ended.release()
        val page = ended.page
        page.scrollBarShown = ended.scrollBar
        val restored = page.evaluate(PageScrollScripts.script(PageScrollScripts.SHOW_FIXED, ended.key, ScrollCapturePlan.cssPixels(ended.start, page.scale)), SCRIPT_WAIT_MILLIS)
        page.evaluate(PageScrollScripts.script(PageScrollScripts.DROP, ended.key), SCRIPT_WAIT_MILLIS)
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

    private inline fun lab(line: () -> String) {
        if (PhoneLab.isOn) Log.i("PAGELAB", "PAGELAB scroll capture ${line()}")
    }

    companion object {
        const val EVENT = "pages.scrollCapture"
        const val SCRIPT_WAIT_MILLIS = 2_000L
        private const val SEARCH_WAIT_MILLIS = 400L
        const val IDLE_LIMIT_MILLIS = 3_000L
    }
}
