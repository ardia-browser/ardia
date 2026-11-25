package com.ardia.phone

import android.util.Printer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class SampleSessionTest {
    private class FakeLogging(var printer: Printer? = null) : MessageLogging {
        override fun current() = printer
        override fun set(printer: Printer?) {
            this.printer = printer
        }
    }

    private class FakeReports(private val failOnStart: Boolean = false) : FrameReports {
        var report: ((Double, Double, Double, Int) -> Unit)? = null
        var stopped = 0

        override fun start(report: (Double, Double, Double, Int) -> Unit) {
            if (failOnStart) throw IllegalStateException("window gone")
            this.report = report
        }

        override fun stop() {
            stopped += 1
            report = null
        }
    }

    private class Timers {
        val pending = mutableListOf<Runnable>()
        fun schedule(run: Runnable, millis: Long) {
            pending += run
        }
        fun fireFirst() = pending.removeAt(0).run()
    }

    @Test
    fun aSecondSampleSurvivesTheFirstsCleanupAndKeepsItsOwnTimer() {
        val logging = FakeLogging()
        val timers = Timers()
        val firstReports = FakeReports()
        val secondReports = FakeReports()
        val results = mutableListOf<Pair<String, FrameSampler.Sample?>>()
        val first = SampleSession(logging, firstReports, { 0L }, 16.7) { results += "first" to it }
        val second = SampleSession(logging, secondReports, { 0L }, 16.7) { results += "second" to it }
        FrameSampler.begin(first, 2000, timers::schedule)
        FrameSampler.begin(second, 2000, timers::schedule)
        assertEquals("starting the second cancels the first at once, without a sample", listOf("first" to null), results)
        assertEquals(1, firstReports.stopped)
        val installed = logging.printer as ChainedPrinter
        assertNull("the second chained onto what was there before the first, not onto the first's printer", installed.next)
        timers.fireFirst()
        assertSame("the first's timer firing late leaves the second's printer in place", installed, logging.printer)
        assertEquals(1, results.size)
        secondReports.report!!(10.0, 2.0, 16.7, 0)
        timers.fireFirst()
        assertEquals("second", results[1].first)
        assertEquals(listOf(10.0), results[1].second!!.totals)
        assertNull("the second's end restores the empty slot", logging.printer)
        FrameSampler.cancel()
    }

    @Test
    fun anotherPrinterKeepsGettingLinesAndIsPutBack() {
        val lines = mutableListOf<String>()
        val theirs = Printer { lines += it }
        val logging = FakeLogging(theirs)
        val session = SampleSession(logging, FakeReports(), { 0L }, 16.7) {}
        assertTrue(session.start())
        logging.printer!!.println(">>>>> Dispatching to Handler (android.os.Handler) {1} null: 0")
        assertEquals("the printer that was there still sees every line while we sample", 1, lines.size)
        session.end()
        assertSame(theirs, logging.printer)
    }

    @Test
    fun aPrinterInstalledOverOursIsNotOverwrittenAndOursGoesQuiet() {
        var now = 0L
        val logging = FakeLogging()
        val session = SampleSession(logging, FakeReports(), { now }, 16.7) {}
        assertTrue(session.start())
        val ours = logging.printer as ChainedPrinter
        val later = ChainedPrinter(Printer {}, ours)
        logging.set(later)
        session.end()
        assertSame("someone who installed over us keeps their slot", later, logging.printer)
        assertTrue("our part of their chain only forwards now", ours.forwardOnly)
    }

    @Test
    fun aSetupFailureCleansUpAndAnswersOnce() {
        val logging = FakeLogging()
        val reports = FakeReports(failOnStart = true)
        val results = mutableListOf<FrameSampler.Sample?>()
        val session = SampleSession(logging, reports, { 0L }, 16.7) { results += it }
        val timers = Timers()
        FrameSampler.begin(session, 2000, timers::schedule)
        assertEquals(listOf<FrameSampler.Sample?>(null), results)
        assertNull("the printer installed before the failure is taken back out", logging.printer)
        assertTrue("no timer is left behind", timers.pending.isEmpty())
        session.end()
        assertEquals(1, results.size)
    }

    @Test
    fun lostReportsAreCountedAndCancelAnswersWithNothing() {
        val logging = FakeLogging()
        val reports = FakeReports()
        val results = mutableListOf<FrameSampler.Sample?>()
        val timers = Timers()
        val session = SampleSession(logging, reports, { 0L }, 16.7) { results += it }
        FrameSampler.begin(session, 2000, timers::schedule)
        reports.report!!(10.0, 2.0, 16.7, 3)
        val kept = SampleSession(logging, FakeReports(), { 0L }, 16.7) {}
        assertTrue(kept.start())
        kept.end()
        FrameSampler.cancel()
        assertEquals(listOf<FrameSampler.Sample?>(null), results)
        assertFalse(timers.pending.isEmpty())
        timers.fireFirst()
        assertEquals("the timer after a cancel answers nothing more", 1, results.size)
        val counted = SampleSession(FakeLogging(), reports, { 0L }, 16.7) { results += it }
        assertTrue(counted.start())
        reports.report!!(10.0, 2.0, 16.7, 2)
        reports.report!!(11.0, 2.0, 16.7, 0)
        counted.end()
        assertEquals(2L, results.last()!!.droppedReports)
    }
}
