package com.ardia.phone

import com.ardia.sync.SyncSnapshot
import com.ardia.sync.SyncedLook
import com.ardia.sync.syncJson
import kotlinx.serialization.decodeFromString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GlassRulesTest {
    @Test
    fun classicOrReduceTransparencyDrawTheSolidSurface() {
        assertTrue(GlassRules.solid("classic", reduceTransparency = false))
        assertTrue(GlassRules.solid("glass", reduceTransparency = true))
        assertTrue(GlassRules.solid(null, reduceTransparency = true))
        assertFalse(GlassRules.solid("glass", reduceTransparency = false))
        assertFalse("glass is the default, as on iPhone", GlassRules.solid(null, reduceTransparency = false))
    }

    @Test
    fun capsulesAndCirclesRoundToHalfTheShortSideAndRoundedTakesItsRadius() {
        assertEquals(24f, GlassRules.radiusDp("capsule", 0f, 200f, 48f))
        assertEquals(24f, GlassRules.radiusDp("circle", 0f, 48f, 48f))
        assertEquals("no shape is a capsule", 22f, GlassRules.radiusDp(null, 10f, 300f, 44f))
        assertEquals(26f, GlassRules.radiusDp("rounded", 26f, 300f, 400f))
        assertEquals(0f, GlassRules.radiusDp("rounded", -4f, 300f, 400f))
    }

    @Test
    fun classicFillsWithTheSystemBackgroundOrTheSpacesSurfaceWhenTinted() {
        assertEquals(0xFFFFFFFF.toInt(), GlassRules.classicFill(tinted = false, dark = false, lookSurface = 0xFF123456.toInt()))
        assertEquals(0xFF000000.toInt(), GlassRules.classicFill(tinted = false, dark = true, lookSurface = 0xFF123456.toInt()))
        assertEquals(0xFF123456.toInt(), GlassRules.classicFill(tinted = true, dark = true, lookSurface = 0xFF123456.toInt()))
    }

    @Test
    fun classicTakesTheAppsChromeFillSoAndroidsDarkChromeStaysItsNearBlack() {
        val chrome = GlassRules.chromeFill(mapOf("fill" to mapOf("dynamic" to mapOf("light" to "#FFFFFF", "dark" to "#1E1B1D"))))
        assertEquals(0xFFFFFFFF.toInt() to 0xFF1E1B1D.toInt(), chrome)
        assertEquals(0xFF1E1B1D.toInt(), GlassRules.classicFill(tinted = false, dark = true, lookSurface = 0xFF123456.toInt(), chromeFill = chrome))
        assertEquals(0xFFFFFFFF.toInt(), GlassRules.classicFill(tinted = false, dark = false, lookSurface = 0xFF123456.toInt(), chromeFill = chrome))
        assertEquals("a tinted surface keeps the space's colour", 0xFF123456.toInt(), GlassRules.classicFill(tinted = true, dark = true, lookSurface = 0xFF123456.toInt(), chromeFill = chrome))
        assertEquals(0xFF1E1B1D.toInt() to 0xFF1E1B1D.toInt(), GlassRules.chromeFill(mapOf("fill" to "#1E1B1D")))
        assertEquals("CSS order: alpha last", 0x80102030.toInt(), GlassRules.hex("#10203080"))
        assertNull(GlassRules.chromeFill(mapOf("fill" to "rgba(0,0,0,0.5)")))
        assertNull(GlassRules.chromeFill(mapOf("edge" to "#000000")))
        assertNull(GlassRules.chromeFill(null))
    }

    @Test
    fun classicsEdgeIsTheLabelAtTwelvePercentAndItsShadowDarkerInDark() {
        assertEquals(0x1F, GlassRules.classicEdge(dark = false) ushr 24)
        assertEquals(0x000000, GlassRules.classicEdge(dark = false) and 0xFFFFFF)
        assertEquals(0xFFFFFF, GlassRules.classicEdge(dark = true) and 0xFFFFFF)
        assertEquals(0x1F, GlassRules.classicShadow(dark = false) ushr 24)
        assertEquals(0x66, GlassRules.classicShadow(dark = true) ushr 24)
    }

    @Test
    fun theSurfaceFadesInOnlyWhenItAppearsOnScreenWithAnimationsOn() {
        assertTrue(GlassRules.fadesIn(wasShown = false, shown = true, attached = true, durationMs = 200f, animatorsOn = true))
        assertFalse("hiding is at once", GlassRules.fadesIn(wasShown = true, shown = false, attached = true, durationMs = 200f, animatorsOn = true))
        assertFalse("off screen", GlassRules.fadesIn(wasShown = false, shown = true, attached = false, durationMs = 200f, animatorsOn = true))
        assertFalse("no duration", GlassRules.fadesIn(wasShown = false, shown = true, attached = true, durationMs = 0f, animatorsOn = true))
        assertFalse("animations off in the system", GlassRules.fadesIn(wasShown = false, shown = true, attached = true, durationMs = 200f, animatorsOn = false))
    }

    @Test
    fun theMacsLookArrivesInTheSyncViewAsOnIPhone() {
        val decoded = syncJson.decodeFromString<SyncSnapshot>("""{"devices":[],"profiles":[],"look":{"interfaceStyle":"classic","appearance":"dark"},"syncedAt":5}""")
        assertEquals(SyncedLook("classic", "dark"), decoded.look)
        assertEquals(mapOf("interfaceStyle" to "classic", "appearance" to "dark"), SyncPayloads.view(decoded, null, emptyList())["look"])
        assertNull("no look from an older Mac", SyncPayloads.view(syncJson.decodeFromString<SyncSnapshot>("""{"devices":[],"profiles":[]}"""), null, emptyList())["look"])
        assertEquals("an unknown value is left out", mapOf("interfaceStyle" to null, "appearance" to "light"), SyncPayloads.look(SyncedLook("liquid", "light")))
        assertNull(SyncPayloads.look(SyncedLook("liquid", "sepia")))
    }
}
