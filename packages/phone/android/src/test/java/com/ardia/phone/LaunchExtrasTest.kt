package com.ardia.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LaunchExtrasTest {
    private val extras = mapOf<String, Any?>(
        "ArdiaDemo" to true,
        "BrowseQuery" to "otters",
        "BrowseTab" to 2,
        "BrowseDelay" to 1.5f,
        "BrowseDeckOpen" to 3L,
        "ArdiaColor" to "  green ",
        "com.ardia.phone.PAGE_LAB" to true,
        "unrelated" to "x",
        "BrowseOverlay" to null,
    )

    @Test
    fun aLabOrTestBuildPassesEveryArdiaAndBrowseExtraAsItCame() {
        assertEquals(
            mapOf("ArdiaDemo" to true, "BrowseQuery" to "otters", "BrowseTab" to 2.0, "BrowseDelay" to 1.5, "BrowseDeckOpen" to 3.0, "ArdiaColor" to "  green "),
            LaunchExtras.arguments(extras, allowed = true),
        )
    }

    @Test
    fun aStoreBuildPassesNone() {
        assertEquals(emptyMap<String, Any>(), LaunchExtras.arguments(extras, allowed = false))
        assertFalse(LaunchExtras.isDemo(extras, allowed = false))
    }

    @Test
    fun ardiaDemoTurnsTheSyncDemoOnAsTheComposeAppReadsTheFlag() {
        assertTrue(LaunchExtras.isDemo(mapOf("ArdiaDemo" to true), allowed = true))
        assertTrue(LaunchExtras.isDemo(mapOf("ArdiaDemo" to "1"), allowed = true))
        assertFalse(LaunchExtras.isDemo(mapOf("ArdiaDemo" to "false"), allowed = true))
        assertFalse(LaunchExtras.isDemo(mapOf("ArdiaDemo" to "no"), allowed = true))
        assertFalse(LaunchExtras.isDemo(emptyMap(), allowed = true))
        assertTrue(LaunchExtras.isDemo(mapOf(PhoneSync.DEMO_EXTRA to true), allowed = true))
    }
}
