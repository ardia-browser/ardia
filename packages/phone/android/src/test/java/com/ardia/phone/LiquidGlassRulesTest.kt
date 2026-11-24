package com.ardia.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

class LiquidGlassRulesTest {
    private val params = LiquidGlassRules.defaults

    @Test
    fun theLensNeedsAndroid13GlassAndBlurAndNoFlatFlag() {
        assertEquals(LiquidGlassRules.Render.Lens, LiquidGlassRules.render(sdk = 34, classic = false, flat = false, blurs = true))
        assertEquals(LiquidGlassRules.Render.Lens, LiquidGlassRules.render(sdk = 33, classic = false, flat = false, blurs = true))
        assertEquals("Android 12 has blur but no runtime shaders", LiquidGlassRules.Render.Frost, LiquidGlassRules.render(sdk = 32, classic = false, flat = false, blurs = true))
        assertEquals("the lab's comparison flag", LiquidGlassRules.Render.Frost, LiquidGlassRules.render(sdk = 34, classic = false, flat = true, blurs = true))
        assertEquals("below Android 12 there is no blur", LiquidGlassRules.Render.Solid, LiquidGlassRules.render(sdk = 30, classic = false, flat = false, blurs = true))
        assertEquals("over budget, look off or reduce transparency", LiquidGlassRules.Render.Solid, LiquidGlassRules.render(sdk = 34, classic = false, flat = false, blurs = false))
        assertEquals(LiquidGlassRules.Render.Classic, LiquidGlassRules.render(sdk = 34, classic = true, flat = false, blurs = true))
    }

    @Test
    fun theLensIsOnlyAddedToALiveBlurLayer() {
        assertTrue(LiquidGlassRules.lensWanted(sdk = 34, classic = false, flat = false, livePath = true))
        assertFalse("a fallback or tinted fill has no layer to refract", LiquidGlassRules.lensWanted(sdk = 34, classic = false, flat = false, livePath = false))
        assertFalse(LiquidGlassRules.lensWanted(sdk = 34, classic = true, flat = false, livePath = true))
        assertFalse(LiquidGlassRules.lensWanted(sdk = 32, classic = false, flat = false, livePath = true))
        assertFalse(LiquidGlassRules.lensWanted(sdk = 34, classic = false, flat = true, livePath = true))
    }

    @Test
    fun glassOverAPageRecordsThePageOnlyWhenTheLabAsksOnAndroid13() {
        assertFalse("recording the page under the bar tripled the F4's janky frames", LiquidGlassRules.pageLive(sdk = 34, classic = false, overPageAsked = false))
        assertTrue(LiquidGlassRules.pageLive(sdk = 34, classic = false, overPageAsked = true))
        assertTrue(LiquidGlassRules.pageLive(sdk = 33, classic = false, overPageAsked = true))
        assertFalse("Android 12 keeps the solid page mode the M3 needed", LiquidGlassRules.pageLive(sdk = 32, classic = false, overPageAsked = true))
        assertFalse(LiquidGlassRules.pageLive(sdk = 34, classic = true, overPageAsked = true))
        assertTrue(LiquidGlassRules.overPageAsked(mapOf("ArdiaGlassOverPage" to true)))
        assertFalse(LiquidGlassRules.overPageAsked(LaunchExtras.arguments(mapOf("ArdiaGlassOverPage" to true), allowed = false)))
    }

    @Test
    fun theRimLightsEveryGlassFromAndroid13ButClassicFlatAndTheFlatFill() {
        assertTrue(LiquidGlassRules.rimWanted(sdk = 34, classic = false, flat = false, blurs = true))
        assertFalse(LiquidGlassRules.rimWanted(sdk = 32, classic = false, flat = false, blurs = true))
        assertFalse(LiquidGlassRules.rimWanted(sdk = 34, classic = true, flat = false, blurs = true))
        assertFalse(LiquidGlassRules.rimWanted(sdk = 34, classic = false, flat = true, blurs = true))
        assertFalse("look off or over the look budget draw the flat fill, so no rim", LiquidGlassRules.rimWanted(sdk = 34, classic = false, flat = false, blurs = false))
    }

    @Test
    fun theShiftBoundIsWorkedOutOnceForTheSameGeometry() {
        val bound = LensBound()
        bound.measure(132, 132, 2.75f)
        val first = bound.shiftDp
        repeat(10) { bound.measure(132, 132, 2.75f) }
        assertEquals(1, bound.computed)
        assertEquals(first, bound.shiftDp, 0f)
        assertEquals(LiquidGlassRules.maxShiftDp(params, LiquidGlassRules.bezelDp(params, 48f, 48f)), first, 0.0001f)
        bound.measure(640, 132, 2.75f)
        assertEquals("a new size is measured again", 2, bound.computed)
        bound.measure(640, 132, 2.75f)
        assertEquals(2, bound.computed)
    }

    @Test
    fun flatGlassIsOnlyAskedForByItsLaunchArgument() {
        assertTrue(LiquidGlassRules.flatAsked(mapOf("ArdiaFlatGlass" to true)))
        assertFalse(LiquidGlassRules.flatAsked(mapOf("ArdiaFlatGlass" to "true")))
        assertFalse(LiquidGlassRules.flatAsked(emptyMap()))
        assertFalse("a store build passes no arguments", LiquidGlassRules.flatAsked(LaunchExtras.arguments(mapOf("ArdiaFlatGlass" to true), allowed = false)))
    }

    @Test
    fun theBezelShrinksOnSmallShapes() {
        assertEquals(params.bezelDp, LiquidGlassRules.bezelDp(params, 300f, 48f), 0.001f)
        assertEquals(params.bezelDp, LiquidGlassRules.bezelDp(params, 48f, 48f), 0.001f)
        assertEquals(9f, LiquidGlassRules.bezelDp(params, 30f, 30f), 0.001f)
        assertEquals(0f, LiquidGlassRules.bezelDp(params, 0f, 40f), 0.001f)
    }

    @Test
    fun theHeightProfileRisesFromTheEdgeToAFlatTop() {
        assertTrue(LiquidGlassRules.profile(0f) < 0.02f)
        assertEquals(1f, LiquidGlassRules.profile(1f), 0.001f)
        assertEquals("steep at the edge, capped", params.maxSlope, LiquidGlassRules.slope(0f, params.maxSlope), 0.001f)
        assertEquals("flat on top", 0f, LiquidGlassRules.slope(1f, params.maxSlope), 0.001f)
        assertTrue(LiquidGlassRules.slope(0.25f, params.maxSlope) > LiquidGlassRules.slope(0.75f, params.maxSlope))
    }

    @Test
    fun aFlatSurfaceDoesNotBendAndADenserGlassBendsMore() {
        assertEquals(0f, LiquidGlassRules.shiftRatio(0f, 1.5f), 0.0001f)
        assertEquals("air does not bend", 0f, LiquidGlassRules.shiftRatio(3f, 1.0001f), 0.001f)
        assertTrue(LiquidGlassRules.shiftRatio(3f, 1.6f) > LiquidGlassRules.shiftRatio(3f, 1.4f))
        assertTrue(LiquidGlassRules.shiftRatio(5f, 1.5f) > LiquidGlassRules.shiftRatio(1f, 1.5f))
    }

    @Test
    fun theLayerMarginCoversTheBlurAndTheLargestShift() {
        val bezel = LiquidGlassRules.bezelDp(params, 48f, 48f)
        val shift = LiquidGlassRules.maxShiftDp(params, bezel)
        assertTrue("the lens moves the backdrop", shift > 1f)
        assertTrue("but never past the middle of a 48 pt button", shift < 24f)
        val density = 2.75f
        for (blur in floatArrayOf(0f, 4f, 33f)) {
            val margin = LiquidGlassRules.marginPx(blur, shift * density)
            assertTrue(margin >= blur * 2f)
            assertTrue(margin >= shift * density)
        }
        assertEquals("without a lens the margin is the frost's own", 66f, LiquidGlassRules.marginPx(33f, 0f), 0.001f)
    }

    @Test
    fun theShapeSitsInsideTheDownscaledLayerAfterItsMargin() {
        val density = 2.75f
        val bound = LensBound().measure(132, 132, density)
        val shape = LiquidGlassRules.lensShape(widthPx = 132, heightPx = 132, marginPx = 66f, scale = 5f, radiusPx = 66f, density = density, bezelDp = bound.bezelDp, shiftDp = bound.shiftDp)
        assertEquals(13.2f, shape.left, 0.001f)
        assertEquals(13.2f, shape.top, 0.001f)
        assertEquals(39.6f, shape.right, 0.001f)
        assertEquals(39.6f, shape.bottom, 0.001f)
        assertEquals(13.2f, shape.radius, 0.001f)
        assertEquals(LiquidGlassRules.CIRCULAR_CORNER_EXPONENT, shape.exponent, 0f)
        assertEquals(params.bezelDp * density / 5f, shape.bezel, 0.001f)
        assertEquals(params.depthDp * density / 5f, shape.depth, 0.001f)
        assertTrue("the shader's cap fits the margin", shape.maxShift <= shape.left)
        val wide = LensBound().measure(800, 132, density)
        val capsule = LiquidGlassRules.lensShape(widthPx = 800, heightPx = 132, marginPx = 66f, scale = 5f, radiusPx = 999f, density = density, bezelDp = wide.bezelDp, shiftDp = wide.shiftDp)
        assertEquals("a radius past half the short side is a capsule", 13.2f, capsule.radius, 0.001f)
    }

    @Test
    fun theRimIsLitFromTheTopLeftAndSoftenedInDark() {
        val (x, y) = LiquidGlassRules.light(params.lightAngle)
        assertTrue(x < 0f && y < 0f)
        assertEquals(1f, x * x + y * y, 0.0001f)
        val light = LiquidGlassRules.rim(132, 132, 66f, 2.75f, dark = false)
        val dark = LiquidGlassRules.rim(132, 132, 66f, 2.75f, dark = true)
        assertTrue(dark.opacity < light.opacity)
        assertTrue("at least a pixel wide", light.band >= 1f)
        assertTrue(abs(light.band - params.specularWidthDp * 2.75f) < 0.001f)
    }

    @Test
    fun theShadersNeverNameAVariableAfterAnAgslType() {
        val types = "float|float2|float3|float4|half|half2|half3|half4|int|bool|shader"
        val reserved = Regex("\\b(?:$types)\\s+(?:$types)\\b")
        for (source in listOf(LiquidGlassRules.LENS_SHADER, LiquidGlassRules.RIM_SHADER)) assertFalse(reserved.find(source)?.value, reserved.containsMatchIn(source))
    }

    @Test
    fun theShadersNameEveryUniformTheyAreGiven() {
        for (name in listOf("backdrop", "box", "radius", "exponent", "bezel", "depth", "maxShift", "ior", "dispersion", "maxSlope")) {
            assertTrue(name, LiquidGlassRules.LENS_SHADER.contains("uniform") && Regex("uniform \\w+ $name;").containsMatchIn(LiquidGlassRules.LENS_SHADER))
        }
        for (name in listOf("box", "radius", "exponent", "light", "band", "strength", "opposite", "falloff", "sharpness", "opacity")) {
            assertTrue(name, Regex("uniform \\w+ $name;").containsMatchIn(LiquidGlassRules.RIM_SHADER))
        }
    }
}
