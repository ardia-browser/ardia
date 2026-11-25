package com.ardia.browser.android

import androidx.compose.ui.graphics.Color
import com.ardia.browser.android.system.WidgetColors
import com.ardia.design.ProfileLook
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class WidgetColorsTest {
    private val look = ProfileLook.of("plum")

    @Test
    fun everyColourOfAWidgetComesFromTheSameDarkChoice() {
        val dark = WidgetColors.of(look, dark = true, themed = true)
        val light = WidgetColors.of(look, dark = false, themed = true)
        assertEquals(Color.White, dark.label)
        assertEquals(Color.Black, light.label)
        assertEquals(Color(0xFF0A84FF), dark.accent)
        assertEquals(Color(0xFF007AFF), light.accent)
        assertEquals(look.backdropColors(true, true), dark.backdrop)
        assertEquals(look.backdropColors(false, true), light.backdrop)
        assertEquals(if (look.inkIsLight(true, themed = true)) Color.White else WidgetColors.INK_ON_LIGHT, dark.ink)
        assertNotEquals(dark.backdrop, light.backdrop)
    }

    @Test
    fun thePillIsAnOpaqueBlendNotATintThatALauncherCanDrop() {
        val colors = WidgetColors.of(look, dark = true, themed = true)
        assertEquals(1f, colors.capsule.alpha, 0.001f)
        val backdrop = colors.backdrop.last()
        val expected = Color(
            red = backdrop.red + (colors.ink.red - backdrop.red) * WidgetColors.CAPSULE_SHARE,
            green = backdrop.green + (colors.ink.green - backdrop.green) * WidgetColors.CAPSULE_SHARE,
            blue = backdrop.blue + (colors.ink.blue - backdrop.blue) * WidgetColors.CAPSULE_SHARE,
        )
        assertEquals(expected.red, colors.capsule.red, 0.01f)
        assertEquals(expected.green, colors.capsule.green, 0.01f)
        assertEquals(expected.blue, colors.capsule.blue, 0.01f)
    }

    @Test
    fun thePanelIsTwoOpaqueStopsAndTheirDirectionForEachMode() {
        val themed = ProfileLook.of("green", listOf("#4F7CFF", "#9B6BFF"), null)
        for (dark in listOf(false, true)) {
            val colors = WidgetColors.of(themed, dark = dark, themed = true)
            val stops = themed.backdropColors(dark, true)
            assertEquals(stops.first(), colors.panelTop)
            assertEquals(stops.last(), colors.panelBottom)
            assertEquals(themed.showsTheme(dark, true), colors.panelDiagonal)
        }
        val softened = WidgetColors.of(look, dark = false, themed = false, softened = true)
        assertEquals(1f, softened.panelTop.alpha, 0.001f)
        val plain = look.backdropColors(false, false).first()
        assertEquals(plain.red + (1f - plain.red) * WidgetColors.LIGHT_SOFTENING, softened.panelTop.red, 0.01f)
    }

    @Test
    fun aWidgetCarriesBothModesSoTheLauncherPicksWithoutTheApp() {
        val pair = WidgetColors.dayNight(look, themed = true)
        assertEquals(WidgetColors.of(look, dark = false, themed = true), pair.day)
        assertEquals(WidgetColors.of(look, dark = true, themed = true), pair.night)
        assertEquals(WidgetColors.Resolver.Launcher, WidgetColors.resolver(31))
        assertEquals(WidgetColors.Resolver.App, WidgetColors.resolver(30))
    }
}
