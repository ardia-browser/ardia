package com.ardia.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PageNightBindingTest {
    private class Look(val night: Boolean)

    private class Engine {
        var systemNight = false
        private var cache: Look? = null
        val pages = mutableListOf<Look>()
        var redraws = 0
        val reports = mutableListOf<Boolean>()
        val binding = PageNightBinding(
            resolve = { cache?.takeIf { it.night == systemNight } ?: Look(systemNight).also { cache = it } },
            nightOf = { it.night },
            rebind = { look -> pages.replaceAll { look } },
            redraw = { redraws++ },
            report = { reports += it },
        )

        fun openPage() {
            pages += binding.forNewPage()
        }
    }

    @Test
    fun aTabOpenedBeforeThePostedSwitchRunsStillLeavesEveryPageOnTheNewNight() {
        val engine = Engine()
        engine.binding.apply()
        engine.openPage()
        engine.systemNight = true
        engine.openPage()
        engine.binding.apply()
        assertTrue(engine.pages.all { it.night })
        assertEquals(1, engine.redraws)
        assertEquals(listOf(false, true), engine.reports)
    }

    @Test
    fun aSwitchRebindsOpenPagesRedrawsOnceAndReportsOnce() {
        val engine = Engine()
        engine.binding.apply()
        engine.openPage()
        engine.openPage()
        engine.systemNight = true
        engine.binding.apply()
        engine.binding.apply()
        assertTrue(engine.pages.all { it.night })
        assertEquals(1, engine.redraws)
        assertEquals(listOf(false, true), engine.reports)
    }

    @Test
    fun nothingChangesWhenTheNightStaysTheSame() {
        val engine = Engine()
        engine.binding.apply()
        engine.openPage()
        engine.binding.apply()
        assertEquals(0, engine.redraws)
        assertEquals(listOf(false), engine.reports)
    }
}
