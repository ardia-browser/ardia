package com.ardia.browser

import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.concurrent.atomic.AtomicInteger
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NightShadeStartTest {
    private val preferences = RecordingPreferences(NightShadeMode.Always)
    private val harness = PageHarness(preferences)
    private val server = harness.server
    private val host = "127.0.0.1"
    private val served = AtomicInteger()

    @After
    fun tearDown() = harness.close()

    private fun site(background: String) {
        server.route("/page") {
            val load = served.incrementAndGet()
            TestServer.Response(
                body = "<html><head><title>Loading</title></head><body style=\"background:$background\">" +
                    "<script>window.__shadedAtBody = !!document.getElementById('ardia-night-shade')</script>" +
                    "<p>Text</p>" +
                    "<script>onload = () => setTimeout(() => document.title = '$load:' + (window.__shadedAtBody ? 'early' : 'late') + ':' + !!document.getElementById('ardia-night-shade'), 0)</script>" +
                    "</body></html>",
            )
        }
        server.page("/hop", "<html><body><script>location.href = '/page'</script></body></html>")
    }

    private fun titleOf(page: Page, load: Int): String =
        harness.await(page.state) { it.title.startsWith("$load:") && !it.isLoading }.title.substringAfter(':')

    @Test
    fun aLightSiteSeenOnceIsShadedBeforeItsBodyRunsWhenTypedReloadedOrFollowed() {
        site("#fff")
        val page = harness.open("tab", "/page")
        assertEquals("the first visit still ends shaded", "true", titleOf(page, 1).substringAfter(':'))
        harness.poll { preferences.verdicts[host]?.takeIf { it == NightShadeVerdict.Light } }
        harness.load(page, "/page")
        assertEquals("typed again", "early:true", titleOf(page, 2))
        onMain { page.reload() }
        assertEquals("reloaded", "early:true", titleOf(page, 3))
        harness.load(page, "/hop")
        assertEquals("through a script's navigation", "early:true", titleOf(page, 4))
    }

    @Test
    fun aDarkSiteIsLearnedAndLeftAloneFromTheStart() {
        site("#111")
        val page = harness.open("tab", "/page")
        assertEquals("false", titleOf(page, 1).substringAfter(':'))
        harness.poll { preferences.verdicts[host]?.takeIf { it == NightShadeVerdict.Dark } }
        harness.load(page, "/page")
        assertEquals("late:false", titleOf(page, 2))
    }

    @Test
    fun aSiteThatTurnedDarkIsMeasuredAgainAndCorrected() {
        preferences.verdicts[host] = NightShadeVerdict.Light
        site("#111")
        val page = harness.open("tab", "/page")
        assertEquals("the remembered verdict shades it at first, and the measurement takes it off", "early:false", titleOf(page, 1))
        harness.poll { preferences.verdicts[host]?.takeIf { it == NightShadeVerdict.Dark } }
        harness.load(page, "/page")
        assertEquals("late:false", titleOf(page, 2))
    }

    @Test
    fun withNightShadeOffNothingIsShadedWhateverWasRemembered() {
        preferences.nightShade = NightShadeMode.Disabled
        preferences.verdicts[host] = NightShadeVerdict.Light
        site("#fff")
        val page = harness.open("tab", "/page")
        assertEquals("late:false", titleOf(page, 1))
    }
}
