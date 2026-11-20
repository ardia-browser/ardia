package com.ardia.phone

import com.ardia.browser.ReadableContent
import com.ardia.chatgpt.ChatGPTFailure
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PageSummaryWritingTest {
    private class Cloud(override var isConnected: Boolean, val fails: Exception? = null) : PageSummaryCloud {
        val prompts = mutableListOf<String>()

        override suspend fun stream(instructions: String, prompt: String, onText: (String) -> Unit): String {
            prompts += prompt
            fails?.let { throw it }
            onText("- From ChatGPT")
            return "GPT-6"
        }
    }

    private class Local(val availability: OnDeviceWriter.Availability = OnDeviceWriter.Availability.Available, val fails: Boolean = false) : PageSummaryLocal {
        val prompts = mutableListOf<String>()

        override suspend fun availability(): OnDeviceWriter.Availability = availability

        override suspend fun characterBudget(): Int = 4_000

        override suspend fun stream(instructions: String, prompt: String, onText: (String) -> Unit) {
            prompts += prompt
            if (fails) throw IllegalStateException("Gemini Nano returned nothing")
            onText("- From Gemini Nano")
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

    @Test
    fun theDefaultProviderNeverSendsThePageToChatGPTEvenWhenAnAccountIsConnected() = runTest {
        val cloud = Cloud(isConnected = true)
        val local = Local()
        val written = PageSummaryWriting(cloud, local).write(extracted, PageSummaryProvider.of(null), {})
        assertTrue(cloud.prompts.isEmpty())
        assertEquals(PageSummaryWriting.Writer.OnDevice, written.writer)
        assertEquals("- From Gemini Nano", written.text)
        assertFalse(written.chatGPTFellBack)
        assertEquals(1, local.prompts.size)
    }

    @Test
    fun anUnavailableModelGivesThePagesKeyLinesWithoutAskingChatGPT() = runTest {
        val cloud = Cloud(isConnected = true)
        val written = PageSummaryWriting(cloud, Local(OnDeviceWriter.Availability.Unavailable)).write(extracted, PageSummaryProvider.OnDevice, {})
        assertTrue(cloud.prompts.isEmpty())
        assertEquals(PageSummaryWriting.Writer.Excerpts, written.writer)
        assertTrue(written.text.startsWith("- A town keeps its harbour quiet at night."))
        assertTrue(written.note.contains("can’t run Gemini Nano"))
    }

    @Test
    fun aLocalFailureNeverFailsOverToChatGPT() = runTest {
        val cloud = Cloud(isConnected = true)
        val local = Local(fails = true)
        val written = PageSummaryWriting(cloud, local).write(extracted, PageSummaryProvider.OnDevice, {})
        assertTrue(cloud.prompts.isEmpty())
        assertEquals(2, local.prompts.size)
        assertEquals(PageSummaryWriting.Writer.Excerpts, written.writer)
    }

    @Test
    fun choosingChatGPTSendsTheExtractedPageTextAndNothingToThePhonesModel() = runTest {
        val cloud = Cloud(isConnected = true)
        val local = Local()
        val written = PageSummaryWriting(cloud, local).write(extracted, PageSummaryProvider.ChatGPT, {})
        assertEquals(1, cloud.prompts.size)
        assertTrue(cloud.prompts.single().startsWith("Page: The quiet harbour (Example News)\n\n"))
        assertTrue(cloud.prompts.single().contains("kept a strict quiet rule at night for forty years"))
        assertTrue(local.prompts.isEmpty())
        assertEquals(PageSummaryWriting.Writer.ChatGPT("GPT-6"), written.writer)
        assertEquals("chatgpt", written.writer.outcome)
        assertEquals("- From ChatGPT", written.text)
    }

    @Test
    fun aChatGPTFailureIsWrittenOnThePhoneWithTheReasonAndCountsAsAFallback() = runTest {
        val shown = mutableListOf<String>()
        val written = PageSummaryWriting(Cloud(isConnected = true, fails = ChatGPTFailure.UsageLimit), Local()).write(extracted, PageSummaryProvider.ChatGPT, { shown += it })
        assertEquals(PageSummaryWriting.Writer.OnDevice, written.writer)
        assertTrue(written.chatGPTFellBack)
        assertTrue(written.note.startsWith(ChatGPTFailure.UsageLimit.message))
        assertEquals(listOf("", "- From Gemini Nano"), shown)
    }

    @Test
    fun chatGPTChosenButNotConnectedStaysOnThePhoneForThisRunAndSaysHowToReconnect() = runTest {
        val cloud = Cloud(isConnected = false)
        val written = PageSummaryWriting(cloud, Local()).write(extracted, PageSummaryProvider.ChatGPT, {})
        assertTrue(cloud.prompts.isEmpty())
        assertEquals(PageSummaryWriting.Writer.OnDevice, written.writer)
        assertFalse(written.chatGPTFellBack)
        assertTrue(written.note.startsWith(PageSummaryWriting.NOT_CONNECTED))
        cloud.isConnected = true
        val reconnected = PageSummaryWriting(cloud, Local()).write(extracted, PageSummaryProvider.ChatGPT, {})
        assertEquals(PageSummaryWriting.Writer.ChatGPT("GPT-6"), reconnected.writer)
    }

    @Test
    fun aDisconnectMidAnswerRewritesOnThePhoneWithoutAnotherCloudRequest() = runTest {
        val cloud = Cloud(isConnected = true)
        val written = PageSummaryWriting(cloud, Local()).write(extracted, PageSummaryProvider.OnDevice, {}, reason = "ChatGPT was disconnected.")
        assertTrue(cloud.prompts.isEmpty())
        assertTrue(written.note.startsWith("ChatGPT was disconnected."))
    }

    @Test
    fun theSavedChoiceDefaultsToThePhoneAndReadsOnlyKnownProviders() {
        assertEquals(PageSummaryProvider.OnDevice, PageSummaryProvider.of(null))
        assertEquals(PageSummaryProvider.OnDevice, PageSummaryProvider.of("anything"))
        assertEquals(PageSummaryProvider.OnDevice, PageSummaryProvider.of("on_device"))
        assertEquals(PageSummaryProvider.ChatGPT, PageSummaryProvider.of("chatgpt"))
    }
}
