package com.ardia.phone

import android.content.res.Configuration
import org.junit.Assert.assertEquals
import org.junit.Test

class SchemeChangesTest {
    private val orange = mapOf("light" to mapOf("primary" to "#8E4C32"), "dark" to mapOf("primary" to "#FFB59A"))
    private val teal = mapOf("light" to mapOf("primary" to "#006A60"), "dark" to mapOf("primary" to "#53DBC9"))
    private val day = Configuration.UI_MODE_NIGHT_NO
    private val night = Configuration.UI_MODE_NIGHT_YES

    @Test
    fun aWallpaperCallbackBeforeThePaletteLandsSendsNothingAndTheLaterCheckSendsOnce() {
        var system = orange
        val sent = mutableListOf<String>()
        val changes = SchemeChanges({ system }) { sent += it }
        changes.read()
        changes.check("wallpaper")
        system = teal
        changes.check("wallpaper")
        changes.check("wallpaper")
        assertEquals(listOf("wallpaper"), sent)
    }

    @Test
    fun aConfigurationChangeThatMovesThePaletteReportsTheWallpaperAndANightFlipReportsNight() {
        var system = orange
        val sent = mutableListOf<String>()
        val changes = SchemeChanges({ system }) { sent += it }
        changes.read()
        changes.configuration(day)
        system = teal
        changes.configuration(day)
        changes.configuration(night)
        changes.configuration(night)
        assertEquals(listOf("wallpaper", "night"), sent)
    }

    @Test
    fun belowAndroid12ThereIsNothingToReport() {
        val sent = mutableListOf<String>()
        val changes = SchemeChanges({ null }) { sent += it }
        changes.read()
        changes.configuration(day)
        changes.check("wallpaper")
        assertEquals(emptyList<String>(), sent)
    }
}
