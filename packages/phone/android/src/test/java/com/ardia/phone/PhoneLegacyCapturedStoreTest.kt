package com.ardia.phone

import android.content.Context
import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PhoneLegacyCapturedStoreTest {
    private val app: Context = RuntimeEnvironment.getApplication()
    private val data: File get() = UpgradeGate.dataDir(app)

    @Before
    fun placeTheComposeAppsStore() {
        listOf("databases", "shared_prefs", "cache/TabSnapshots").forEach { File(data, it).deleteRecursively() }
        UpgradeGate.forgetForTests()
        for (name in FILES) {
            val stream = javaClass.getResourceAsStream("$FIXTURE/$name") ?: error("$FIXTURE/$name is missing")
            val target = File(data, name).apply { parentFile?.mkdirs() }
            stream.use { input -> target.outputStream().use(input::copyTo) }
        }
    }

    @After
    fun forget() {
        listOf("databases", "shared_prefs").forEach { File(data, it).deleteRecursively() }
        UpgradeGate.forgetForTests()
    }

    @Test
    fun aStoreTheComposeAppWroteIsReadyToImport() {
        val source = PhoneLegacy(app).source()
        assertEquals("pending", source["kind"])
        assertEquals(mapOf("tabs" to 3.0, "archive" to 0.0, "visits" to 5.0), source["counts"])
    }

    @Test
    fun itsTabsComeAcrossWithTheirAddressesAndTitlesAndNoPrivateTab() {
        val read = PhoneLegacy(app).read()
        @Suppress("UNCHECKED_CAST")
        val tabs = read["tabs"] as List<Map<String, Any?>>
        assertEquals(
            setOf(
                "https://en.wikipedia.org/wiki/Otter" to "Otter - Wikipedia",
                "https://example.com/" to "Example Domain",
                "https://text.npr.org/" to "NPR : National Public Radio",
            ),
            tabs.map { it["url"] to it["title"] }.toSet(),
        )
        assertEquals(emptyList<Any>(), read["archive"])
        assertTrue(tabs.any { it["id"] == read["selectedTabId"] })
    }

    @Test
    fun itsHistoryIncludesALinkThatWasNeverATab() {
        @Suppress("UNCHECKED_CAST")
        val visits = PhoneLegacy(app).readVisits(0, 100)["visits"] as List<Map<String, Any?>>
        assertEquals(5, visits.size)
        assertTrue(visits.any { it["url"] == "https://en.wikipedia.org/wiki/Enhydra" })
    }

    @Test
    fun theSettingsTheUserChangedComeAcross() {
        @Suppress("UNCHECKED_CAST")
        val preferences = PhoneLegacy(app).read()["preferences"] as Map<String, String>
        assertEquals("duckduckgo", preferences["browsing.searchEngine"])
    }

    private companion object {
        const val FIXTURE = "compose-store-1e343bb81"
        val FILES = listOf(
            "databases/browser.db",
            "databases/browser.db-wal",
            "databases/browser.db-shm",
            "shared_prefs/ardia.browser.xml",
            "shared_prefs/ardia.blocking.xml",
        )
    }
}
