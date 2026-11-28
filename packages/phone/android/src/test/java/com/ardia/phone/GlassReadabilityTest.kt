package com.ardia.phone

import androidx.compose.ui.graphics.toArgb
import com.ardia.design.FrostedStyle
import com.ardia.design.LookFrosting
import com.ardia.design.ProfileLook
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GlassReadabilityTest {
    private val tokens = File("../../../apps/phone/src/components/ui/tokens.ts").readText()

    private fun block(start: String): String {
        val at = tokens.indexOf(start)
        assertTrue("$start is in tokens.ts", at >= 0)
        return tokens.substring(at, tokens.indexOf("\n}", at).takeIf { it > at } ?: tokens.length)
    }

    private fun parse(colour: String): GlassReadability.Ink {
        val functional = Regex("rgba?\\(([^)]*)\\)").matchEntire(colour.trim())
        if (functional != null) {
            val parts = functional.groupValues[1].split(",").map { it.trim().toDouble() }
            return GlassReadability.Ink(parts[0] / 255, parts[1] / 255, parts[2] / 255, parts.getOrElse(3) { 1.0 })
        }
        val hex = colour.trim().removePrefix("#")
        fun channel(index: Int) = hex.substring(index * 2, index * 2 + 2).toInt(16) / 255.0
        return GlassReadability.Ink(channel(0), channel(1), channel(2), if (hex.length == 8) channel(3) else 1.0)
    }

    private fun field(text: String, name: String): String = Regex("\\b$name: \"([^\"]+)\"").find(text)!!.groupValues[1]

    private val chromeLine: String get() = tokens.substring(tokens.indexOf("export const chromeInk")).substringBefore("} as const;")

    private val inksOnDark: List<Pair<String, GlassReadability.Ink>> get() = listOf(
        "chromeInk.dark.foreground" to parse(field(chromeLine.substringAfter("dark:"), "foreground")),
        "toastLabel dark" to parse(field(block("const darkRoles"), "toastLabel")),
        "darkRoles.label" to parse(field(block("const darkRoles"), "label")),
    )

    private val inksOnLight: List<Pair<String, GlassReadability.Ink>> get() = listOf(
        "chromeInk.light.foreground" to parse(field(chromeLine.substringAfter("light:"), "foreground")),
        "toastLabel light" to parse(field(block("const lightRoles"), "toastLabel")),
        "lightRoles.label" to parse(field(block("const lightRoles"), "label")),
    )

    private fun channels(colour: Int) = doubleArrayOf(((colour shr 16) and 0xFF) / 255.0, ((colour shr 8) and 0xFF) / 255.0, (colour and 0xFF) / 255.0)

    private fun reads(ink: GlassReadability.Ink, plate: Int): Double {
        val (red, green, blue) = channels(plate).toList()
        return GlassReadability.reads(ink, red, green, blue)
    }

    private fun assertReads(plate: Int, dark: Boolean, what: String) {
        for ((name, ink) in if (dark) inksOnDark else inksOnLight) {
            val contrast = reads(ink, plate)
            assertTrue("$name on $what (plate #${Integer.toHexString(plate)}) reads $contrast", contrast >= GlassReadability.READABLE_CONTRAST)
        }
    }

    private val opaqueWhite = 0xFFFFFFFF.toInt()
    private val opaqueBlack = 0xFF000000.toInt()
    private val backdrops = listOf(opaqueWhite, opaqueBlack, 0xFF808080.toInt(), 0xFF7A0010.toInt(), 0xFFFFE600.toInt(), 0xFF00C8FF.toInt())

    private val lookTints: List<Int?> = listOf(null, 0x26B25B6B, 0x59F4D7E0, 0x80FFFFFF.toInt(), 0x666B2D5C, 0x26000000)

    private val looks = listOf(null, ProfileLook.of("blue"), ProfileLook.of("pink"), ProfileLook.incognito)

    private val variants: List<Pair<String, FrostedStyle>> get() = buildList {
        add("glass" to FrostedStyle.glass)
        add("thin" to FrostedStyle.thin)
        looks.forEachIndexed { index, look ->
            add("bar look $index" to (look?.let(LookFrosting::bar) ?: FrostedStyle.bar))
            add("sheet look $index" to (look?.let(LookFrosting::sheet) ?: FrostedStyle.sheet))
        }
    }

    private fun tintOf(style: FrostedStyle, dark: Boolean, look: Int?): Int {
        val styled = style.tint.resolve(dark).toArgb()
        return look?.let { GlassReadability.over(it, styled) } ?: styled
    }

    @Test
    fun theInksAreTheAppsOwnReadFromTokens() {
        assertEquals(GlassReadability.lightInk, inksOnDark[0].second)
        assertEquals(GlassReadability.darkInk.copy(alpha = 0.9), inksOnLight[0].second)
        assertEquals(GlassReadability.Ink(1.0, 1.0, 1.0, 1.0), inksOnDark[1].second)
        assertEquals(GlassReadability.Ink(0.0, 0.0, 0.0, 1.0), inksOnLight[1].second)
        assertEquals(GlassReadability.Ink(1.0, 1.0, 1.0, 1.0), inksOnDark[2].second)
        assertEquals(GlassReadability.Ink(0.0, 0.0, 0.0, 1.0), inksOnLight[2].second)
    }

    @Test
    fun theBoundsAreTheOnesThePhoneUiLiftsItsInkFor() {
        val shared = File("../../../apps/phone/src/lib/readableInk.ts").readText()
        val plateInk = Regex("PLATE_INK = \\{([^}]+)\\}").find(shared)!!.groupValues[1]
        assertEquals(GlassReadability.lightInk, parse(field(plateInk, "onDark")))
        assertEquals(GlassReadability.darkInk, parse(field(plateInk, "onLight")))
        assertEquals(GlassReadability.READABLE_CONTRAST, Regex("PLATE_CONTRAST = ([0-9.]+)").find(shared)!!.groupValues[1].toDouble(), 0.0)
    }

    @Test
    fun theBoundsLeaveEveryInkAtFiveToOneWhateverTheHue() {
        assertTrue("ceiling ${GlassReadability.ceiling}", GlassReadability.ceiling > 0.08 && GlassReadability.ceiling < 0.11)
        assertTrue("floor ${GlassReadability.floor}", GlassReadability.floor > 0.2 && GlassReadability.floor < 0.32)
        assertTrue(GlassReadability.ceiling <= GlassReadability.grayBound(GlassReadability.lightInk, dark = true))
        assertTrue(GlassReadability.floor >= GlassReadability.grayBound(GlassReadability.darkInk, dark = false))
        val steps = (0..8).map { it / 8.0 }
        for (red in steps) for (green in steps) for (blue in steps) {
            val dark = GlassReadability.pull(red, green, blue, GlassReadability.ceiling, 0.0)
            for ((name, ink) in inksOnDark) assertTrue("$name over ($red,$green,$blue) pulled down", GlassReadability.reads(ink, dark[0], dark[1], dark[2]) >= 5.0)
            val light = GlassReadability.pull(red, green, blue, 1.0, GlassReadability.floor)
            for ((name, ink) in inksOnLight) assertTrue("$name over ($red,$green,$blue) pulled up", GlassReadability.reads(ink, light[0], light[1], light[2]) >= 5.0)
        }
    }

    @Test
    fun theLivePlateReadsOverWhiteAndBlackForEveryVariantAndLookTint() {
        for ((name, style) in variants) for (look in lookTints) for (dark in listOf(true, false)) for (backdrop in backdrops) {
            val tint = tintOf(style, dark, look)
            val plate = GlassReadability.readable(GlassReadability.over(tint, GlassReadability.saturated(backdrop, style.saturation)), GlassReadability.steady(dark))
            assertReads(plate, dark, "live $name tint $look dark $dark over #${Integer.toHexString(backdrop)}")
        }
    }

    @Test
    fun theVeilWithoutAShaderReadsOverTheWorstPage() {
        for ((name, style) in variants) for (look in lookTints) for (dark in listOf(true, false)) {
            val veil = GlassReadability.veil(tintOf(style, dark, look), dark)
            for (backdrop in backdrops) assertReads(GlassReadability.over(veil, backdrop), dark, "veil $name tint $look dark $dark over #${Integer.toHexString(backdrop)}")
        }
    }

    @Test
    fun flatHeldAndTintedPlatesRead() {
        for ((name, style) in variants) for (look in lookTints) for (dark in listOf(true, false)) for (backdrop in backdrops) {
            val tint = tintOf(style, dark, look)
            val limit = GlassReadability.steady(dark)
            val held = GlassReadability.plateFill(GlassReadability.over(tint, backdrop), dark, limit)
            assertReads(held, dark, "held $name tint $look over #${Integer.toHexString(backdrop)}")
            val fallback = style.fallback.resolve(dark).toArgb()
            val flat = GlassReadability.plateFill(look?.let { GlassReadability.over(it, fallback) } ?: fallback, dark, limit)
            assertReads(GlassReadability.over(flat, backdrop), dark, "fallback $name tint $look over #${Integer.toHexString(backdrop)}")
            val sampled = FrostTint.frosted(backdrop, style.saturation, style.tint.resolve(dark).toArgb())
            val tinted = GlassReadability.readable(look?.let { GlassReadability.over(it, sampled) } ?: sampled, limit)
            assertReads(tinted, dark, "deck-tinted $name tint $look over #${Integer.toHexString(backdrop)}")
        }
    }

    @Test
    fun everyFrameOfAToneChangeKeepsTheNewInkReadable() {
        for (dark in listOf(true, false)) for (backdrop in backdrops) {
            val tint = tintOf(FrostedStyle.glass, dark, null)
            var since = 0L
            while (since <= GlassReadability.TONE_EASE_MS + 30) {
                val plate = GlassReadability.readable(GlassReadability.over(tint, GlassReadability.saturated(backdrop, FrostedStyle.glass.saturation)), GlassReadability.toneLimit(dark, since))
                assertReads(plate, dark, "tone change at $since ms dark $dark over #${Integer.toHexString(backdrop)}")
                since += 30
            }
            assertEquals(GlassReadability.steady(dark), GlassReadability.toneLimit(dark, GlassReadability.TONE_EASE_MS))
        }
        assertTrue(GlassReadability.easing(0))
        assertFalse(GlassReadability.easing(GlassReadability.TONE_EASE_MS))
    }

    @Test
    fun aPlateThatAlreadyReadsIsLeftExactlyAsItWas() {
        val calm = listOf(0xFF1C1C1E.toInt(), 0xFF2A2030.toInt(), 0xFF000000.toInt(), 0xFF3A3A3C.toInt(), 0xFF101828.toInt())
        for (plate in calm) assertEquals(plate, GlassReadability.readable(plate, GlassReadability.steady(dark = true)))
        val bright = listOf(0xFFFFFFFF.toInt(), 0xFFF2F2F7.toInt(), 0xFFB0B0B0.toInt(), 0xFFFFE600.toInt())
        for (plate in bright) assertEquals(plate, GlassReadability.readable(plate, GlassReadability.steady(dark = false)))
        val readyVeils = listOf(true to FrostedStyle.sheet.fallback.resolve(true).toArgb(), false to FrostedStyle.sheet.fallback.resolve(false).toArgb(), true to 0xF0000000.toInt())
        for ((dark, fill) in readyVeils) assertEquals(fill, GlassReadability.veil(fill, dark))
        val darkGlassOverBlack = GlassReadability.over(tintOf(FrostedStyle.glass, true, null), opaqueBlack)
        assertFalse(GlassReadability.pulls(darkGlassOverBlack, dark = true))
        assertEquals(darkGlassOverBlack, GlassReadability.readable(darkGlassOverBlack, GlassReadability.steady(true)))
        val lightGlassOverWhite = GlassReadability.over(tintOf(FrostedStyle.glass, false, null), opaqueWhite)
        assertEquals(lightGlassOverWhite, GlassReadability.readable(lightGlassOverWhite, GlassReadability.steady(false)))
    }

    @Test
    fun theDarkGlassOverAWhitePageIsPulledDownTheBug() {
        val plate = GlassReadability.over(tintOf(FrostedStyle.glass, true, null), opaqueWhite)
        assertTrue("the 1.0.3 plate is near white", GlassReadability.luminanceOf(plate) > 0.8)
        assertTrue(GlassReadability.pulls(plate, dark = true))
        val shown = GlassReadability.readable(plate, GlassReadability.steady(true))
        assertTrue(GlassReadability.luminanceOf(shown) <= GlassReadability.ceiling)
        assertReads(shown, true, "the toast over a white page")
    }

    @Test
    fun theShaderUsesTheSameMathAsTheChecksAbove() {
        val shader = GlassReadability.SHADER
        assertTrue(shader.contains("float3(0.2126, 0.7152, 0.0722)"))
        assertTrue(shader.contains("float3(2.2)"))
        assertTrue(shader.contains("float3(1.0 / 2.2)"))
        assertTrue(shader.contains("lin *= upper / max(light, 0.0001);"))
        assertTrue(shader.contains("lin += (1.0 - lin) * ((lower - light) / max(1.0 - light, 0.0001));"))
        assertTrue("the tint is laid over the plate before the bound", shader.indexOf("colour = tint + colour * (1.0 - tint.a);") < shader.indexOf("float light"))
    }

    @Test
    fun theRimOnlyLightsARingThinnerThanTheSmallestTextInset() {
        assertTrue(LiquidGlassRules.RIM_SHADER.contains("float inner = 1.0 - smoothstep(band, band + ${LiquidGlassRules.EDGE_FEATHER_PX}, inward);"))
        val padding = Regex("verticalPadding: (\\d+)").find(tokens.substring(tokens.indexOf("export const toastLayout")))!!.groupValues[1].toFloat()
        for (density in listOf(1f, 1.5f, 2f, 2.75f, 3f, 3.5f, 4f)) {
            val rim = LiquidGlassRules.rim(400, 120, 60f, density, dark = true)
            val reachDp = (rim.band + LiquidGlassRules.EDGE_FEATHER_PX) / density
            assertTrue("the rim reaches $reachDp dp in at $density", reachDp < padding)
        }
    }
}
