package com.ardia.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PageProcessRecoveryTest {
    @Test
    fun shownPageReloadsAtOnceAndCountsItsRecovery() {
        val recovery = PageProcessRecovery()
        assertEquals(PageProcessRecovery.Step.Reload, recovery.processEnded(shown = true))
        assertEquals(PageProcessOutcome.Recovered, recovery.loadFinished())
        assertNull(recovery.loadFinished())
    }

    @Test
    fun hiddenPageWaitsForTheNextLoadAndNeverShowsTheFailure() {
        val recovery = PageProcessRecovery()
        assertEquals(PageProcessRecovery.Step.Wait, recovery.processEnded(shown = false))
        assertEquals(PageProcessRecovery.Step.Wait, recovery.processEnded(shown = false))
        assertTrue(recovery.awaitsReload)
        recovery.navigationAsked()
        assertTrue(recovery.isReloading)
        assertFalse(recovery.awaitsReload)
        assertEquals(PageProcessOutcome.Recovered, recovery.loadFinished())
    }

    @Test
    fun secondDeathWhileReloadingShowsTheFailure() {
        val recovery = PageProcessRecovery()
        assertEquals(PageProcessRecovery.Step.Reload, recovery.processEnded(shown = true))
        assertEquals(PageProcessRecovery.Step.ShowFailure, recovery.processEnded(shown = true))
        assertEquals(PageProcessRecovery.Step.Reload, recovery.processEnded(shown = true))
    }

    @Test
    fun reloadEndedWhileHiddenWaitsInsteadOfFailing() {
        val recovery = PageProcessRecovery()
        assertEquals(PageProcessRecovery.Step.Reload, recovery.processEnded(shown = true))
        assertEquals(PageProcessRecovery.Step.Wait, recovery.processEnded(shown = false))
        assertTrue(recovery.awaitsReload)
        assertFalse(recovery.isReloading)
    }

    @Test
    fun failedLoadEndsTheRecoveryWithoutCountingIt() {
        val recovery = PageProcessRecovery()
        recovery.processEnded(shown = true)
        recovery.loadFailed()
        assertNull(recovery.loadFinished())
    }
}
