package com.ardia.phone

import android.graphics.Bitmap
import android.graphics.ColorSpace
import android.graphics.HardwareRenderer
import android.graphics.PixelFormat
import android.graphics.RenderNode
import android.hardware.HardwareBuffer
import android.media.ImageReader
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.ardia.design.ProfileLook

internal object LookTrace {
    fun enabled(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && android.os.Trace.isEnabled()

    fun counter(name: String, value: Long) {
        if (enabled()) android.os.Trace.setCounter(name, value)
    }

    fun flag(name: String, on: Boolean) = counter(name, if (on) 1L else 0L)
}

internal object SampleHoldRules {
    const val SETTLE_MS = 160L
    const val CAPTURE_TRIES = 2
    const val CAPTURE_TIMEOUT_MS = 250L
    const val HELD_REASON = "held sample while the page scrolls"

    data class Stamp(
        val key: String,
        val width: Int,
        val height: Int,
        val offset: Long,
        val dark: Boolean,
        val look: ProfileLook?,
        val blurPx: Float,
        val saturation: Float,
        val scale: Float,
        val margin: Float,
    )

    fun holds(key: String?, scrolling: Boolean, sampling: Boolean, stored: Stamp?, now: Stamp?): Boolean =
        key != null && scrolling && sampling && stored != null && stored == now && stored.key == key

    fun bridges(key: String?, choice: FrostPage.Choice, stored: Stamp?, now: Stamp?): Boolean =
        key != null && choice.path == FrostPage.Path.Fallback && choice.reason == FrostPage.SOURCE_NOT_DRAWN && stored != null && stored == now
}

internal class HeldSample(val bitmap: Bitmap, val stamp: SampleHoldRules.Stamp, val layerWidth: Int, val layerHeight: Int)

internal fun interface SampleCapture {
    fun capture(node: RenderNode, width: Int, height: Int, done: (Bitmap?) -> Unit)
}

internal object LayerCapture : SampleCapture {
    private const val FAILED = HardwareRenderer.SYNC_CONTEXT_IS_STOPPED or HardwareRenderer.SYNC_FRAME_DROPPED or HardwareRenderer.SYNC_LOST_SURFACE_REWARD_IF_FOUND

    override fun capture(node: RenderNode, width: Int, height: Int, done: (Bitmap?) -> Unit) {
        if (width <= 0 || height <= 0) return done(null)
        val reader = runCatching {
            ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 1, HardwareBuffer.USAGE_GPU_SAMPLED_IMAGE or HardwareBuffer.USAGE_GPU_COLOR_OUTPUT)
        }.getOrNull() ?: return done(null)
        val main = Handler(Looper.getMainLooper())
        val renderer = HardwareRenderer()
        val root = RenderNode("ardiaSampleCapture")
        var finished = false
        lateinit var timeout: Runnable
        fun finish(bitmap: Bitmap?) {
            if (finished) return
            finished = true
            main.removeCallbacks(timeout)
            renderer.destroy()
            root.discardDisplayList()
            reader.close()
            done(bitmap)
        }
        timeout = Runnable { finish(null) }
        reader.setOnImageAvailableListener({ ready ->
            val bitmap = runCatching {
                ready.acquireLatestImage()?.use { image -> image.hardwareBuffer?.use { buffer -> Bitmap.wrapHardwareBuffer(buffer, ColorSpace.get(ColorSpace.Named.SRGB)) } }
            }.getOrNull()
            finish(bitmap)
        }, main)
        main.postDelayed(timeout, SampleHoldRules.CAPTURE_TIMEOUT_MS)
        android.os.Trace.beginSection("ardiaSampleCapture")
        val result = try {
            root.setPosition(0, 0, width, height)
            val canvas = root.beginRecording(width, height)
            try {
                canvas.drawRenderNode(node)
            } finally {
                root.endRecording()
            }
            renderer.setOpaque(false)
            renderer.setSurface(reader.surface)
            renderer.setContentRoot(root)
            renderer.createRenderRequest().syncAndDraw()
        } catch (error: RuntimeException) {
            FAILED
        } finally {
            android.os.Trace.endSection()
        }
        if (result and FAILED != 0) finish(null)
    }
}
