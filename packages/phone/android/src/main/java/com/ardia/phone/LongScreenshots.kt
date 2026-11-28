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
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

internal object LongScreenshots {
    private const val FOLDER = "long-screenshots"
    private const val SHOT = "shot.png"
    private const val SETTLE_MILLIS = 120L
    private const val WARM_MILLIS = 80L
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

    private class Held(val web: WebView, val x: Int, val y: Int, val scrollBar: Boolean, val document: CaptureDocument) {
        val key = "ardia-long-shot-${UUID.randomUUID()}"
        var hidden = false
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var running: Deferred<Map<String, Any?>>? = null

    @Volatile
    private var current: Session? = null
    private var visualRequests = 0L
    private val UUID_NAME = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

    fun capturable(page: Page): Boolean = !page.isPrivate && PagePrinting.printable(page.state.value.url)

    suspend fun capture(context: Context, page: Page): Map<String, Any?> = withContext(Dispatchers.Main.immediate) {
        running?.let { previous ->
            if (previous.isActive) throw failure("A long screenshot is already being taken")
            previous.join()
        }
        if (!capturable(page)) throw failure("Only web pages outside private tabs can be captured")
        val job = scope.async { run(context, page) }
        running = job
        job.invokeOnCompletion { scope.launch { if (running === job) running = null } }
        try {
            job.await()
        } catch (cancelled: CancellationException) {
            job.cancel()
            currentCoroutineContext().ensureActive()
            throw failure("The long screenshot was cancelled")
        }
    }

    fun cancel(): Deferred<Map<String, Any?>>? = running?.also { job ->
        lab { "cancelled" }
        job.cancel()
    }

    private suspend fun run(context: Context, page: Page): Map<String, Any?> {
        val web = PageDrawnWatch.webViewIn(page.view.value) ?: throw failure("The page has no web view")
        if (!PageCapture.isDrawable(web)) throw failure("The page isn't on screen")
        val started = SystemClock.uptimeMillis()
        val state = page.state.value
        val held = Held(web, web.scrollX, web.scrollY, web.isVerticalScrollBarEnabled, CaptureDocument(state.url, state.isLoading, web.url))
        val watch = scope.launch { page.state.collect { held.document.saw(it.url, it.isLoading) } }
        try {
            discardAll(context)
            val stitched = try {
                stitch(context, page, held)
            } finally {
                withContext(NonCancellable) { restore(held) }
            }
            val captured = SystemClock.uptimeMillis()
            try {
                if (held.document.check(web.url)) throw failure("The page changed while it was captured")
                return write(context, stitched).also { result ->
                    lab { "captured ${stitched.screens} screen(s)${if (stitched.complete) "" else ", stopped early,"} into ${stitched.bitmap.width}x${stitched.bitmap.height} at scale ${"%.3f".format(stitched.scale)} in ${captured - started} ms, written in ${SystemClock.uptimeMillis() - captured} ms (${(result["tiles"] as List<*>).size} tile(s))" }
                }
            } finally {
                stitched.bitmap.recycle()
            }
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
            watch.cancel()
        }
    }

    private class Stitched(val bitmap: Bitmap, val screens: Int, val scale: Double, val complete: Boolean)

    private class Seen(val pixels: IntArray, val height: Int, val scrolled: Int, val position: Int)

    private class Step(val shot: Bitmap, val pixels: IntArray, val scrolled: Int) {
        val height = shot.height
        val width = shot.width
    }

    private suspend fun stitch(context: Context, page: Page, held: Held): Stitched {
        val web = held.web
        val width = web.width
        val viewport = web.height
        web.isVerticalScrollBarEnabled = false
        warm(page, held, width, viewport)
        val pageHeight = LongScreenshotPlan.pageHeight(reportedHeight(web), viewport)
        val output = LongScreenshotPlan.output(width, pageHeight, LongScreenshotPlan.outputBudget(available(context), width, viewport)) ?: throw failure("The page has no size")
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
            var matchFailed = false
            var previous: Seen? = null
            while (filled < pageHeight && steps < maxSteps) {
                steps += 1
                ensureSame(page, held, width)
                web.scrollTo(held.x, target)
                var step = settledStep(page, held, width)
                val before = previous
                var moved: Int? = 0
                if (before != null) {
                    val scrollSaid = step.scrolled - before.scrolled
                    val expected = if (scrollSaid > 0) scrollSaid else stride
                    moved = match(before, step, expected)
                    if (moved == null) {
                        step.shot.recycle()
                        awaitPaint(web)
                        delay(SETTLE_MILLIS)
                        step = settledStep(page, held, width)
                        moved = match(before, step, expected)
                    }
                    lab { "step $steps: scrolled ${before.scrolled} -> ${step.scrolled}, matched a move of ${moved ?: "nothing"} (scroll said $scrollSaid)" }
                    if (moved == null) {
                        step.shot.recycle()
                        matchFailed = true
                        break
                    }
                }
                val position = (before?.position ?: 0) + (moved ?: 0)
                val slice = LongScreenshotPlan.slice(position, filled, step.height, pageHeight)
                if (slice == null) {
                    step.shot.recycle()
                    break
                }
                canvas.drawBitmap(
                    step.shot,
                    Rect(0, slice.sourceTop, step.width, slice.sourceBottom),
                    Rect(0, LongScreenshotPlan.rowIn(output, slice.pageTop), output.width, LongScreenshotPlan.rowIn(output, slice.pageBottom)),
                    paint,
                )
                filled = slice.pageBottom
                target = position + stride
                step.shot.recycle()
                previous = if (held.hidden) {
                    Seen(step.pixels, step.height, step.scrolled, position)
                } else {
                    held.hidden = true
                    evaluate(web, script(HIDE_FIXED, held))
                    awaitPaint(web)
                    val again = settledStep(page, held, width)
                    again.shot.recycle()
                    Seen(again.pixels, again.height, again.scrolled, position)
                }
            }
            val ending = LongScreenshotPlan.ending(filled, pageHeight, viewport, matchFailed)
            if (ending == LongScreenshotPlan.Ending.Failed) throw failure("Only the first screen of this page lined up")
            val height = LongScreenshotPlan.rowIn(output, filled)
            if (height <= 0) throw failure("Nothing was captured")
            if (height < bitmap.height) bitmap.reconfigure(bitmap.width, height, Bitmap.Config.ARGB_8888)
            return Stitched(bitmap, LongScreenshotPlan.screens(filled, viewport), output.scale, ending == LongScreenshotPlan.Ending.Complete)
        } catch (error: Throwable) {
            bitmap.recycle()
            throw error
        }
    }

    private suspend fun settledStep(page: Page, held: Held, width: Int): Step {
        val web = held.web
        awaitPaint(web)
        delay(SETTLE_MILLIS)
        awaitPaint(web)
        ensureSame(page, held, width)
        val scrolled = web.scrollY
        val shot = drawn(web) ?: throw failure("The page didn't draw")
        val pixels = try {
            withContext(Dispatchers.Default) { PageCapture.pixels(shot) }
        } catch (error: Throwable) {
            shot.recycle()
            if (error is OutOfMemoryError) throw failure("Not enough memory for a long screenshot")
            throw error
        }
        return Step(shot, pixels, scrolled)
    }

    private suspend fun match(before: Seen, step: Step, expected: Int): Int? = withContext(Dispatchers.Default) {
        LongScreenshotPlan.offset(before.pixels, before.height, step.pixels, step.height, step.width, expected)
    }

    @Suppress("DEPRECATION")
    private fun reportedHeight(web: WebView): Double = web.contentHeight.toDouble() * web.scale

    private suspend fun warm(page: Page, held: Held, width: Int, viewport: Int) {
        val web = held.web
        val stride = LongScreenshotPlan.stride(viewport)
        var y = 0
        var steps = 0
        while (steps < LongScreenshotPlan.maxSteps(LongScreenshotPlan.pageHeight(reportedHeight(web), viewport), viewport)) {
            val bottom = LongScreenshotPlan.pageHeight(reportedHeight(web), viewport) - viewport
            if (y >= bottom) break
            steps += 1
            y = minOf(y + stride, bottom)
            ensureSame(page, held, width)
            web.scrollTo(held.x, y)
            awaitFrame()
            delay(WARM_MILLIS)
        }
        ensureSame(page, held, width)
        web.scrollTo(held.x, 0)
        delay(SETTLE_MILLIS)
        lab { "warmed ${steps} step(s) down to $y" }
    }

    private suspend fun restore(held: Held) {
        val web = held.web
        web.isVerticalScrollBarEnabled = held.scrollBar
        if (held.document.check(web.url)) {
            lab { "the page changed: its scroll and styles are left alone" }
            return
        }
        if (held.hidden) evaluate(web, script(SHOW_FIXED, held))
        web.scrollTo(held.x, held.y)
        lab { "restored the scroll to ${held.y}" }
    }

    private fun script(source: String, held: Held): String = source.replace(KEY_PLACEHOLDER, held.key)

    private suspend fun write(context: Context, stitched: Stitched): Map<String, Any?> {
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
            current = Session(id, file, bitmap.width, bitmap.height)
            return mapOf(
                "id" to id,
                "uri" to Uri.fromFile(file).toString(),
                "path" to file.absolutePath,
                "width" to bitmap.width.toDouble(),
                "height" to bitmap.height.toDouble(),
                "screens" to stitched.screens.toDouble(),
                "complete" to stitched.complete,
                "tiles" to tiles,
            )
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

    private fun ensureSame(page: Page, held: Held, width: Int) {
        val web = held.web
        if (held.document.check(web.url) || PageDrawnWatch.webViewIn(page.view.value) !== web || !web.isAttachedToWindow || web.width != width || web.height <= 0) throw failure("The page changed while it was captured")
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
    private suspend fun awaitPaint(web: WebView) {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.VISUAL_STATE_CALLBACK)) {
            withTimeoutOrNull(VISUAL_STATE_WAIT_MILLIS) {
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

    private suspend fun evaluate(web: WebView, script: String) {
        withTimeoutOrNull(SCRIPT_WAIT_MILLIS) {
            suspendCancellableCoroutine { continuation ->
                web.evaluateJavascript(script) { if (continuation.isActive) continuation.resume(Unit) }
            }
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

    private const val HIDE_FIXED = """(function(k){var t=Symbol.for(k);if(Object.prototype.hasOwnProperty.call(window,t))return 0;var list=[];Object.defineProperty(window,t,{value:list,configurable:true,enumerable:false,writable:false});var all=document.querySelectorAll('body *');for(var i=0;i<all.length;i++){var e=all[i],p=getComputedStyle(e).position;if(p!=='fixed'&&p!=='sticky')continue;list.push([e,e.getAttribute('style')]);e.style.setProperty('transition','none','important');if(p==='fixed'){e.style.setProperty('opacity','0','important');}else{e.style.setProperty('position','relative','important');e.style.setProperty('inset','auto','important');}}return list.length;})('ARDIA_CAPTURE_KEY')"""

    private const val SHOW_FIXED = """(function(k){var t=Symbol.for(k);if(!Object.prototype.hasOwnProperty.call(window,t))return 0;var list=window[t];delete window[t];for(var i=0;i<list.length;i++){var e=list[i][0],v=list[i][1];if(v===null)e.removeAttribute('style');else e.setAttribute('style',v);}return list.length;})('ARDIA_CAPTURE_KEY')"""
}
