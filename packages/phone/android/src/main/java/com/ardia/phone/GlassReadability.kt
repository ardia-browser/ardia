package com.ardia.phone

import android.graphics.RenderEffect
import android.graphics.RuntimeShader
import android.os.Build
import androidx.annotation.RequiresApi
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

internal object GlassReadability {
    data class Ink(val red: Double, val green: Double, val blue: Double, val alpha: Double)

    data class Limit(val ceiling: Float, val floor: Float)

    val lightInk = Ink(1.0, 1.0, 1.0, 0.8)
    val darkInk = Ink(0x0E / 255.0, 0x0F / 255.0, 0x10 / 255.0, 0.9)
    const val READABLE_CONTRAST = 5.0
    const val TONE_EASE_MS = 180L
    private const val GAMMA = 2.2
    private const val TONE_CEILING_MARGIN = 0.005
    private const val TONE_FLOOR_MARGIN = 0.02
    private const val DARK_VEIL_GRAY = 0.12
    private const val LIGHT_VEIL_GRAY = 0.9
    private const val BOUND_MARGIN = 0.001

    val ceiling: Double = bound(lightInk, dark = true)
    val floor: Double = bound(darkInk, dark = false)

    var onPulled: (() -> Unit)? = null

    fun luminance(red: Double, green: Double, blue: Double): Double =
        0.2126 * red.pow(GAMMA) + 0.7152 * green.pow(GAMMA) + 0.0722 * blue.pow(GAMMA)

    fun contrast(one: Double, other: Double): Double = (max(one, other) + 0.05) / (min(one, other) + 0.05)

    fun text(ink: Ink, red: Double, green: Double, blue: Double): Double =
        luminance(ink.red * ink.alpha + red * (1 - ink.alpha), ink.green * ink.alpha + green * (1 - ink.alpha), ink.blue * ink.alpha + blue * (1 - ink.alpha))

    fun reads(ink: Ink, red: Double, green: Double, blue: Double): Double = contrast(text(ink, red, green, blue), luminance(red, green, blue))

    fun grayBound(ink: Ink, dark: Boolean): Double {
        var low = 0.0
        var high = 1.0
        repeat(30) {
            val middle = (low + high) / 2
            if ((reads(ink, middle, middle, middle) >= READABLE_CONTRAST) == dark) low = middle else high = middle
        }
        val gray = if (dark) low else high
        return luminance(gray, gray, gray)
    }

    private fun probes(): List<DoubleArray> = buildList {
        val steps = doubleArrayOf(0.0, 0.5, 1.0)
        for (red in steps) for (green in steps) for (blue in steps) if (red + green + blue > 0.0) add(doubleArrayOf(red, green, blue))
    }

    fun pull(red: Double, green: Double, blue: Double, ceiling: Double, floor: Double): DoubleArray {
        val lin = doubleArrayOf(red.coerceIn(0.0, 1.0).pow(GAMMA), green.coerceIn(0.0, 1.0).pow(GAMMA), blue.coerceIn(0.0, 1.0).pow(GAMMA))
        val light = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
        if (light > ceiling) {
            val share = ceiling / max(light, 0.0001)
            for (index in lin.indices) lin[index] *= share
        } else if (light < floor) {
            val share = (floor - light) / max(1.0 - light, 0.0001)
            for (index in lin.indices) lin[index] += (1.0 - lin[index]) * share
        }
        return DoubleArray(3) { lin[it].coerceIn(0.0, 1.0).pow(1.0 / GAMMA) }
    }

    fun bound(ink: Ink, dark: Boolean): Double {
        var strictest = grayBound(ink, dark)
        for (probe in probes()) {
            var low = 0.0
            var high = 1.0
            repeat(30) {
                val middle = (low + high) / 2
                val pulled = if (dark) pull(probe[0], probe[1], probe[2], middle, 0.0) else pull(probe[0], probe[1], probe[2], 1.0, middle)
                if ((reads(ink, pulled[0], pulled[1], pulled[2]) >= READABLE_CONTRAST) == dark) low = middle else high = middle
            }
            strictest = if (dark) min(strictest, low) else max(strictest, high)
        }
        return if (dark) strictest - BOUND_MARGIN else strictest + BOUND_MARGIN
    }

    fun steady(dark: Boolean): Limit = if (dark) Limit(ceiling.toFloat(), 0f) else Limit(1f, floor.toFloat())

    fun toneLimit(dark: Boolean, sinceMs: Long): Limit {
        val progress = (sinceMs.toDouble() / TONE_EASE_MS).coerceIn(0.0, 1.0)
        val eased = 1 - (1 - progress) * (1 - progress)
        if (dark) return Limit(ceiling.toFloat(), ((ceiling - TONE_CEILING_MARGIN) * (1 - eased)).toFloat())
        val start = floor + TONE_FLOOR_MARGIN
        return Limit((start + (1 - start) * eased).toFloat(), floor.toFloat())
    }

    fun easing(sinceMs: Long): Boolean = sinceMs in 0 until TONE_EASE_MS

    private fun alphaOf(colour: Int) = (colour ushr 24) and 0xFF
    private fun redOf(colour: Int) = (colour shr 16) and 0xFF
    private fun greenOf(colour: Int) = (colour shr 8) and 0xFF
    private fun blueOf(colour: Int) = colour and 0xFF

    private fun argb(alpha: Int, red: Int, green: Int, blue: Int): Int =
        (alpha.coerceIn(0, 255) shl 24) or (red.coerceIn(0, 255) shl 16) or (green.coerceIn(0, 255) shl 8) or blue.coerceIn(0, 255)

    fun over(top: Int, under: Int): Int {
        val topAlpha = alphaOf(top) / 255.0
        val underAlpha = alphaOf(under) / 255.0
        val alpha = topAlpha + underAlpha * (1 - topAlpha)
        if (alpha <= 0.0) return 0
        fun mix(topChannel: Int, underChannel: Int) = ((topChannel * topAlpha + underChannel * underAlpha * (1 - topAlpha)) / alpha).roundToInt()
        return argb((alpha * 255).roundToInt(), mix(redOf(top), redOf(under)), mix(greenOf(top), greenOf(under)), mix(blueOf(top), blueOf(under)))
    }

    fun luminanceOf(colour: Int): Double = luminance(redOf(colour) / 255.0, greenOf(colour) / 255.0, blueOf(colour) / 255.0)

    fun readable(colour: Int, limit: Limit): Int {
        if (alphaOf(colour) == 0) return colour
        val light = luminanceOf(colour)
        val lowered = light > limit.ceiling
        val raised = !lowered && light < limit.floor
        if (!lowered && !raised) return colour
        val pulled = pull(redOf(colour) / 255.0, greenOf(colour) / 255.0, blueOf(colour) / 255.0, limit.ceiling.toDouble(), limit.floor.toDouble())
        fun encode(value: Double): Int = if (lowered) floor(value * 255).toInt() else ceil(value * 255).toInt()
        return argb(alphaOf(colour), encode(pulled[0]), encode(pulled[1]), encode(pulled[2]))
    }

    fun pulls(colour: Int, dark: Boolean): Boolean {
        val light = luminanceOf(colour)
        return if (dark) light > ceiling else light < floor
    }

    fun veilOver(fill: Int, backdrop: Double): Double {
        val alpha = alphaOf(fill) / 255.0
        fun channel(value: Int) = value / 255.0 * alpha + backdrop * (1 - alpha)
        return luminance(channel(redOf(fill)), channel(greenOf(fill)), channel(blueOf(fill)))
    }

    fun worstBackdrop(dark: Boolean): Double = if (dark) 1.0 else 0.0

    fun veilFits(fill: Int, dark: Boolean): Boolean {
        val light = veilOver(fill, worstBackdrop(dark))
        return if (dark) light <= ceiling else light >= floor
    }

    fun veil(fill: Int, dark: Boolean): Int {
        if (veilFits(fill, dark)) return fill
        var made = argb(255, redOf(fill), greenOf(fill), blueOf(fill))
        if (!veilFits(made, dark)) {
            val gray = ((if (dark) DARK_VEIL_GRAY else LIGHT_VEIL_GRAY) * 255).roundToInt()
            made = argb(255, gray, gray, gray)
        }
        var low = alphaOf(fill)
        var high = 255
        while (high - low > 1) {
            val middle = (low + high) / 2
            if (veilFits((made and 0x00FFFFFF) or (middle shl 24), dark)) high = middle else low = middle
        }
        return (made and 0x00FFFFFF) or (high shl 24)
    }

    fun plateFill(fill: Int, dark: Boolean, limit: Limit): Int = if (alphaOf(fill) == 255) readable(fill, limit) else veil(fill, dark)

    fun saturated(colour: Int, saturation: Float): Int {
        val red = redOf(colour)
        val green = greenOf(colour)
        val blue = blueOf(colour)
        val grey = 0.213f * red + 0.715f * green + 0.072f * blue
        fun push(channel: Int) = (grey + (channel - grey) * saturation).roundToInt()
        return argb(alphaOf(colour), push(red), push(green), push(blue))
    }

    fun estimatedPlate(pageColour: Int, saturation: Float, tint: Int): Int = over(tint, saturated(pageColour or (0xFF shl 24), saturation))

    const val SHADER = """
uniform shader plate;
uniform half4 tint;
uniform float upper;
uniform float lower;

half4 main(float2 p) {
    half4 colour = plate.eval(p);
    colour = tint + colour * (1.0 - tint.a);
    if (colour.a <= 0.0) return colour;
    float3 lin = pow(clamp(float3(colour.rgb) / float(colour.a), 0.0, 1.0), float3(2.2));
    float light = dot(lin, float3(0.2126, 0.7152, 0.0722));
    if (light > upper) {
        lin *= upper / max(light, 0.0001);
    } else if (light < lower) {
        lin += (1.0 - lin) * ((lower - light) / max(1.0 - light, 0.0001));
    }
    return half4(half3(pow(lin, float3(1.0 / 2.2))) * colour.a, colour.a);
}
"""

    fun premultiplied(colour: Int): FloatArray {
        val alpha = alphaOf(colour) / 255f
        return floatArrayOf(redOf(colour) / 255f * alpha, greenOf(colour) / 255f * alpha, blueOf(colour) / 255f * alpha, alpha)
    }
}

internal class PullWatch {
    var pulled = false
        private set

    fun note(now: Boolean) {
        if (now && !pulled) GlassReadability.onPulled?.invoke()
        pulled = now
    }
}

internal class ToneEase(private val clock: () -> Long = android.os.SystemClock::uptimeMillis) {
    private var shade: Boolean? = null
    private var changedAt = Long.MIN_VALUE

    fun limit(dark: Boolean): Pair<GlassReadability.Limit, Boolean> {
        val now = clock()
        if (shade != null && shade != dark) changedAt = now
        shade = dark
        if (changedAt == Long.MIN_VALUE) return GlassReadability.steady(dark) to false
        val since = now - changedAt
        return GlassReadability.toneLimit(dark, since) to GlassReadability.easing(since)
    }
}

@RequiresApi(Build.VERSION_CODES.TIRAMISU)
internal object ReadablePlate {
    data class Key(val tint: Int, val upper: Float, val lower: Float)

    fun shader(): RuntimeShader = RuntimeShader(GlassReadability.SHADER)

    fun effect(shader: RuntimeShader, key: Key): RenderEffect {
        shader.setFloatUniform("tint", GlassReadability.premultiplied(key.tint))
        shader.setFloatUniform("upper", key.upper)
        shader.setFloatUniform("lower", key.lower)
        return RenderEffect.createRuntimeShaderEffect(shader, "plate")
    }
}
