package com.ardia.phone

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CaptureSlotTest {
    private class Page {
        val log = mutableListOf<String>()
        var touching = 0
        var mostAtOnce = 0

        suspend fun capture(name: String, gate: CompletableDeferred<Unit>? = null): String {
            touching += 1
            mostAtOnce = maxOf(mostAtOnce, touching)
            log += "$name scrolls"
            try {
                gate?.await() ?: delay(100)
                return name
            } finally {
                withContext(NonCancellable) {
                    delay(50)
                    log += "$name restores"
                    touching -= 1
                }
            }
        }
    }

    @Test
    fun aRetryStartedWhileTheCancelledCaptureRestoresWaitsAndCanItselfBeCancelledBeforeItTouchesThePage() = runTest {
        val slot = CaptureSlot<String>(this)
        val page = Page()
        val first = slot.start { page.capture("A", CompletableDeferred()) }
        advanceUntilIdle()
        slot.cancel()
        val retry = slot.start { page.capture("B") }
        val cancelling = slot.cancel()
        cancelling?.join()
        advanceUntilIdle()
        assertTrue(first.isCancelled)
        assertTrue(retry.isCancelled)
        assertEquals(listOf("A scrolls", "A restores"), page.log)
    }

    @Test
    fun joiningTheCancelledRequestWaitsForEveryOlderCaptureToRestore() = runTest {
        val slot = CaptureSlot<String>(this)
        val page = Page()
        slot.start { page.capture("A", CompletableDeferred()) }
        advanceUntilIdle()
        slot.cancel()
        slot.start { page.capture("B") }
        slot.cancel()?.join()
        assertEquals("A restores", page.log.last())
    }

    @Test
    fun aSecondRetryReplacesTheFirstWaiterAndOnlyOneCaptureTouchesThePageAtATime() = runTest {
        val slot = CaptureSlot<String>(this)
        val page = Page()
        slot.start { page.capture("A", CompletableDeferred()) }
        advanceUntilIdle()
        slot.cancel()
        val second = slot.start { page.capture("B") }
        val third = slot.start { page.capture("C") }
        advanceUntilIdle()
        assertTrue(second.isCancelled)
        assertEquals("C", third.await())
        assertEquals(listOf("A scrolls", "A restores", "C scrolls", "C restores"), page.log)
        assertEquals(1, page.mostAtOnce)
    }

    @Test
    fun cancelTargetsTheNewestRequestWhetherItIsWaitingOrRunning() = runTest {
        val slot = CaptureSlot<String>(this)
        val page = Page()
        val gate = CompletableDeferred<Unit>()
        val running = slot.start { page.capture("A", gate) }
        advanceUntilIdle()
        assertTrue(slot.waiting)
        slot.cancel()?.join()
        assertTrue(running.isCancelled)
        assertEquals(listOf("A scrolls", "A restores"), page.log)
        val next = slot.start { page.capture("B") }
        advanceUntilIdle()
        assertEquals("B", next.await())
    }

    @Test
    fun onAnImmediateDispatcherTheFirstRequestIsRegisteredBeforeItRunsAndIsNotRejected() = runTest {
        val immediate = CoroutineScope(SupervisorJob() + UnconfinedTestDispatcher(testScheduler))
        val slot = CaptureSlot<String>(immediate)
        val page = Page()
        val first = slot.start { page.capture("A") }
        advanceUntilIdle()
        assertEquals("A", first.await())
        val gate = CompletableDeferred<Unit>()
        val second = slot.start { page.capture("B", gate) }
        assertTrue(slot.waiting)
        slot.cancel()?.join()
        assertTrue(second.isCancelled)
        assertEquals(listOf("A scrolls", "A restores", "B scrolls", "B restores"), page.log)
    }
}
