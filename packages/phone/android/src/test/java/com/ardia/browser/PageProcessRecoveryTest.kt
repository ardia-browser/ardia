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
        assertEquals(PageProcessRecovery.Step.Reload, recovery.processEnded(shown = true, now = 0L))
        recovery.reloadStarted()
        assertEquals(PageProcessOutcome.Recovered, recovery.loadFinished(now = 0L))
        assertNull(recovery.loadFinished(now = 0L))
    }

    @Test
    fun reloadStaysPendingUntilItReallyStarts() {
        val recovery = PageProcessRecovery()
        assertEquals(PageProcessRecovery.Step.Reload, recovery.processEnded(shown = true, now = 0L))
        assertTrue(recovery.awaitsReload)
        assertFalse(recovery.isReloading)
        assertNull(recovery.loadFinished(now = 0L))
        recovery.reloadStarted()
        assertFalse(recovery.awaitsReload)
        assertTrue(recovery.isReloading)
    }

    @Test
    fun hiddenPageWaitsForTheNextLoadAndNeverShowsTheFailure() {
        val recovery = PageProcessRecovery()
        assertEquals(PageProcessRecovery.Step.Wait, recovery.processEnded(shown = false, now = 0L))
        assertEquals(PageProcessRecovery.Step.Wait, recovery.processEnded(shown = false, now = 0L))
        assertTrue(recovery.awaitsReload)
        recovery.reloadStarted()
        assertTrue(recovery.isReloading)
        assertFalse(recovery.awaitsReload)
        assertEquals(PageProcessOutcome.Recovered, recovery.loadFinished(now = 0L))
    }

    @Test
    fun secondDeathWhileReloadingShowsTheFailure() {
        val recovery = PageProcessRecovery()
        assertEquals(PageProcessRecovery.Step.Reload, recovery.processEnded(shown = true, now = 0L))
        recovery.reloadStarted()
        assertEquals(PageProcessRecovery.Step.ShowFailure, recovery.processEnded(shown = true, now = 0L))
        assertEquals(PageProcessRecovery.Step.Reload, recovery.processEnded(shown = true, now = 0L))
    }

    @Test
    fun reloadEndedWhileHiddenWaitsInsteadOfFailing() {
        val recovery = PageProcessRecovery()
        assertEquals(PageProcessRecovery.Step.Reload, recovery.processEnded(shown = true, now = 0L))
        recovery.reloadStarted()
        assertEquals(PageProcessRecovery.Step.Wait, recovery.processEnded(shown = false, now = 0L))
        assertTrue(recovery.awaitsReload)
        assertFalse(recovery.isReloading)
    }

    @Test
    fun startWithNothingPendingCountsNothing() {
        val recovery = PageProcessRecovery()
        recovery.reloadStarted()
        assertFalse(recovery.isReloading)
        assertNull(recovery.loadFinished(now = 0L))
    }

    @Test
    fun failedLoadEndsTheRecoveryWithoutCountingIt() {
        val recovery = PageProcessRecovery()
        recovery.processEnded(shown = true, now = 0L)
        recovery.reloadStarted()
        recovery.loadFailed()
        assertNull(recovery.loadFinished(now = 0L))
    }

    @Test
    fun pageThatKeepsDyingRightAfterItsRecoveryReloadsOnlyOnce() {
        val recovery = PageProcessRecovery()
        var reloads = 0
        var failures = 0
        for (cycle in 0 until 5) {
            val start = cycle * 2_000L
            when (recovery.processEnded(shown = true, now = start)) {
                PageProcessRecovery.Step.Reload -> {
                    reloads += 1
                    recovery.reloadStarted()
                    recovery.loadFinished(now = start + 1_000L)
                }
                PageProcessRecovery.Step.ShowFailure -> failures += 1
                PageProcessRecovery.Step.Wait -> Unit
            }
            if (failures > 0) break
        }
        assertEquals(1, reloads)
        assertEquals(1, failures)
        assertFalse(recovery.awaitsReload)
        assertFalse(recovery.isReloading)
    }

    @Test
    fun deathLongAfterTheRecoveryGetsItsOwnReload() {
        val recovery = PageProcessRecovery()
        assertEquals(PageProcessRecovery.Step.Reload, recovery.processEnded(shown = true, now = 0L))
        recovery.reloadStarted()
        assertEquals(PageProcessOutcome.Recovered, recovery.loadFinished(now = 1_000L))
        assertEquals(PageProcessRecovery.Step.Reload, recovery.processEnded(shown = true, now = 1_000L + PageProcessRecovery.RETRY_WINDOW_MS))
    }

    @Test
    fun tryAgainGivesThePageAnotherAutomaticReload() {
        val recovery = PageProcessRecovery()
        recovery.processEnded(shown = true, now = 0L)
        recovery.reloadStarted()
        recovery.loadFinished(now = 1_000L)
        assertEquals(PageProcessRecovery.Step.ShowFailure, recovery.processEnded(shown = true, now = 2_000L))
        recovery.personReloaded()
        assertEquals(PageProcessRecovery.Step.Reload, recovery.processEnded(shown = true, now = 3_000L))
    }

    @Test
    fun hiddenPageThatDiesRightAfterItsRecoveryWaits() {
        val recovery = PageProcessRecovery()
        recovery.processEnded(shown = true, now = 0L)
        recovery.reloadStarted()
        recovery.loadFinished(now = 1_000L)
        assertEquals(PageProcessRecovery.Step.Wait, recovery.processEnded(shown = false, now = 2_000L))
        assertTrue(recovery.awaitsReload)
    }

    @Test
    fun reloadByThePersonCountsAsTheRecovery() {
        val recovery = PageProcessRecovery()
        assertEquals(PageProcessRecovery.Step.Wait, recovery.processEnded(shown = false, now = 0L))
        recovery.personReloaded()
        recovery.reloadStarted()
        assertEquals(PageProcessOutcome.Recovered, recovery.loadFinished(now = 1_000L))
    }
}
