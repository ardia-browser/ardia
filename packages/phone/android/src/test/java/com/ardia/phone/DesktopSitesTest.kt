package com.ardia.phone

import com.ardia.browser.DesktopSites
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DesktopSitesTest {
    @Test
    fun enteringAHostWithADesktopSitePreferenceSwitchesToIt() {
        assertEquals(true, DesktopSites.onEnter(host = "docs.example", lastHost = "news.example", current = false, preference = true))
        assertEquals(false, DesktopSites.onEnter(host = "docs.example", lastHost = null, current = true, preference = false))
    }

    @Test
    fun noPreferenceTheSameModeOrStayingOnTheHostChangesNothing() {
        assertNull(DesktopSites.onEnter(host = "docs.example", lastHost = "news.example", current = false, preference = null))
        assertNull(DesktopSites.onEnter(host = "docs.example", lastHost = "news.example", current = true, preference = true))
        assertNull("a toggle on the same host is the user's", DesktopSites.onEnter(host = "docs.example", lastHost = "docs.example", current = false, preference = true))
        assertNull(DesktopSites.onEnter(host = null, lastHost = "docs.example", current = false, preference = true))
    }

    @Test
    fun hostsCompareAsTheSitePreferencesKeyThem() {
        assertNull(DesktopSites.onEnter(host = "www.Docs.example", lastHost = "docs.example", current = false, preference = true))
    }
}
