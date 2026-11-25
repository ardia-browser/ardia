package com.ardia.phone

import android.content.Intent
import android.net.Uri
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncOfferTest {
    private val app = RuntimeEnvironment.getApplication()

    @After
    fun real() {
        SyncOffer.forTests = null
    }

    @Test
    fun theBuildsSwitchIsTheLabFlagUnlessATestSaysOtherwise() {
        assertEquals("a lab build offers sync, a release build doesn't", PhoneLab.isOn, SyncOffer.isOffered)
        SyncOffer.forTests = false
        assertEquals(false, SyncOffer.isOffered)
    }

    @Test
    fun aBuildThatDoesNotOfferSyncNeverStartsIt() {
        SyncOffer.forTests = false
        val refused = runCatching { PhoneSync.controller(app) }.exceptionOrNull()
        assertTrue("no sync controller, so no loop, no background work and the identity left unused: $refused", refused is SyncOffer.NotOffered)
    }

    @Test
    fun aBuildThatDoesNotOfferSyncCancelsWhatAComposeTesterLeftQueuedAndAnOfferingBuildLeavesItAlone() {
        val cancelled = ArrayList<String>()
        SyncOffer.forTests = true
        SyncOffer.retireBackground { cancelled += it }
        assertTrue(cancelled.isEmpty())
        SyncOffer.forTests = false
        SyncOffer.retireBackground { cancelled += it }
        assertEquals(listOf("ardia-sync", "ardia-sync-flush"), cancelled)
    }

    private fun link(uri: String): Map<String, Any?>? = PhoneSystemLinks.link(Intent(Intent.ACTION_VIEW, Uri.parse(uri)))

    @Test
    fun theMacTabsLinkIsOnlyTakenWhenSyncIsOffered() {
        SyncOffer.forTests = true
        assertEquals("macTabs", link("ardia://mac-tabs")?.get("kind"))
        SyncOffer.forTests = false
        assertNull("a shortcut or widget link into sync does nothing", link("ardia://mac-tabs"))
        assertEquals("search", link("ardia://search")?.get("kind"))
    }
}
