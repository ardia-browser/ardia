package com.ardia.phone

import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.HardwareRenderer
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RenderNode
import android.graphics.RuntimeShader
import android.graphics.Shader
import android.hardware.HardwareBuffer
import android.media.ImageReader
import android.os.Build
import androidx.compose.ui.graphics.toArgb
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.ardia.design.FrostedStyle
import kotlin.math.abs
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class GlassPlateShaderTest {
    private val side = 4

    private fun shaded(backdrop: Int, tint: Int, limit: GlassReadability.Limit): Int {
        val source = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888).apply { eraseColor(backdrop) }
        val shader = RuntimeShader(GlassReadability.SHADER)
        shader.setInputShader("plate", BitmapShader(source, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP))
        shader.setFloatUniform("tint", GlassReadability.premultiplied(tint))
        shader.setFloatUniform("upper", limit.ceiling)
        shader.setFloatUniform("lower", limit.floor)
        val reader = ImageReader.newInstance(side, side, PixelFormat.RGBA_8888, 1, HardwareBuffer.USAGE_GPU_SAMPLED_IMAGE or HardwareBuffer.USAGE_GPU_COLOR_OUTPUT)
        val node = RenderNode("plateShaderTest").apply { setPosition(0, 0, side, side) }
        val recording = node.beginRecording()
        recording.drawRect(0f, 0f, side.toFloat(), side.toFloat(), Paint().apply { this.shader = shader })
        node.endRecording()
        val renderer = HardwareRenderer().apply {
            setSurface(reader.surface)
            setContentRoot(node)
        }
        try {
            renderer.createRenderRequest().setWaitForPresent(true).syncAndDraw()
            val image = reader.acquireNextImage()
            try {
                val buffer = image.hardwareBuffer ?: error("no buffer")
                val bitmap = Bitmap.wrapHardwareBuffer(buffer, null)?.copy(Bitmap.Config.ARGB_8888, false) ?: error("no bitmap")
                buffer.close()
                return bitmap.getPixel(side / 2, side / 2)
            } finally {
                image.close()
            }
        } finally {
            renderer.destroy()
            reader.close()
        }
    }

    private fun near(expected: Int, actual: Int, what: String) {
        for (shift in listOf(0, 8, 16, 24)) {
            val one = (expected shr shift) and 0xFF
            val other = (actual shr shift) and 0xFF
            assertTrue("$what: #${Integer.toHexString(expected)} vs #${Integer.toHexString(actual)}", abs(one - other) <= 2)
        }
    }

    @Test
    fun theShaderOnTheGpuPullsLikeTheCheckedMath() {
        assumeTrue(Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
        val backdrops = listOf(0xFFFFFFFF.toInt(), 0xFF000000.toInt(), 0xFF7A0010.toInt(), 0xFF2A2030.toInt(), 0xFFFFE600.toInt())
        for (dark in listOf(true, false)) for (backdrop in backdrops) {
            val tint = FrostedStyle.glass.tint.resolve(dark).toArgb()
            val limit = GlassReadability.steady(dark)
            val expected = GlassReadability.readable(GlassReadability.over(tint, backdrop), limit)
            near(expected, shaded(backdrop, tint, limit), "dark $dark over #${Integer.toHexString(backdrop)}")
        }
    }

    @Test
    fun theShaderLeavesAReadablePlateUntouched() {
        assumeTrue(Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
        val darkTint = FrostedStyle.glass.tint.resolve(true).toArgb()
        near(GlassReadability.over(darkTint, 0xFF000000.toInt()), shaded(0xFF000000.toInt(), darkTint, GlassReadability.steady(true)), "dark glass over black")
        val lightTint = FrostedStyle.glass.tint.resolve(false).toArgb()
        near(GlassReadability.over(lightTint, 0xFFFFFFFF.toInt()), shaded(0xFFFFFFFF.toInt(), lightTint, GlassReadability.steady(false)), "light glass over white")
    }
}
