package com.ardia.phone

import android.content.res.Configuration
import android.util.Printer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LookBudgetLayoutTest {
    private class Logging : MessageLogging {
        var printer: Printer? = null
        override fun current() = printer
        override fun set(printer: Printer?) {
            this.printer = printer
        }
    }

    private class Reports : FrameReports {
        override fun start(report: (Double, Double, Double, Int) -> Unit) = Unit
        override fun stop() = Unit
    }

    private fun config(landscape: Boolean) = Configuration().apply {
        orientation = if (landscape) Configuration.ORIENTATION_LANDSCAPE else Configuration.ORIENTATION_PORTRAIT
        screenWidthDp = if (landscape) 872 else 392
        screenHeightDp = if (landscape) 392 else 872
    }

    private fun running(results: MutableList<FrameSampler.Sample?>): SampleSession {
        val session = SampleSession(Logging(), Reports(), { 0L }, 8.3) { results += it }
        FrameSampler.begin(session, 2000) { _, _ -> }
        return session
    }

    @Test
    fun theBudgetIsSampledOnlyInPortrait() {
        assertTrue(LookBudget.samplesIn(Configuration.ORIENTATION_PORTRAIT))
        assertTrue(LookBudget.samplesIn(Configuration.ORIENTATION_UNDEFINED))
        assertFalse("a landscape deck never judges the verdict portrait's deck uses", LookBudget.samplesIn(Configuration.ORIENTATION_LANDSCAPE))
    }

    @Test
    fun turningTheScreenDropsTheSampleUnderWay() {
        LookBudget.configurationChanged(config(landscape = false))
        val results = mutableListOf<FrameSampler.Sample?>()
        running(results)
        LookBudget.configurationChanged(config(landscape = true))
        assertEquals("a sample spanning a rotation is dropped, never recorded", 1, results.size)
        assertNull(results.single())
        assertFalse(FrameSampler.cancel())
        LookBudget.configurationChanged(config(landscape = false))
    }

    @Test
    fun aLightDarkChangeLeavesTheSampleAlone() {
        LookBudget.configurationChanged(config(landscape = false))
        val results = mutableListOf<FrameSampler.Sample?>()
        running(results)
        LookBudget.configurationChanged(config(landscape = false).apply { uiMode = Configuration.UI_MODE_NIGHT_YES })
        assertTrue(results.isEmpty())
        assertTrue(FrameSampler.cancel())
    }
}
