package com.ardia.phone

import android.content.Context
import android.os.Looper
import com.ardia.browser.ReadableContent
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PageSummarySessionTest {
    private val context: Context = RuntimeEnvironment.getApplication()

    private class Cloud(override val isConnected: Boolean) : PageSummaryCloud {
        var asked = 0

        override suspend fun stream(instructions: String, prompt: String, onText: (String) -> Unit): String {
            asked++
            throw IllegalStateException("offline")
        }
    }

    private class Local(val availability: OnDeviceWriter.Availability, val gate: CompletableDeferred<Unit>? = null) : PageSummaryLocal {
        var asked = 0

        override suspend fun availability(): OnDeviceWriter.Availability = availability

        override suspend fun characterBudget(): Int = 4_000

        override suspend fun stream(instructions: String, prompt: String, onText: (String) -> Unit) {
            asked++
            onText("- Half")
            gate?.await()
            onText("- Half a summary, then all of it")
        }
    }

    private val extracted = ReadableContent(
        "https://example.com/story", "The quiet harbour", "Example News", null, "A town keeps its harbour quiet at night.", null, "en",
        listOf(
            "The harbour of a small coastal town has kept a strict quiet rule at night for forty years, and the fishermen planned their week around it.",
            "Boats leave before dawn and come back before dusk. The council says the rule keeps the seals that rest on the breakwater from leaving.",
        ),
        "", 0, true,
    )

    private val settled = mutableListOf<PageSummarySession>()

    @Before
    fun turnOn() {
        PageSummaryChoice.enable(context, true)
    }

    private fun session(provider: PageSummaryProvider, cloud: PageSummaryCloud, local: PageSummaryLocal): PageSummarySession {
        val revision = PageSummaryChoice.revision
        return PageSummarySession(
            trigger = PageSummarySession.Trigger.Pinch,
            pageId = "p1",
            document = 1L,
            isPrivate = false,
            title = "Story",
            provider = provider,
            writing = PageSummaryWriting(cloud, local),
            read = { extracted },
            isCurrent = { PageSummaryChoice.revision == revision },
        ).also { it.onSettled = { done -> settled += done } }
    }

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    @Test
    fun anUnavailableModelFailsWithPlainWordsAndCountsAsFailed() {
        val made = session(PageSummaryProvider.OnDevice, Cloud(isConnected = true), Local(OnDeviceWriter.Availability.NotOffered))
        made.start()
        idle()
        assertEquals(PageSummarySession.Phase.Failed("Google lets apps use Gemini Nano only on newer phones, such as the Pixel 9 and Galaxy S25."), made.phase)
        assertEquals("", made.text)
        assertEquals("failed", made.outcome)
        assertEquals("not_offered", made.geminiNanoMissing)
        assertEquals(listOf(made), settled)
    }

    @Test
    fun whenNeitherChatGPTNorTheModelWritesTheSummaryFailsAndIsCountedOnce() {
        val cloud = Cloud(isConnected = true)
        val made = session(PageSummaryProvider.ChatGPT, cloud, Local(OnDeviceWriter.Availability.Downloading))
        made.start()
        idle()
        assertEquals(1, cloud.asked)
        val phase = made.phase as PageSummarySession.Phase.Failed
        assertTrue(phase.message.endsWith(PageSummaryWriting.NANO_DOWNLOADING))
        assertEquals("failed", made.outcome)
        assertEquals(1, settled.size)
    }

    @Test
    fun turningSummariesOffMidAnswerStopsTheWriterFromShowingOrSettlingEvenIfTheyComeBackOn() {
        val gate = CompletableDeferred<Unit>()
        val made = session(PageSummaryProvider.OnDevice, Cloud(isConnected = false), Local(OnDeviceWriter.Availability.Available, gate))
        made.start()
        idle()
        assertEquals("- Half", made.text)
        PageSummaryChoice.enable(context, false)
        PageSummaryChoice.enable(context, true)
        gate.complete(Unit)
        idle()
        assertEquals("- Half", made.text)
        assertTrue(made.phase is PageSummarySession.Phase.Writing)
        assertTrue(settled.isEmpty())
    }
}
