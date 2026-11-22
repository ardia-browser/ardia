package com.ardia.phone

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ThemeLookTest {
    private val tolerance = 1e-6

    private val three = ThemeLook(
        stops = listOf(
            ThemeStop(ThemeColor(0.9, 0.4, 0.5), 0.2, 0.3),
            ThemeStop(ThemeColor(0.2, 0.5, 0.9), 0.7, 0.6),
            ThemeStop(ThemeColor(0.4, 0.9, 0.3, 0.8), 0.5, 0.9),
        ),
        intensity = 0.4,
        grain = 0.7,
        texture = ThemeTexture.Tweed,
        translucency = 0.6,
        angle = 200.0,
    )

    private val darkLook = ThemeLook(
        stops = listOf(ThemeStop(ThemeColor(0.1, 0.12, 0.3), 0.3, 0.3), ThemeStop(ThemeColor(0.25, 0.1, 0.3), 0.6, 0.4)),
        intensity = 0.8,
        grain = 0.2,
        texture = ThemeTexture.Sand,
        translucency = 0.3,
    )

    private fun hex(argb: Int): String = "#" + (argb and 0xFFFFFF).toString(16).uppercase().padStart(6, '0')

    @Test
    fun oklabMixingMatchesTheMac() {
        assertArrayEquals(doubleArrayOf(0.672780862, 0.157048863, 0.027664588), ThemeLook.oklab(three.stops[0].color), tolerance)
        assertArrayEquals(
            doubleArrayOf(0.73446288, 0.462226481, 0.630759446),
            ThemeLook.mixOklab(three.stops[0].color, three.stops[1].color, 0.3),
            tolerance,
        )
    }

    @Test
    fun theAngledAreaMatchesTheMac() {
        assertArrayEquals(doubleArrayOf(0.633408444, 0.632252029, 0.466014654), three.area(0.0, 0.0, 400.0, 800.0), tolerance)
        assertArrayEquals(doubleArrayOf(0.744176793, 0.51026153, 0.535386832), three.area(300.0, 100.0, 400.0, 800.0), tolerance)
        assertArrayEquals(doubleArrayOf(0.277210657, 0.654421267, 0.66836807), three.area(400.0, 800.0, 400.0, 800.0), tolerance)
        assertEquals("#76A895", three.area(0.5, 0.5, 1.0, 1.0).let { hex(ThemeLook.argb(it[0], it[1], it[2], 1.0)) })
    }

    @Test
    fun layerAlphasAndUnderColorsMatchTheMac() {
        assertEquals(0.652, three.layerAlpha, tolerance)
        assertEquals(0.252, three.underlayAlpha(false), tolerance)
        assertEquals(0.0882, three.underlayAlpha(true), tolerance)
        assertEquals(0.28, three.grainAlpha, tolerance)
        assertEquals("#F0F0F0", hex(three.underColor(false)))
        assertEquals("#252525", hex(three.underColor(true)))
        assertEquals(listOf("#ABC9A1", "#86B8CD"), three.opaqueTint(false).map(::hex))
        assertEquals(listOf("#65825A", "#3F7187"), three.opaqueTint(true).map(::hex))
        assertEquals("#272727", hex(darkLook.underColor(true)))
        assertEquals(0.03, darkLook.grainAlpha, tolerance)
    }

    @Test
    fun theFlatColourIsTheCompositeAtTheMiddle() {
        val middle = three.composite(false, 0.5, 0.5)
        assertEquals(ThemeLook.argb(middle[0], middle[1], middle[2], 1.0), three.flatColor(false))
        assertEquals(0xFF shl 24, three.flatColor(true) and (0xFF shl 24))
    }

    @Test
    fun decodingSanitizesLikeTheMac() {
        val look = ThemeLook.from(
            mapOf(
                "stops" to listOf(
                    mapOf("color" to mapOf("r" to 2, "g" to 0.5, "b" to 0.1), "x" to 3, "y" to -1),
                    mapOf("color" to mapOf("r" to 9, "g" to 0, "b" to 0)),
                    "not a stop",
                    mapOf("color" to mapOf("r" to 0.1, "g" to 0.2, "b" to 0.3, "a" to 5)),
                ),
                "intensity" to 7,
                "grain" to "x",
                "texture" to "felt",
                "angle" to -90,
            ),
        )!!
        assertEquals(
            listOf(ThemeStop(ThemeColor(2.0, 0.5, 0.1, 1.0), 1.0, 0.0), ThemeStop(ThemeColor(0.1, 0.2, 0.3, 1.0), 0.5, 0.5)),
            look.stops,
        )
        assertEquals(listOf(1.0, 0.0, 1.0, 270.0), listOf(look.intensity, look.grain, look.translucency, look.angle))
        assertEquals(ThemeTexture.Grain, look.texture)
        assertNull(ThemeLook.from(null))
        assertNull(ThemeLook.from("{}"))
        assertNull(ThemeLook.from(mapOf("stops" to emptyList<Any>())))
        assertNull(ThemeLook.from(mapOf("stops" to listOf(mapOf("color" to mapOf("r" to Double.NaN, "g" to 0, "b" to 0))))))
    }

    @Test
    fun decodingKeepsAtMostThreeStopsAndDefaultsTheAngle() {
        val stop = mapOf("color" to mapOf("r" to 0.5, "g" to 0.5, "b" to 0.5), "x" to 0.2, "y" to 0.8)
        val look = ThemeLook.from(mapOf("stops" to List(5) { stop }, "texture" to "denim", "translucency" to 0.25, "grain" to 0.4))!!
        assertEquals(3, look.stops.size)
        assertEquals(ThemeLook.DEFAULT_ANGLE, look.angle, 0.0)
        assertEquals(ThemeLook.DEFAULT_INTENSITY, look.intensity, 0.0)
        assertEquals(ThemeTexture.Denim, look.texture)
        assertEquals(listOf(0.25, 0.4), listOf(look.translucency, look.grain))
        assertEquals(ThemeStop(ThemeColor(0.5, 0.5, 0.5, 1.0), 0.2, 0.8), look.stops[0])
        assertEquals(look, ThemeLook.from(mapOf("stops" to List(5) { stop }, "texture" to "denim", "translucency" to 0.25, "grain" to 0.4)))
    }

    @Test
    fun texturesMatchTheMacPixelForPixel() {
        val expected = mapOf(
            ThemeTexture.Grain to Triple(287662L, 2224329757L, listOf(42, 4, 37, 17, 53, 43, 32, 41)),
            ThemeTexture.Sand to Triple(1429150L, 168941593L, listOf(86, 50, 83, 67, 93, 87, 79, 86)),
            ThemeTexture.Denim to Triple(653735L, 1283743958L, listOf(63, 52, 30, 29, 65, 63, 29, 30)),
            ThemeTexture.Tweed to Triple(1227414L, 45628609L, listOf(74, 69, 73, 71, 75, 74, 73, 74)),
        )
        for ((texture, values) in expected) {
            val alphas = ThemeTextures.alphas(texture).map { it.toInt() and 0xFF }
            var hash = 2166136261L
            for (v in alphas) hash = ((hash xor v.toLong()) * 16777619L) and 0xFFFFFFFFL
            assertEquals("$texture sum", values.first, alphas.sumOf { it.toLong() })
            assertEquals("$texture hash", values.second, hash)
            assertEquals("$texture start", values.third, alphas.take(8))
        }
    }
}
