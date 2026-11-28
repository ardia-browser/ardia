package com.ardia.phone

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.graphics.Rect
import android.view.Choreographer
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.ardia.browser.PageCapture
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull

internal class WebViewCapturePage(private val web: WebView) : CapturePage {
    override val width: Int get() = web.width
    override val height: Int get() = web.height
    override val scrollY: Int get() = web.scrollY
    override val attached: Boolean get() = web.isAttachedToWindow

    @Suppress("DEPRECATION")
    override val scale: Double get() = web.scale.toDouble()

    @Suppress("DEPRECATION")
    override val documentHeight: Double get() = web.contentHeight.toDouble() * web.scale

    override var scrollBarShown: Boolean
        get() = web.isVerticalScrollBarEnabled
        set(value) {
            web.isVerticalScrollBarEnabled = value
        }

    override suspend fun evaluate(script: String, waitMillis: Long): Int? = withTimeoutOrNull(waitMillis) {
        suspendCancellableCoroutine { continuation ->
            web.evaluateJavascript(script) { result -> if (continuation.isActive) continuation.resume(result?.toIntOrNull()) }
        }
    }

    @SuppressLint("RequiresFeature")
    override suspend fun awaitPaint() {
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

    override suspend fun draw(region: Rect): Bitmap? {
        val first = PageCapture.drawView(web, region, region.width(), region.height())
        if (!PageCapture.isBlank(first, blackIsBlank = true)) return first
        first.recycle()
        awaitPaint()
        val second = PageCapture.drawView(web, region, region.width(), region.height())
        if (!PageCapture.isBlank(second, blackIsBlank = false)) return second
        second.recycle()
        return null
    }

    override fun equals(other: Any?): Boolean = other is WebViewCapturePage && other.web === web

    override fun hashCode(): Int = System.identityHashCode(web)

    private companion object {
        const val VISUAL_STATE_WAIT_MILLIS = 500L
        const val FRAME_WAIT_MILLIS = 100L
        var visualRequests = 0L
    }
}
