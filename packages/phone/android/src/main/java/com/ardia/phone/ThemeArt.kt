package com.ardia.phone

import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.ComposeShader
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.Shader
import kotlin.math.max
import kotlin.math.min

object ThemeTextures {
    const val SIDE = 128
    const val TILE_POINTS = 64

    private class Darkening(val gain: Float, val floor: Float)

    private val darkening = mapOf(
        ThemeTexture.Grain to Darkening(0.211f, 0f),
        ThemeTexture.Sand to Darkening(0.937f, 0.132f),
        ThemeTexture.Denim to Darkening(0.226f, 0.068f),
        ThemeTexture.Tweed to Darkening(0.23f, 0.261f),
    )

    fun alphas(texture: ThemeTexture): ByteArray {
        val n = SIDE
        val alpha = FloatArray(n * n)
        var state = 0x9E3779B9u
        fun random(): Float {
            state = state xor (state shl 13)
            state = state xor (state shr 17)
            state = state xor (state shl 5)
            return (state % 10_000u).toFloat() / 10_000f
        }
        fun add(x: Int, y: Int, v: Float) {
            val i = ((y % n + n) % n) * n + (x % n + n) % n
            alpha[i] = min(1f, alpha[i] + v)
        }
        when (texture) {
            ThemeTexture.Sand -> {
                for (i in 0 until n * n) alpha[i] = random() * 0.25f
                repeat(n * n / 18) {
                    val x = (random() * n.toFloat()).toInt()
                    val y = (random() * n.toFloat()).toInt()
                    val v = 0.5f + random() * 0.5f
                    add(x, y, v)
                    add(x + 1, y, v * 0.6f)
                    add(x, y + 1, v * 0.6f)
                    add(x + 1, y + 1, v * 0.4f)
                }
            }
            ThemeTexture.Denim -> {
                for (y in 0 until n) {
                    for (x in 0 until n) {
                        val twill = if ((x + y) % 4 < 2) 0.75f else 0.15f
                        alpha[y * n + x] = min(1f, twill * (0.6f + random() * 0.4f) + if (y % 2 == 0) 0.08f else 0f)
                    }
                }
            }
            ThemeTexture.Tweed -> {
                for (i in 0 until n * n) alpha[i] = random() * 0.15f
                repeat(n * n / 40) {
                    val x = (random() * n.toFloat()).toInt()
                    val y = (random() * n.toFloat()).toInt()
                    val v = 0.4f + random() * 0.6f
                    val horizontal = random() < 0.5f
                    for (k in 0 until 3 + (random() * 4f).toInt()) if (horizontal) add(x + k, y, v) else add(x, y + k, v)
                }
            }
            ThemeTexture.Grain -> {
                for (i in 0 until n * n) {
                    val u = random()
                    alpha[i] = u * u
                }
            }
        }
        val match = darkening.getValue(texture)
        return ByteArray(n * n) { i -> min(255f, max(0f, match.floor + match.gain * alpha[i]) * 255f).toInt().toByte() }
    }

    private val bitmaps = HashMap<ThemeTexture, Bitmap>()
    private val paints = HashMap<String, Paint>()

    private fun bitmap(texture: ThemeTexture): Bitmap = bitmaps.getOrPut(texture) {
        val pixels = alphas(texture).map { (it.toInt() and 0xFF) shl 24 }.toIntArray()
        Bitmap.createBitmap(pixels, SIDE, SIDE, Bitmap.Config.ARGB_8888)
    }

    fun paint(texture: ThemeTexture, density: Float, opacity: Float): Paint = synchronized(this) {
        val alpha = (opacity.coerceIn(0f, 1f) * 255).toInt()
        paints.getOrPut("${texture.key} $density $alpha") {
            Paint(Paint.ANTI_ALIAS_FLAG).apply {
                shader = BitmapShader(bitmap(texture), Shader.TileMode.REPEAT, Shader.TileMode.REPEAT).apply {
                    val scale = TILE_POINTS * density / SIDE
                    setLocalMatrix(Matrix().apply { setScale(scale, scale) })
                }
                this.alpha = alpha
                isFilterBitmap = true
            }
        }
    }

    internal val paintCount: Int get() = synchronized(this) { paints.size }

    fun forgetCaches() = synchronized(this) {
        paints.clear()
        bitmaps.clear()
    }
}

class ThemeArt(val look: ThemeLook, val dark: Boolean) {
    val under: Int = look.underColor(dark)
    val layerAlpha: Int = (look.layerAlpha * 255).toInt()
    val grainAlpha: Float = look.grainAlpha.toFloat()
    val texture: ThemeTexture = look.texture
    val flat: Int = look.flatColor(dark)
    private val baseColors: IntArray
    private val basePositions: FloatArray
    private val overlayColors: IntArray?
    private val underPaint = Paint().apply { color = under }
    private val layerPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var shaderWidth = -1f
    private var shaderHeight = -1f

    init {
        val first = look.stops[0].color
        val second = look.stops.getOrNull(1)?.color ?: first
        val steps = if (look.stops.size > 1) SAMPLES else 1
        baseColors = IntArray(steps + 1) { i ->
            val t = i.toDouble() / steps
            val rgb = ThemeLook.mixOklab(first, second, t)
            ThemeLook.argb(rgb[0], rgb[1], rgb[2], first.a + (second.a - first.a) * t)
        }
        basePositions = FloatArray(steps + 1) { it.toFloat() / steps }
        overlayColors = look.stops.getOrNull(2)?.color?.let { top ->
            intArrayOf(ThemeLook.argb(top.r, top.g, top.b, 0.0), ThemeLook.argb(top.r, top.g, top.b, top.a))
        }
    }

    fun layerShader(width: Float, height: Float): Shader {
        val w = max(width, 1f).toDouble()
        val h = max(height, 1f).toDouble()
        val base = gradient(w, h, look.angle, ThemeLook.BASE_REACH, ThemeLook::baseHalf, baseColors, basePositions)
        val overlay = overlayColors ?: return base
        return ComposeShader(base, gradient(w, h, look.angle + 45, 1.0, ThemeLook::overlayHalf, overlay, null), PorterDuff.Mode.SRC_OVER)
    }

    fun drawLayers(canvas: Canvas, width: Float, height: Float) {
        if (width != shaderWidth || height != shaderHeight) {
            layerPaint.shader = layerShader(width, height)
            layerPaint.alpha = layerAlpha
            shaderWidth = width
            shaderHeight = height
        }
        canvas.drawRect(0f, 0f, width, height, underPaint)
        canvas.drawRect(0f, 0f, width, height, layerPaint)
    }

    fun drawTexture(canvas: Canvas, width: Float, height: Float, density: Float) {
        if (grainAlpha <= 0f) return
        canvas.drawRect(0f, 0f, width, height, ThemeTextures.paint(texture, density, grainAlpha))
    }

    fun draw(canvas: Canvas, width: Float, height: Float, density: Float) {
        drawLayers(canvas, width, height)
        drawTexture(canvas, width, height, density)
    }

    private fun gradient(
        w: Double,
        h: Double,
        degrees: Double,
        reach: Double,
        half: (Double, Double, Double, Double) -> Double,
        colors: IntArray,
        positions: FloatArray?,
    ): Shader {
        val (dx, dy) = ThemeLook.direction(degrees)
        val length = half(w, h, dx, dy)
        val startX = w / 2 - length * dx
        val startY = h / 2 - length * dy
        val span = 2 * length * reach
        return LinearGradient(
            startX.toFloat(), startY.toFloat(), (startX + span * dx).toFloat(), (startY + span * dy).toFloat(),
            colors, positions, Shader.TileMode.CLAMP,
        )
    }

    companion object {
        const val SAMPLES = 16
    }
}
