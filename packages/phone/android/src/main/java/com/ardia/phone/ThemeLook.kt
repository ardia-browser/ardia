package com.ardia.phone

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cbrt
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sign
import kotlin.math.sin

enum class ThemeTexture(val key: String, val strength: Double) {
    Grain("grain", 0.8),
    Sand("sand", 0.15),
    Denim("denim", 0.6),
    Tweed("tweed", 0.4),
    ;

    companion object {
        fun fromKey(key: String?): ThemeTexture = entries.firstOrNull { it.key == key } ?: Grain
    }
}

data class ThemeColor(val r: Double, val g: Double, val b: Double, val a: Double = 1.0)

data class ThemeStop(val color: ThemeColor, val x: Double, val y: Double)

data class ThemeLook(
    val stops: List<ThemeStop>,
    val intensity: Double = DEFAULT_INTENSITY,
    val grain: Double = 0.0,
    val texture: ThemeTexture = ThemeTexture.Grain,
    val translucency: Double = 1.0,
    val angle: Double = DEFAULT_ANGLE,
) {
    val layerAlpha: Double get() = 1 - translucency.unit() * (1 - arcLayerAlpha(intensity))

    fun underlayAlpha(dark: Boolean): Double {
        val arc = min(arcLayerAlpha(intensity), 0.5)
        return translucency.unit() * if (dark) 0.35 * arc else arc
    }

    val grainAlpha: Double get() = grain.unit() * texture.strength

    private fun underGrey(dark: Boolean): Double {
        val under = underlayAlpha(dark)
        val blur = if (dark) 0.16 else 0.92
        return (if (dark) 0.0 else 1.0) * under + blur * (1 - under)
    }

    fun underColor(dark: Boolean): Int = underGrey(dark).let { opaque(it, it, it) }

    fun area(x: Double, y: Double, width: Double, height: Double): DoubleArray {
        val first = stops[0].color
        val second = stops.getOrNull(1)?.color ?: first
        val third = stops.getOrNull(2)?.color
        val t = (along(angle, x, y, width, height, ::baseHalf) / BASE_REACH).unit()
        val base = mixOklab(first, second, t)
        if (third == null) return base
        val amount = along(angle + 45, x, y, width, height, ::overlayHalf).unit() * third.a
        val top = doubleArrayOf(third.r, third.g, third.b)
        return DoubleArray(3) { base[it] + (top[it] - base[it]) * amount }
    }

    fun composite(dark: Boolean, x: Double, y: Double): DoubleArray {
        val alpha = layerAlpha
        val under = underGrey(dark)
        return area(x, y, 1.0, 1.0).map { alpha * it.unit() + (1 - alpha) * under }.toDoubleArray()
    }

    fun opaqueTint(dark: Boolean): List<Int> =
        listOf(composite(dark, 0.0, 0.0), composite(dark, 1.0, 1.0)).map { opaque(it[0], it[1], it[2]) }

    fun flatColor(dark: Boolean): Int = composite(dark, 0.5, 0.5).let { opaque(it[0], it[1], it[2]) }

    companion object {
        const val MAX_STOPS = 3
        const val DEFAULT_ANGLE = 135.0
        const val DEFAULT_INTENSITY = 0.6
        const val BASE_REACH = 0.75
        private const val MAX_READ_STOPS = 16

        fun arcLayerAlpha(intensity: Double): Double = 0.2 + 0.55 * intensity.unit()

        fun from(value: Any?): ThemeLook? {
            val fields = value as? Map<*, *> ?: return null
            val raw = fields["stops"] as? List<*> ?: return null
            val stops = ArrayList<ThemeStop>(MAX_STOPS)
            for (item in raw.take(MAX_READ_STOPS)) {
                if (stops.size >= MAX_STOPS) break
                val stop = item as? Map<*, *> ?: continue
                val color = color(stop["color"]) ?: continue
                stops += ThemeStop(color, number(stop["x"])?.unit() ?: 0.5, number(stop["y"])?.unit() ?: 0.5)
            }
            if (stops.isEmpty()) return null
            return ThemeLook(
                stops = stops,
                intensity = number(fields["intensity"])?.unit() ?: DEFAULT_INTENSITY,
                grain = number(fields["grain"])?.unit() ?: 0.0,
                texture = ThemeTexture.fromKey(fields["texture"] as? String),
                translucency = number(fields["translucency"])?.unit() ?: 1.0,
                angle = number(fields["angle"])?.let { ((it % 360) + 360) % 360 } ?: DEFAULT_ANGLE,
            )
        }

        private fun color(value: Any?): ThemeColor? {
            val fields = value as? Map<*, *> ?: return null
            val r = number(fields["r"]) ?: return null
            val g = number(fields["g"]) ?: return null
            val b = number(fields["b"]) ?: return null
            if (abs(r) >= 4 || abs(g) >= 4 || abs(b) >= 4) return null
            return ThemeColor(r, g, b, number(fields["a"])?.unit() ?: 1.0)
        }

        private fun number(value: Any?): Double? = (value as? Number)?.toDouble()?.takeIf { it.isFinite() }

        fun oklab(color: ThemeColor): DoubleArray {
            val r = decode(color.r)
            val g = decode(color.g)
            val b = decode(color.b)
            val l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
            val m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
            val s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
            return doubleArrayOf(
                0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
                1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
                0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
            )
        }

        fun fromOklab(lab: DoubleArray): DoubleArray {
            val l = (lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2]).pow(3)
            val m = (lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2]).pow(3)
            val s = (lab[0] - 0.0894841775 * lab[1] - 1.291485548 * lab[2]).pow(3)
            return doubleArrayOf(
                encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
                encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
                encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
            )
        }

        fun mixOklab(a: ThemeColor, b: ThemeColor, t: Double): DoubleArray {
            val from = oklab(a)
            val to = oklab(b)
            return fromOklab(DoubleArray(3) { from[it] + (to[it] - from[it]) * t })
        }

        fun direction(degrees: Double): Pair<Double, Double> {
            val radians = degrees * PI / 180
            return sin(radians) to -cos(radians)
        }

        fun baseHalf(width: Double, height: Double, dx: Double, dy: Double): Double =
            hypot(width * dx, height * dy) * hypot(width, height) / (2 * max(width, height))

        fun overlayHalf(width: Double, height: Double, dx: Double, dy: Double): Double = (width * abs(dx) + height * abs(dy)) / 2

        private fun along(
            degrees: Double,
            x: Double,
            y: Double,
            width: Double,
            height: Double,
            half: (Double, Double, Double, Double) -> Double,
        ): Double {
            val (dx, dy) = direction(degrees)
            return ((x - width / 2) * dx + (y - height / 2) * dy) / (2 * half(width, height, dx, dy)) + 0.5
        }

        private fun decode(value: Double): Double =
            sign(value) * if (abs(value) <= 0.04045) abs(value) / 12.92 else ((abs(value) + 0.055) / 1.055).pow(2.4)

        private fun encode(value: Double): Double =
            sign(value) * if (abs(value) <= 0.0031308) abs(value) * 12.92 else 1.055 * abs(value).pow(1 / 2.4) - 0.055

        fun channel(value: Double): Int = floor(value.unit() * 255 + 0.5).toInt()

        fun argb(r: Double, g: Double, b: Double, a: Double): Int =
            (channel(a) shl 24) or (channel(r) shl 16) or (channel(g) shl 8) or channel(b)

        private fun opaque(r: Double, g: Double, b: Double): Int = argb(r, g, b, 1.0)
    }
}

private fun Double.unit(): Double = min(1.0, max(0.0, this))
