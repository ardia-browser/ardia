package com.ardia.phone

import android.content.Context
import com.ardia.browser.SiteOrigin
import com.ardia.browser.SitePermission
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SitePermissionStoreTest {
    private val preferences = RuntimeEnvironment.getApplication().getSharedPreferences("site-permissions-test", Context.MODE_PRIVATE).also { it.edit().clear().commit() }
    private var clock = 1_000L

    private fun store(held: (SitePermission) -> Boolean = { true }) = SitePermissionStore(preferences, held) { clock }

    @Test
    fun anAnswerIsKeptAcrossLaunchesUnderTheSitesOrigin() {
        store().remember("https://Meet.Google.com:443/", "meet.google.com", SitePermission.Camera)
        val again = store()
        assertEquals(listOf(SiteGrant("https://meet.google.com", "meet.google.com", setOf(SiteCapability.Camera), 1_000L)), again.grants)
        assertTrue(again.allows("https://meet.google.com/", SitePermission.Camera))
        assertFalse("another port is another site", again.allows("https://meet.google.com:8443", SitePermission.Camera))
        assertFalse("http is another site", again.allows("http://meet.google.com", SitePermission.Camera))
    }

    @Test
    fun cameraAndMicrophoneTogetherIsTwoPermissionsAndEachAloneIsAllowedAfter() {
        val sites = store()
        sites.remember("https://meet.google.com", "meet.google.com", SitePermission.CameraAndMicrophone)
        assertTrue(sites.allows("https://meet.google.com", SitePermission.Camera))
        assertTrue(sites.allows("https://meet.google.com", SitePermission.Microphone))
        assertTrue(sites.allows("https://meet.google.com", SitePermission.CameraAndMicrophone))
        assertFalse(sites.allows("https://meet.google.com", SitePermission.Location))
    }

    @Test
    fun aSecondAnswerJoinsTheFirstAndMovesItsTime() {
        val sites = store()
        sites.remember("https://maps.example", "maps.example", SitePermission.Microphone)
        clock = 2_000L
        sites.remember("https://maps.example", "maps.example", SitePermission.Location)
        assertEquals(setOf(SiteCapability.Microphone, SiteCapability.Location), sites.grants.single().permissions)
        assertEquals(2_000L, sites.grants.single().grantedAt)
    }

    @Test
    fun withoutAndroidsOwnPermissionAKeptAnswerAsksAgain() {
        var cameraHeld = false
        val sites = store { permission -> permission != SitePermission.Camera || cameraHeld }
        sites.remember("https://meet.google.com", "meet.google.com", SitePermission.Camera)
        assertFalse(sites.allows("https://meet.google.com", SitePermission.Camera))
        cameraHeld = true
        assertTrue(sites.allows("https://meet.google.com", SitePermission.Camera))
    }

    @Test
    fun revokingOnePermissionKeepsTheOthersAndTheLastRemovesTheSite() {
        val sites = store()
        sites.remember("https://meet.google.com", "meet.google.com", SitePermission.CameraAndMicrophone)
        assertEquals(setOf(SiteCapability.Camera), sites.revoke("https://meet.google.com", SiteCapability.Camera))
        assertFalse(sites.allows("https://meet.google.com", SitePermission.Camera))
        assertTrue(sites.allows("https://meet.google.com", SitePermission.Microphone))
        assertEquals("a permission the site doesn't hold is refused", emptySet<SiteCapability>(), sites.revoke("https://meet.google.com", SiteCapability.Location))
        assertEquals(setOf(SiteCapability.Microphone), sites.revoke("https://meet.google.com", SiteCapability.Microphone))
        assertTrue(sites.grants.isEmpty())
        assertTrue("and it stays gone after a relaunch", store().grants.isEmpty())
    }

    @Test
    fun revokingEverythingForASiteLeavesOtherSitesAlone() {
        val sites = store()
        sites.remember("https://a.example", "a.example", SitePermission.Location)
        sites.remember("https://b.example", "b.example", SitePermission.CameraAndMicrophone)
        assertEquals(setOf(SiteCapability.Camera, SiteCapability.Microphone), sites.revoke("https://b.example", null))
        assertEquals(listOf("https://a.example"), sites.grants.map { it.origin })
        assertEquals(emptySet<SiteCapability>(), sites.revoke("https://nowhere.example", null))
    }

    @Test
    fun theListIsInHostOrderAsIPhonesIs() {
        val sites = store()
        for (host in listOf("zoom.us", "a.example", "meet.google.com")) sites.remember("https://$host", host, SitePermission.Microphone)
        assertEquals(listOf("a.example", "meet.google.com", "zoom.us"), sites.grants.map { it.host })
    }

    @Test
    fun pastTheLimitTheOldestOtherSiteGoes() {
        val sites = store()
        for (index in 0 until SitePermissionStore.LIMIT) {
            clock = 10_000L + index
            sites.remember("https://site$index.example", "site$index.example", SitePermission.Location)
        }
        clock = 99_000L
        sites.remember("https://newest.example", "newest.example", SitePermission.Location)
        assertEquals(SitePermissionStore.LIMIT, sites.grants.size)
        assertFalse(sites.grants.any { it.origin == "https://site0.example" })
        assertTrue(sites.grants.any { it.origin == "https://newest.example" })
    }

    @Test
    fun aDamagedStoreStartsEmptyRatherThanFailing() {
        preferences.edit().putString(SitePermissionStore.KEY, "{not json").commit()
        assertTrue(store().grants.isEmpty())
        preferences.edit().putString(SitePermissionStore.KEY, """[{"origin":"https://a.example","host":"a.example","permissions":["teleport"],"grantedAt":1}]""").commit()
        assertTrue("a site with no known permission is dropped", store().grants.isEmpty())
    }

    @Test
    fun originsAreTheSchemeHostAndAnyPortThatIsntTheDefault() {
        assertEquals("https://example.com", SiteOrigin.of("https://EXAMPLE.com/path?q=1"))
        assertEquals("http://localhost:8765", SiteOrigin.of("http://localhost:8765/"))
        assertEquals("http://example.com", SiteOrigin.of("http://example.com:80"))
        assertNull(SiteOrigin.of("about:blank"))
        assertNull(SiteOrigin.of("not a url"))
        assertTrue(SiteOrigin.overlaps(SitePermission.CameraAndMicrophone, setOf(SitePermission.Microphone)))
        assertFalse(SiteOrigin.overlaps(SitePermission.Camera, setOf(SitePermission.Microphone, SitePermission.Location)))
    }
}
