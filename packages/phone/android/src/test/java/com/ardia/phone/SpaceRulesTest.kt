package com.ardia.phone

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SpaceRulesTest {
    @Test
    fun aSpaceColourResolvesAsTheSystemColourInLightAndDark() {
        assertEquals(mapOf("light" to "#007AFF", "dark" to "#0A84FF"), SpaceRules.colour("Blue"))
        assertEquals(mapOf("light" to "#AF52DE", "dark" to "#BF5AF2"), SpaceRules.colour("violet"))
        assertEquals("a hex colour is the same in both", mapOf("light" to "#12AB34", "dark" to "#12AB34"), SpaceRules.colour("#12ab34"))
        assertNull(SpaceRules.colour("chartreuse"))
        assertNull(SpaceRules.colour(""))
        assertNull(SpaceRules.colour("#12345"))
    }

    @Test
    fun aMenuShowsTheSpacesSymbolFilledOrItsInitialInACircle() {
        assertEquals("star.fill", SpaceRules.menuSymbol("Work", "star"))
        assertEquals("star.fill", SpaceRules.menuSymbol("Work", "star.fill"))
        val initial = SpaceRules.menuSymbol("work", null)
        assertEquals(true, initial == "w.circle.fill" || initial == "circle.fill")
        assertEquals("an unknown icon is the initial", initial, SpaceRules.menuSymbol("work", "not.a.symbol"))
        assertNull(SpaceRules.symbol("not.a.symbol"))
        assertNull(SpaceRules.symbol(null))
    }

    @Test
    fun theGlyphTakesTheFirstLetterOrAnEmoji() {
        assertEquals("W", SpaceRules.initial("  work"))
        assertEquals("•", SpaceRules.initial("   "))
        assertEquals("😀", SpaceRules.initial("😀 party"))
        assertEquals("🏠", SpaceRules.emoji("🏠"))
        assertNull(SpaceRules.emoji("ab"))
        assertNull("a long text isn't an emoji", SpaceRules.emoji("🏠🏠🏠"))
        assertNull(SpaceRules.emoji(null))
    }

    @Test
    fun theBackdropTonesWashTheSwatchTowardTheBackgroundAsIPhonesDo() {
        val light = SpaceRules.tones("blue", emptyList(), null, dark = false, increasedContrast = false)
        val dark = SpaceRules.tones("blue", emptyList(), null, dark = true, increasedContrast = false)
        assertEquals(2, light.size)
        assertNotEquals(light, dark)
        assertEquals("light tones are near white", true, light.all { it.red > 0.75f && it.green > 0.75f && it.blue > 0.75f })
        assertEquals("dark tones are near black", true, dark.all { it.red < 0.35f && it.green < 0.35f && it.blue < 0.35f })
        val themed = SpaceRules.tones(null, listOf("#FF0000", "#00FF00", "#0000FF"), null, dark = false, increasedContrast = false)
        assertEquals("a theme gives one tone a colour", 3, themed.size)
        val themedDark = SpaceRules.tones(null, listOf("#FF0000"), listOf("#330000"), dark = true, increasedContrast = false)
        assertEquals("a dark theme is only lightly washed", true, themedDark.single().red > Color(0xFF330000).red * 0.5f)
    }

    @Test
    fun tilesFillRowsOfFourAndFewerTilesShareOneRow() {
        assertEquals(listOf(0 until 3), SpaceRules.rows(3))
        assertEquals(listOf(0 until 4, 4 until 6), SpaceRules.rows(6))
        assertEquals(emptyList<IntRange>(), SpaceRules.rows(0))
        assertEquals(3, SpaceRules.columns(3))
        assertEquals(4, SpaceRules.columns(9))
        assertEquals("example.com", SpaceRules.tileLabel("", "https://example.com/a"))
        assertEquals("Mail", SpaceRules.tileLabel("Mail", "https://example.com/a"))
    }
}
