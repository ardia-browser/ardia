package com.ardia.phone

import android.annotation.SuppressLint
import android.app.Activity
import android.app.ActivityManager
import android.content.ClipData
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapRegionDecoder
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.SystemClock
import android.provider.MediaStore
import android.util.Log
import android.view.Choreographer
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.ardia.browser.Page
import com.ardia.browser.PageCapture
import expo.modules.kotlin.exception.CodedException
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import kotlin.coroutines.cancellation.CancellationException
import kotlin.coroutines.resume
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

internal object LongScreenshots {
    private const val FOLDER = "long-screenshots"
    private const val SHOT = "shot.png"
    private const val SETTLE_MILLIS = 120L
    private const val WARM_DWELL_MILLIS = 300L
    private const val WARM_DEADLINE_MILLIS = 6_000L
    private const val WARM_PAINT_WAIT_MILLIS = 100L
    private const val VISUAL_STATE_WAIT_MILLIS = 500L
    private const val FRAME_WAIT_MILLIS = 100L
    private const val SCRIPT_WAIT_MILLIS = 2_000L
    private const val TILE_QUALITY = 88
    private const val ALBUM = "Ardia"

    private class Session(val id: String, val file: File, val width: Int, val height: Int) {
        @Volatile
        var saved: Uri? = null

        @Volatile
        var savedName: String? = null
    }

    private class Held(val web: WebView, val x: Int, val y: Int, val scrollBar: Boolean) {
        val key = "ardia-long-shot-${UUID.randomUUID()}"
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val slot = CaptureSlot<Map<String, Any?>>(scope)

    @Volatile
    private var current: Session? = null
    private var visualRequests = 0L
    private val UUID_NAME = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

    fun capturable(page: Page): Boolean = !page.isPrivate && PagePrinting.printable(page.state.value.url)

    suspend fun capture(context: Context, page: Page): Map<String, Any?> = withContext(Dispatchers.Main.immediate) {
        if (!capturable(page)) throw failure("Only web pages outside private tabs can be captured")
        val job = slot.start { run(context, page) }
        try {
            job.await()
        } catch (cancelled: CancellationException) {
            job.cancel()
            currentCoroutineContext().ensureActive()
            throw failure("The long screenshot was cancelled")
        } catch (replaced: ReplacedCapture) {
            throw failure("A newer long screenshot replaced this one")
        }
    }

    fun cancel(): Job? {
        lab { "cancelled" }
        return slot.cancel()
    }

    private suspend fun run(context: Context, page: Page): Map<String, Any?> {
        val web = PageDrawnWatch.webViewIn(page.view.value) ?: throw failure("The page has no web view")
        if (!PageCapture.isDrawable(web)) throw failure("The page isn't on screen")
        val started = SystemClock.uptimeMillis()
        val held = Held(web, web.scrollX, web.scrollY, web.isVerticalScrollBarEnabled)
        discardAll(context)
        var dropped = false
        var written: Written? = null
        var published = false
        try {
            if (evaluateNumber(web, script(MARK, held)) != 1) throw failure("The page didn't answer")
            val stitched = try {
                stitch(context, page, held)
            } finally {
                withContext(NonCancellable) { restore(held) }
            }
            val captured = SystemClock.uptimeMillis()
            val ready = try {
                write(context, stitched).also { written = it }
            } finally {
                stitched.bitmap.recycle()
            }
            val gate = evaluateNumber(web, script(DROP, held))
            dropped = true
            if (gate != 1) throw changed()
            current = ready.session
            published = true
            lab { "captured ${stitched.screens} screen(s)${if (stitched.complete) "" else ", stopped early,"} into ${ready.session.width}x${ready.session.height} at scale ${"%.3f".format(stitched.scale)} in ${captured - started} ms, written in ${SystemClock.uptimeMillis() - captured} ms (${(ready.result["tiles"] as List<*>).size} tile(s))" }
            return ready.result
        } catch (error: CodedException) {
            lab { "failed: ${error.message}" }
            throw error
        } catch (error: OutOfMemoryError) {
            lab { "failed: out of memory" }
            throw failure("Not enough memory for a long screenshot")
        } catch (error: java.io.IOException) {
            lab { "failed: ${error.javaClass.simpleName}" }
            throw failure("The screenshot couldn't be written")
        } finally {
            withContext(NonCancellable) {
                if (!dropped) evaluateNumber(web, script(DROP, held))
                val unpublished = written?.session?.takeIf { !published }
                if (unpublished != null) {
                    if (current?.id == unpublished.id) current = null
                    withContext(Dispatchers.IO) { unpublished.file.parentFile?.deleteRecursively() }
                    lab { "deleted the unpublished capture's files" }
                }
            }
        }
    }

    private class Written(val session: Session, val result: Map<String, Any?>)

    private class Stitched(val bitmap: Bitmap, val screens: Int, val scale: Double, val complete: Boolean)

    private class Seen(val pixels: IntArray, val height: Int, val scrolled: Int, val position: Int)

    private class Step(val shot: Bitmap, val pixels: IntArray, val scrolled: Int) {
        val height = shot.height
        val width = shot.width
        var shotLive = true
        var pixelsLive = true
    }

    private fun dropShot(step: Step, copies: LongScreenshotPlan.Copies) {
        if (!step.shotLive) return
        step.shotLive = false
        step.shot.recycle()
        copies.give()
    }

    private fun drop(step: Step?, copies: LongScreenshotPlan.Copies) {
        step ?: return
        dropShot(step, copies)
        if (!step.pixelsLive) return
        step.pixelsLive = false
        copies.give()
    }

    private fun keep(step: Step, position: Int, previous: Seen?, copies: LongScreenshotPlan.Copies): Seen {
        dropShot(step, copies)
        if (previous != null) copies.give()
        step.pixelsLive = false
        return Seen(step.pixels, step.height, step.scrolled, position)
    }

    private suspend fun stitch(context: Context, page: Page, held: Held): Stitched {
        val web = held.web
        val width = web.width
        val viewport = web.height
        web.isVerticalScrollBarEnabled = false
        warm(page, held, width, viewport)
        val reported = reportedHeight(web)
        val pageHeight = LongScreenshotPlan.pageHeight(reported, viewport)
        val capped = LongScreenshotPlan.capped(reported, viewport)
        val budget = LongScreenshotPlan.outputBudget(available(context), width, viewport) ?: throw failure("Not enough memory for a long screenshot")
        val output = LongScreenshotPlan.output(width, pageHeight, budget) ?: throw failure("The page has no size")
        val bitmap = try {
            Bitmap.createBitmap(output.width, output.height, Bitmap.Config.ARGB_8888)
        } catch (error: OutOfMemoryError) {
            throw failure("Not enough memory for a long screenshot")
        }
        try {
            val canvas = Canvas(bitmap)
            val paint = Paint(Paint.FILTER_BITMAP_FLAG)
            val stride = LongScreenshotPlan.stride(viewport)
            val maxSteps = LongScreenshotPlan.maxSteps(pageHeight, viewport)
            var filled = 0
            var steps = 0
            var target = 0
            var hidden = false
            var previous: Seen? = null
            val copies = LongScreenshotPlan.Copies()
            while (filled < pageHeight && steps < maxSteps) {
                steps += 1
                scrollOwned(page, held, width, target)
                val before = previous
                var step: Step? = settledStep(page, held, width, copies)
                try {
                    var current = step!!
                    var moved: Int? = 0
                    if (before != null) {
                        val scrollSaid = current.scrolled - before.scrolled
                        val expected = if (scrollSaid > 0) scrollSaid else stride
                        moved = match(before, current, expected)
                        if (LongScreenshotPlan.drawAgain(moved, scrollSaid)) {
                            drop(current, copies)
                            step = null
                            awaitPaint(web)
                            delay(SETTLE_MILLIS)
                            current = settledStep(page, held, width, copies)
                            step = current
                            moved = match(before, current, expected)
                        }
                        lab { "step $steps: scrolled ${before.scrolled} -> ${current.scrolled}, matched a move of ${moved ?: "nothing"} (scroll said $scrollSaid)" }
                        if (moved == null) break
                    }
                    val position = (before?.position ?: 0) + (moved ?: 0)
                    val slice = LongScreenshotPlan.slice(position, filled, current.height, pageHeight)
                    if (slice == null) break
                    canvas.drawBitmap(
                        current.shot,
                        Rect(0, slice.sourceTop, current.width, slice.sourceBottom),
                        Rect(0, LongScreenshotPlan.rowIn(output, slice.pageTop), output.width, LongScreenshotPlan.rowIn(output, slice.pageBottom)),
                        paint,
                    )
                    filled = slice.pageBottom
                    target = position + stride
                    previous = if (hidden) {
                        keep(current, position, before, copies)
                    } else {
                        hidden = true
                        if (evaluateNumber(web, script(HIDE_FIXED, held))?.let { it >= 0 } != true) throw changed()
                        drop(current, copies)
                        step = null
                        awaitPaint(web)
                        val again = settledStep(page, held, width, copies)
                        step = again
                        keep(again, position, before, copies)
                    }
                } finally {
                    drop(step, copies)
                }
            }
            if (previous != null) copies.give()
            lab { "peak working copies ${copies.peak} of ${LongScreenshotPlan.WORKING_COPIES} budgeted" }
            val ending = LongScreenshotPlan.ending(filled, pageHeight, viewport)
            lab { "ended ${ending.name.lowercase()}: $filled of $pageHeight rows${if (capped) ", the page goes on past the cap" else ""}" }
            if (ending == LongScreenshotPlan.Ending.Failed) throw failure("Only the first screen of this page lined up")
            val height = LongScreenshotPlan.rowIn(output, filled)
            if (height <= 0) throw failure("Nothing was captured")
            if (height < bitmap.height) bitmap.reconfigure(bitmap.width, height, Bitmap.Config.ARGB_8888)
            return Stitched(bitmap, LongScreenshotPlan.screens(filled, viewport), output.scale, ending == LongScreenshotPlan.Ending.Complete && !capped)
        } catch (error: Throwable) {
            bitmap.recycle()
            throw error
        }
    }

    private suspend fun settledStep(page: Page, held: Held, width: Int, copies: LongScreenshotPlan.Copies): Step {
        val web = held.web
        awaitPaint(web)
        delay(SETTLE_MILLIS)
        awaitPaint(web)
        ensureSameView(page, held, width)
        val scrolled = web.scrollY
        val shot = drawn(web) ?: throw failure("The page didn't draw")
        copies.take()
        val pixels = try {
            withContext(Dispatchers.Default) { PageCapture.pixels(shot) }
        } catch (error: Throwable) {
            shot.recycle()
            copies.give()
            if (error is OutOfMemoryError) throw failure("Not enough memory for a long screenshot")
            throw error
        }
        copies.take()
        return Step(shot, pixels, scrolled)
    }

    private suspend fun match(before: Seen, step: Step, expected: Int): Int? = withContext(Dispatchers.Default) {
        LongScreenshotPlan.offset(before.pixels, before.height, step.pixels, step.height, step.width, expected)
    }

    @Suppress("DEPRECATION")
    private fun reportedHeight(web: WebView): Double = web.contentHeight.toDouble() * web.scale

    private suspend fun warm(page: Page, held: Held, width: Int, viewport: Int) {
        val started = SystemClock.uptimeMillis()
        val stops = LongScreenshotPlan.warmStops(LongScreenshotPlan.pageHeight(reportedHeight(held.web), viewport), viewport)
        var reached = 0
        val finished = withTimeoutOrNull(WARM_DEADLINE_MILLIS) {
            for (stop in stops) {
                scrollOwned(page, held, width, stop)
                awaitPaint(held.web, WARM_PAINT_WAIT_MILLIS)
                reached += 1
            }
            if (stops.isNotEmpty()) delay(WARM_DWELL_MILLIS)
            true
        } ?: false
        scrollOwned(page, held, width, 0)
        delay(SETTLE_MILLIS)
        lab { "warmed $reached of ${stops.size} step(s) in ${SystemClock.uptimeMillis() - started} ms${if (finished) "" else ", stopped at the deadline"}" }
    }

    private suspend fun scrollOwned(page: Page, held: Held, width: Int, y: Int) {
        ensureSameView(page, held, width)
        val landed = evaluateNumber(held.web, script(SCROLL, held, y)) ?: throw changed()
        if (landed < 0) throw changed()
    }

    private suspend fun restore(held: Held) {
        val web = held.web
        web.isVerticalScrollBarEnabled = held.scrollBar
        val shown = evaluateNumber(web, script(SHOW_FIXED, held, held.y))
        if (shown == null || shown < 0) {
            lab { "the page changed: its scroll is left alone" }
            return
        }
        lab { "restored the styles and the scroll to ${held.y}" }
    }

    @Suppress("DEPRECATION")
    private fun cssPixels(web: WebView, y: Int): String = LongScreenshotPlan.cssPixels(y, web.scale.toDouble())

    private fun script(source: String, held: Held, y: Int? = null): String =
        source.replace(KEY_PLACEHOLDER, held.key).replace(SCROLL_PLACEHOLDER, y?.let { cssPixels(held.web, it) } ?: "null")

    private fun changed() = failure("The page changed while it was captured")

    private suspend fun write(context: Context, stitched: Stitched): Written {
        val bitmap = stitched.bitmap
        val id = UUID.randomUUID().toString()
        val folder = File(File(context.cacheDir, FOLDER), id)
        if (!folder.mkdirs() && !folder.isDirectory) throw java.io.IOException("no folder")
        val file = File(folder, SHOT)
        try {
            val tiles = coroutineScope {
                val png = async(Dispatchers.Default) {
                    file.outputStream().buffered().use { out -> if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)) throw java.io.IOException("png") }
                }
                val pieces = async(Dispatchers.Default) {
                    LongScreenshotPlan.tiles(bitmap.height).mapIndexed { index, rows ->
                        val tile = File(folder, "tile-$index.jpg")
                        val piece = Bitmap.createBitmap(bitmap, 0, rows.first, bitmap.width, rows.last - rows.first + 1)
                        try {
                            tile.outputStream().buffered().use { out -> if (!piece.compress(Bitmap.CompressFormat.JPEG, TILE_QUALITY, out)) throw java.io.IOException("jpeg") }
                        } finally {
                            if (piece !== bitmap) piece.recycle()
                        }
                        mapOf("uri" to Uri.fromFile(tile).toString(), "top" to rows.first.toDouble(), "height" to (rows.last - rows.first + 1).toDouble())
                    }
                }
                awaitAll(png, pieces)
                pieces.await()
            }
            currentCoroutineContext().ensureActive()
            return Written(Session(id, file, bitmap.width, bitmap.height), mapOf(
                "id" to id,
                "uri" to Uri.fromFile(file).toString(),
                "path" to file.absolutePath,
                "width" to bitmap.width.toDouble(),
                "height" to bitmap.height.toDouble(),
                "screens" to stitched.screens.toDouble(),
                "complete" to stitched.complete,
                "tiles" to tiles,
            ))
        } catch (error: Throwable) {
            withContext(NonCancellable + Dispatchers.IO) { folder.deleteRecursively() }
            throw error
        }
    }

    suspend fun save(context: Context, id: String, top: Double, bottom: Double): Map<String, Any?> = withContext(Dispatchers.IO) {
        val session = current?.takeIf { it.id == id && it.file.isFile } ?: throw failure("The screenshot is gone")
        val crop = LongScreenshotPlan.crop(session.height, top, bottom) ?: throw failure("The crop is outside the screenshot")
        val resolver = context.contentResolver
        val name = "Ardia ${SimpleDateFormat("yyyy-MM-dd 'at' HH.mm.ss", Locale.US).format(Date())}.png"
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, name)
            put(MediaStore.Images.Media.MIME_TYPE, "image/png")
            put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/$ALBUM")
            put(MediaStore.Images.Media.WIDTH, session.width)
            put(MediaStore.Images.Media.HEIGHT, crop.bottom - crop.top)
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values) ?: throw failure("Pictures can't be written")
        try {
            val out = resolver.openOutputStream(uri) ?: throw java.io.IOException("no stream")
            out.buffered().use { stream ->
                if (crop.top == 0 && crop.bottom == session.height) {
                    session.file.inputStream().use { it.copyTo(stream) }
                } else {
                    val region = decodeRegion(session, crop)
                    try {
                        if (!region.compress(Bitmap.CompressFormat.PNG, 100, stream)) throw java.io.IOException("png")
                    } finally {
                        region.recycle()
                    }
                }
            }
            val published = resolver.update(uri, ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }, null, null)
            if (published < 1) throw java.io.IOException("the picture was never published")
            session.saved = uri
            session.savedName = name
            lab { "saved ${session.width}x${crop.bottom - crop.top} (rows ${crop.top}-${crop.bottom} of ${session.height})" }
            mapOf("uri" to uri.toString(), "width" to session.width.toDouble(), "height" to (crop.bottom - crop.top).toDouble())
        } catch (error: Throwable) {
            runCatching { resolver.delete(uri, null, null) }
            lab { "save failed: ${error.javaClass.simpleName}" }
            if (error is CodedException) throw error
            throw failure("The screenshot couldn't be saved")
        }
    }

    private fun decodeRegion(session: Session, crop: LongScreenshotPlan.Crop): Bitmap {
        val decoder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            BitmapRegionDecoder.newInstance(session.file.absolutePath)
        } else {
            @Suppress("DEPRECATION")
            BitmapRegionDecoder.newInstance(session.file.absolutePath, false)
        } ?: throw java.io.IOException("no decoder")
        try {
            val options = android.graphics.BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.ARGB_8888 }
            return decoder.decodeRegion(Rect(0, crop.top, session.width, crop.bottom), options) ?: throw java.io.IOException("no region")
        } finally {
            decoder.recycle()
        }
    }

    fun share(activity: Activity, uri: String): Boolean {
        val saved = current?.saved ?: return false
        if (saved.toString() != uri) return false
        val name = current?.savedName
        val send = Intent(Intent.ACTION_SEND)
            .setType("image/png")
            .putExtra(Intent.EXTRA_STREAM, saved)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        if (name != null) send.putExtra(Intent.EXTRA_TITLE, name)
        send.clipData = ClipData.newUri(activity.contentResolver, name ?: ALBUM, saved)
        return runCatching { activity.startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)) }.isSuccess
    }

    fun discard(context: Context, id: String) {
        if (!UUID_NAME.matches(id)) return
        if (current?.id == id) current = null
        File(File(context.cacheDir, FOLDER), id).deleteRecursively()
    }

    private fun discardAll(context: Context) {
        current = null
        File(context.cacheDir, FOLDER).deleteRecursively()
    }

    private fun ensureSameView(page: Page, held: Held, width: Int) {
        val web = held.web
        if (PageDrawnWatch.webViewIn(page.view.value) !== web || !web.isAttachedToWindow || web.width != width || web.height <= 0) throw changed()
    }

    private suspend fun drawn(web: WebView): Bitmap? {
        val region = Rect(0, 0, web.width, web.height)
        currentCoroutineContext().ensureActive()
        val first = PageCapture.drawView(web, region, web.width, web.height)
        if (!PageCapture.isBlank(first, blackIsBlank = true)) return first
        first.recycle()
        awaitPaint(web)
        val second = PageCapture.drawView(web, region, web.width, web.height)
        if (!PageCapture.isBlank(second, blackIsBlank = false)) return second
        second.recycle()
        return null
    }

    @SuppressLint("RequiresFeature")
    private suspend fun awaitPaint(web: WebView, wait: Long = VISUAL_STATE_WAIT_MILLIS) {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.VISUAL_STATE_CALLBACK)) {
            withTimeoutOrNull(wait) {
                suspendCancellableCoroutine { continuation ->
                    WebViewCompat.postVisualStateCallback(web, visualRequests++) { if (continuation.isActive) continuation.resume(Unit) }
                }
            }
        }
        awaitFrame()
    }

    private suspend fun awaitFrame() {
        withTimeoutOrNull(FRAME_WAIT_MILLIS) {
            suspendCancellableCoroutine { continuation ->
                val callback = Choreographer.FrameCallback { if (continuation.isActive) continuation.resume(Unit) }
                Choreographer.getInstance().postFrameCallback(callback)
                continuation.invokeOnCancellation { Choreographer.getInstance().removeFrameCallback(callback) }
            }
        }
    }

    private suspend fun evaluateNumber(web: WebView, script: String): Int? = withTimeoutOrNull(SCRIPT_WAIT_MILLIS) {
        suspendCancellableCoroutine { continuation ->
            web.evaluateJavascript(script) { result -> if (continuation.isActive) continuation.resume(result?.toIntOrNull()) }
        }
    }

    private fun available(context: Context): Long {
        val manager = context.getSystemService(ActivityManager::class.java) ?: return LongScreenshotPlan.MIN_BUDGET_BYTES * 8
        return ActivityManager.MemoryInfo().also(manager::getMemoryInfo).availMem
    }

    private fun failure(reason: String) = CodedException("ERR_LONG_SCREENSHOT", reason, null)

    private inline fun lab(line: () -> String) {
        if (PhoneLab.isOn) Log.i("PAGELAB", "PAGELAB long screenshot ${line()}")
    }

    private const val KEY_PLACEHOLDER = "ARDIA_CAPTURE_KEY"

    private const val SCROLL_PLACEHOLDER = "ARDIA_SCROLL_Y"

    private const val MARK = """(function(k){var t=Symbol.for(k);if(Object.prototype.hasOwnProperty.call(window,t))return 0;Object.defineProperty(window,t,{value:{list:[]},configurable:true,enumerable:false,writable:false});return 1;})('ARDIA_CAPTURE_KEY')"""

    private const val HIDE_FIXED = """(function(k){var t=Symbol.for(k);if(!Object.prototype.hasOwnProperty.call(window,t))return -1;var list=window[t].list;var all=document.querySelectorAll('body *');for(var i=0;i<all.length;i++){var e=all[i],p=getComputedStyle(e).position;if(p!=='fixed'&&p!=='sticky')continue;list.push([e,e.getAttribute('style')]);e.style.setProperty('transition','none','important');if(p==='fixed'){e.style.setProperty('opacity','0','important');}else{e.style.setProperty('position','relative','important');e.style.setProperty('inset','auto','important');}}return list.length;})('ARDIA_CAPTURE_KEY')"""

    private const val SCROLL = """(function(k,y){var t=Symbol.for(k);if(!Object.prototype.hasOwnProperty.call(window,t))return -1;var se=document.scrollingElement||document.documentElement,a=se.getAttribute('style');se.style.setProperty('scroll-behavior','auto','important');se.scrollTop=y;if(a===null)se.removeAttribute('style');else se.setAttribute('style',a);return Math.round(se.scrollTop);})('ARDIA_CAPTURE_KEY',ARDIA_SCROLL_Y)"""

    private const val SHOW_FIXED = """(function(k,y){var t=Symbol.for(k);if(!Object.prototype.hasOwnProperty.call(window,t))return -1;var list=window[t].list,n=list.length;for(var i=0;i<n;i++){var e=list[i][0],v=list[i][1];if(v===null)e.removeAttribute('style');else e.setAttribute('style',v);}list.length=0;if(y!==null){var se=document.scrollingElement||document.documentElement,a=se.getAttribute('style');se.style.setProperty('scroll-behavior','auto','important');se.scrollTop=y;if(a===null)se.removeAttribute('style');else se.setAttribute('style',a);}return n;})('ARDIA_CAPTURE_KEY',ARDIA_SCROLL_Y)"""

    private const val DROP = """(function(k){var t=Symbol.for(k);if(!Object.prototype.hasOwnProperty.call(window,t))return 0;delete window[t];return 1;})('ARDIA_CAPTURE_KEY')"""
}
