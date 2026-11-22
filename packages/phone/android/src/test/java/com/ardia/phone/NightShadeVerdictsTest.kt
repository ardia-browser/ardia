package com.ardia.phone

import android.content.Context
import com.ardia.browser.NightShadeVerdict
import com.ardia.browser.NightShadeVerdictUse
import com.ardia.browser.NightShadeMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NightShadeVerdictsTest {
    private class Memory : NightShadeVerdicts.Storage {
        var text: String? = null
        var writes = 0

        override fun read(): String? = text

        override fun write(text: String?) {
            this.text = text
            writes += 1
        }
    }

    private val storage = Memory()
    private var clock = 1_000L

    private fun store(limit: Int = NightShadeVerdicts.LIMIT) = NightShadeVerdicts(storage, limit) { clock }

    @Test
    fun aVerdictIsKeptAcrossLaunchesAndSaysWhetherItWasNewOrChanged() {
        val verdicts = store()
        assertEquals(NightShadeVerdictUse.Learned, verdicts.remember("yahoo.com", false, NightShadeVerdict.Light))
        assertNull("the same verdict again changes nothing", verdicts.remember("yahoo.com", false, NightShadeVerdict.Light))
        assertEquals(NightShadeVerdict.Light, store().verdict("yahoo.com", false))
        assertEquals(NightShadeVerdictUse.Corrected, verdicts.remember("yahoo.com", false, NightShadeVerdict.Dark))
        assertEquals(NightShadeVerdict.Dark, store().verdict("yahoo.com", false))
        assertNull(store().verdict("github.com", false))
    }

    @Test
    fun pastTheCapTheLeastRecentlyUsedHostGoesFirst() {
        val verdicts = store(limit = 3)
        for (host in listOf("a.example", "b.example", "c.example")) {
            clock += 1_000
            verdicts.remember(host, false, NightShadeVerdict.Light)
        }
        clock += 1_000
        verdicts.verdict("a.example", false)
        clock += 1_000
        verdicts.remember("d.example", false, NightShadeVerdict.Dark)
        assertEquals(listOf("c.example", "a.example", "d.example"), verdicts.hosts(false))
        assertNull(verdicts.verdict("b.example", false))
        assertEquals(listOf("c.example", "a.example", "d.example"), store().hosts(false))
    }

    @Test
    fun aLaunchKeepsTheUseOrderAndTheCap() {
        val verdicts = store(limit = 2)
        verdicts.remember("a.example", false, NightShadeVerdict.Light)
        clock += NightShadeVerdicts.SAVE_USE_AFTER_MILLIS
        verdicts.remember("b.example", false, NightShadeVerdict.Light)
        clock += NightShadeVerdicts.SAVE_USE_AFTER_MILLIS
        verdicts.verdict("a.example", false)
        assertEquals(listOf("b.example", "a.example"), store(limit = 2).hosts(false))
        assertEquals(listOf("a.example"), store(limit = 1).hosts(false))
    }

    @Test
    fun usingAVerdictSavesAtMostOnceAMinute() {
        val verdicts = store()
        verdicts.remember("a.example", false, NightShadeVerdict.Light)
        val afterRemember = storage.writes
        clock += 1_000
        verdicts.verdict("a.example", false)
        assertEquals(afterRemember, storage.writes)
        clock += NightShadeVerdicts.SAVE_USE_AFTER_MILLIS
        verdicts.verdict("a.example", false)
        assertEquals(afterRemember + 1, storage.writes)
    }

    @Test
    fun privateVerdictsStayInMemoryAndEndWithPrivateBrowsing() {
        val verdicts = store()
        assertEquals(NightShadeVerdictUse.Learned, verdicts.remember("secret.example", true, NightShadeVerdict.Light))
        assertEquals(NightShadeVerdict.Light, verdicts.verdict("secret.example", true))
        assertNull("a private verdict never reaches a regular tab", verdicts.verdict("secret.example", false))
        assertNull("nothing private is written", storage.text)
        assertEquals(0, storage.writes)
        verdicts.endPrivateBrowsing()
        assertNull(verdicts.verdict("secret.example", true))
    }

    @Test
    fun clearingHistoryForgetsTheVerdictsUsedInItsRange() {
        val verdicts = store()
        verdicts.remember("old.example", false, NightShadeVerdict.Light)
        clock = 50_000L
        verdicts.remember("today.example", false, NightShadeVerdict.Dark)
        verdicts.remember("private.example", true, NightShadeVerdict.Light)
        verdicts.forget(since = 40_000L)
        assertEquals(listOf("old.example"), verdicts.hosts(false))
        assertEquals(emptyList<String>(), verdicts.hosts(true))
        assertEquals(listOf("old.example"), store().hosts(false))
        clock = 60_000L
        verdicts.verdict("old.example", false)
        verdicts.forget(since = 55_000L)
        assertEquals("a verdict used inside the range goes too", emptyList<String>(), verdicts.hosts(false))
        verdicts.remember("again.example", false, NightShadeVerdict.Light)
        verdicts.forget(since = null)
        assertEquals(emptyList<String>(), store().hosts(false))
        assertNull(storage.text)
    }

    @Test
    fun aDamagedSaveStartsEmpty() {
        storage.text = "{not json"
        assertEquals(emptyList<String>(), store().hosts(false))
        storage.text = """[["a.example","light",5],["b.example","sepia",6],[7],["c.example","dark",4]]"""
        assertEquals(listOf("c.example", "a.example"), store().hosts(false))
    }

    @Test
    fun siteSettingsKeyVerdictsByTheSiteAndClearThemWithPrivateBrowsing() {
        val preferences = RuntimeEnvironment.getApplication().getSharedPreferences("night-shade-verdicts-test", Context.MODE_PRIVATE).also { it.edit().clear().commit() }
        val sites = PhoneSitePreferences(preferences)
        assertEquals(NightShadeVerdictUse.Learned, sites.rememberNightShadeVerdict("www.Yahoo.com", false, NightShadeVerdict.Light))
        assertEquals(NightShadeVerdict.Light, sites.nightShadeVerdict("yahoo.com", false))
        assertEquals(NightShadeVerdict.Light, PhoneSitePreferences(preferences).nightShadeVerdict("https://www.yahoo.com/news", false))
        assertNull(sites.nightShadeVerdict(null, false))
        sites.rememberNightShadeVerdict("secret.example", true, NightShadeVerdict.Dark)
        sites.setSiteNightShade("secret.example", true, NightShadeMode.Always)
        sites.endPrivateBrowsing()
        assertNull(sites.nightShadeVerdict("secret.example", true))
        sites.forgetNightShadeVerdicts(null)
        assertNull(PhoneSitePreferences(preferences).nightShadeVerdict("yahoo.com", false))
    }
}
