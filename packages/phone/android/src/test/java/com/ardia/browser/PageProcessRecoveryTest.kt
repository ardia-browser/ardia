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
        recovery.reloadStarted()
        assertEquals(PageProcessOutcome.Recovered, recovery.loadFinished())
        assertNull(recovery.loadFinished())
    }

    @Test
    fun reloadStaysPendingUntilItReallyStarts() {
        val recovery = PageProcessRecovery()
        assertEquals(PageProcessRecovery.Step.Reload, recovery.processEnded(shown = true))
        assertTrue(recovery.awaitsReload)
        assertFalse(recovery.isReloading)
        assertNull(recovery.loadFinished())
        recovery.reloadStarted()
        assertFalse(recovery.awaitsReload)
        assertTrue(recovery.isReloading)
    }

    @Test
    fun hiddenPageWaitsForTheNextLoadAndNeverShowsTheFailure() {
        val recovery = PageProcessRecovery()
        assertEquals(PageProcessRecovery.Step.Wait, recovery.processEnded(shown = false))
        assertEquals(PageProcessRecovery.Step.Wait, recovery.processEnded(shown = false))
        assertTrue(recovery.awaitsReload)
        recovery.reloadStarted()
        assertTrue(recovery.isReloading)
        assertFalse(recovery.awaitsReload)
        assertEquals(PageProcessOutcome.Recovered, recovery.loadFinished())
    }

    @Test
    fun secondDeathWhileReloadingShowsTheFailure() {
        val recovery = PageProcessRecovery()
        assertEquals(PageProcessRecovery.Step.Reload, recovery.processEnded(shown = true))
        recovery.reloadStarted()
        assertEquals(PageProcessRecovery.Step.ShowFailure, recovery.processEnded(shown = true))
        assertEquals(PageProcessRecovery.Step.Reload, recovery.processEnded(shown = true))
    }

    @Test
    fun reloadEndedWhileHiddenWaitsInsteadOfFailing() {
        val recovery = PageProcessRecovery()
        assertEquals(PageProcessRecovery.Step.Reload, recovery.processEnded(shown = true))
        recovery.reloadStarted()
        assertEquals(PageProcessRecovery.Step.Wait, recovery.processEnded(shown = false))
        assertTrue(recovery.awaitsReload)
        assertFalse(recovery.isReloading)
    }

    @Test
    fun startWithNothingPendingCountsNothing() {
        val recovery = PageProcessRecovery()
        recovery.reloadStarted()
        assertFalse(recovery.isReloading)
        assertNull(recovery.loadFinished())
    }

    @Test
    fun failedLoadEndsTheRecoveryWithoutCountingIt() {
        val recovery = PageProcessRecovery()
        recovery.processEnded(shown = true)
        recovery.reloadStarted()
        recovery.loadFailed()
        assertNull(recovery.loadFinished())
    }
}
