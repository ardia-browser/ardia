package com.ardia.phone

import com.ardia.browser.ReadableContent
import com.ardia.chatgpt.ChatGPTFailure
import com.google.mlkit.genai.common.GenAiException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PageSummaryWritingTest {
    private class Cloud(override var isConnected: Boolean, val fails: Exception? = null, val answers: String = "- From ChatGPT") : PageSummaryCloud {
        val prompts = mutableListOf<String>()

        override suspend fun stream(instructions: String, prompt: String, onText: (String) -> Unit): String {
            prompts += prompt
            fails?.let { throw it }
            onText(answers)
            return "GPT-6"
        }
    }

    private class Local(val availability: OnDeviceWriter.Availability = OnDeviceWriter.Availability.Available, val fails: Boolean = false, val writes: String = "- From Gemini Nano", val failure: Exception = IllegalStateException("Gemini Nano returned nothing")) : PageSummaryLocal {
        val prompts = mutableListOf<String>()

        override suspend fun availability(): OnDeviceWriter.Availability = availability

        override suspend fun characterBudget(): Int = 4_000

        override suspend fun stream(instructions: String, prompt: String, onText: (String) -> Unit) {
            prompts += prompt
            if (fails) throw failure
            onText(writes)
        }
    }

    private fun written(result: PageSummaryWriting.Result): PageSummaryWriting.Written = result as PageSummaryWriting.Written

    private fun unwritten(result: PageSummaryWriting.Result): String = (result as PageSummaryWriting.Unwritten).message

    private fun quotesThePage(text: String): Boolean = (extracted.paragraphs + listOfNotNull(extracted.excerpt)).any { text.contains(it.take(30)) }

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
        val result = written(PageSummaryWriting(cloud, local).write(extracted, PageSummaryProvider.of(null), {}))
        assertTrue(cloud.prompts.isEmpty())
        assertEquals(PageSummaryWriting.Writer.OnDevice, result.writer)
        assertEquals("- From Gemini Nano", result.text)
        assertFalse(result.chatGPTFellBack)
        assertEquals(1, local.prompts.size)
    }

    @Test
    fun anUnavailableModelSaysSoPlainlyWithoutThePagesLinesOrAskingChatGPT() = runTest {
        val cloud = Cloud(isConnected = true)
        val shown = mutableListOf<String>()
        val message = unwritten(PageSummaryWriting(cloud, Local(OnDeviceWriter.Availability.NotOffered)).write(extracted, PageSummaryProvider.OnDevice, { shown += it }))
        assertTrue(cloud.prompts.isEmpty())
        assertEquals("Google lets apps use Gemini Nano only on newer phones, such as the Pixel 9 and Galaxy S25.", message)
        assertTrue(shown.isEmpty())
        assertFalse(quotesThePage(message))
    }

    @Test
    fun aDownloadingModelSaysToTryAgainWithoutThePagesLines() = runTest {
        val message = unwritten(PageSummaryWriting(Cloud(isConnected = true), Local(OnDeviceWriter.Availability.Downloading)).write(extracted, PageSummaryProvider.OnDevice, {}))
        assertEquals(PageSummaryWriting.NANO_DOWNLOADING, message)
        assertFalse(quotesThePage(message))
    }

    @Test
    fun aLocalFailureNeverFailsOverToChatGPTAndNeverQuotesThePage() = runTest {
        val cloud = Cloud(isConnected = true)
        val local = Local(fails = true)
        val shown = mutableListOf<String>()
        val message = unwritten(PageSummaryWriting(cloud, local).write(extracted, PageSummaryProvider.OnDevice, { shown += it }))
        assertTrue(cloud.prompts.isEmpty())
        assertEquals(2, local.prompts.size)
        assertEquals(PageSummaryWriting.NANO_FAILED, message)
        assertTrue(shown.all { it.isEmpty() })
    }

    @Test
    fun aFailedLocalWriteIsCountedAndABusyModelSaysSo() = runTest {
        val failed = PageSummaryWriting(Cloud(isConnected = false), Local(fails = true)).write(extracted, PageSummaryProvider.OnDevice, {}) as PageSummaryWriting.Unwritten
        assertEquals("write_failed", failed.geminiNanoMissing)
        val busy = Local(fails = true, failure = GenAiException(IllegalStateException("AICore"), GenAiException.ErrorCode.PER_APP_BATTERY_USE_QUOTA_EXCEEDED))
        val refused = PageSummaryWriting(Cloud(isConnected = false), busy).write(extracted, PageSummaryProvider.OnDevice, {}) as PageSummaryWriting.Unwritten
        assertEquals("errors", refused.geminiNanoMissing)
        assertEquals("Gemini Nano is busy right now.", refused.message)
    }

    @Test
    fun aBlankLocalAnswerIsRetriedOnceThenFailsWithoutQuoting() = runTest {
        val local = Local(writes = "  ")
        val message = unwritten(PageSummaryWriting(Cloud(isConnected = false), local).write(extracted, PageSummaryProvider.OnDevice, {}))
        assertEquals(2, local.prompts.size)
        assertEquals(PageSummaryWriting.NANO_FAILED, message)
    }

    @Test
    fun choosingChatGPTSendsTheExtractedPageTextAndNothingToThePhonesModel() = runTest {
        val cloud = Cloud(isConnected = true)
        val local = Local()
        val result = written(PageSummaryWriting(cloud, local).write(extracted, PageSummaryProvider.ChatGPT, {}))
        assertEquals(1, cloud.prompts.size)
        assertTrue(cloud.prompts.single().startsWith("Page: The quiet harbour (Example News)\n\n"))
        assertTrue(cloud.prompts.single().contains("kept a strict quiet rule at night for forty years"))
        assertTrue(local.prompts.isEmpty())
        assertEquals(PageSummaryWriting.Writer.ChatGPT("GPT-6"), result.writer)
        assertEquals("chatgpt", result.writer.outcome)
        assertEquals("- From ChatGPT", result.text)
    }

    @Test
    fun aChatGPTFailureIsWrittenOnThePhoneWithTheReasonAndCountsAsAFallback() = runTest {
        val shown = mutableListOf<String>()
        val result = written(PageSummaryWriting(Cloud(isConnected = true, fails = ChatGPTFailure.UsageLimit), Local()).write(extracted, PageSummaryProvider.ChatGPT, { shown += it }))
        assertEquals(PageSummaryWriting.Writer.OnDevice, result.writer)
        assertTrue(result.chatGPTFellBack)
        assertTrue(result.note.startsWith(ChatGPTFailure.UsageLimit.message))
        assertEquals(listOf("", "- From Gemini Nano"), shown)
    }

    @Test
    fun anEmptyChatGPTAnswerFallsBackToThePhone() = runTest {
        val local = Local()
        val result = written(PageSummaryWriting(Cloud(isConnected = true, answers = ""), local).write(extracted, PageSummaryProvider.ChatGPT, {}))
        assertEquals(PageSummaryWriting.Writer.OnDevice, result.writer)
        assertTrue(result.chatGPTFellBack)
        assertEquals(1, local.prompts.size)
    }

    @Test
    fun whenChatGPTFailsAndGeminiNanoIsUnavailableNeitherWritesAndBothReasonsAreGiven() = runTest {
        val shown = mutableListOf<String>()
        val message = unwritten(PageSummaryWriting(Cloud(isConnected = true, fails = ChatGPTFailure.UsageLimit), Local(OnDeviceWriter.Availability.NotOffered)).write(extracted, PageSummaryProvider.ChatGPT, { shown += it }))
        assertEquals("${ChatGPTFailure.UsageLimit.message} Google lets apps use Gemini Nano only on newer phones, such as the Pixel 9 and Galaxy S25.", message)
        assertEquals(listOf(""), shown)
        assertFalse(quotesThePage(message))
    }

    @Test
    fun chatGPTChosenButNotConnectedWithNoLocalModelSaysHowToReconnect() = runTest {
        val cloud = Cloud(isConnected = false)
        val message = unwritten(PageSummaryWriting(cloud, Local(OnDeviceWriter.Availability.NotOffered)).write(extracted, PageSummaryProvider.ChatGPT, {}))
        assertTrue(cloud.prompts.isEmpty())
        assertEquals("${PageSummaryWriting.NOT_CONNECTED_UNWRITTEN} Google lets apps use Gemini Nano only on newer phones, such as the Pixel 9 and Galaxy S25.", message)
    }

    @Test
    fun chatGPTChosenButNotConnectedStaysOnThePhoneForThisRunAndSaysHowToReconnect() = runTest {
        val cloud = Cloud(isConnected = false)
        val result = written(PageSummaryWriting(cloud, Local()).write(extracted, PageSummaryProvider.ChatGPT, {}))
        assertTrue(cloud.prompts.isEmpty())
        assertEquals(PageSummaryWriting.Writer.OnDevice, result.writer)
        assertFalse(result.chatGPTFellBack)
        assertTrue(result.note.startsWith(PageSummaryWriting.NOT_CONNECTED))
        cloud.isConnected = true
        val reconnected = written(PageSummaryWriting(cloud, Local()).write(extracted, PageSummaryProvider.ChatGPT, {}))
        assertEquals(PageSummaryWriting.Writer.ChatGPT("GPT-6"), reconnected.writer)
    }

    @Test
    fun aDisconnectMidAnswerRewritesOnThePhoneWithoutAnotherCloudRequest() = runTest {
        val cloud = Cloud(isConnected = true)
        val result = written(PageSummaryWriting(cloud, Local()).write(extracted, PageSummaryProvider.OnDevice, {}, reason = "ChatGPT was disconnected."))
        assertTrue(cloud.prompts.isEmpty())
        assertTrue(result.note.startsWith("ChatGPT was disconnected."))
        val unavailable = unwritten(PageSummaryWriting(cloud, Local(OnDeviceWriter.Availability.NotOffered)).write(extracted, PageSummaryProvider.OnDevice, {}, reason = "ChatGPT was disconnected."))
        assertEquals("ChatGPT was disconnected. Google lets apps use Gemini Nano only on newer phones, such as the Pixel 9 and Galaxy S25.", unavailable)
    }

    @Test
    fun theSavedChoiceDefaultsToThePhoneAndReadsOnlyKnownProviders() {
        assertEquals(PageSummaryProvider.OnDevice, PageSummaryProvider.of(null))
        assertEquals(PageSummaryProvider.OnDevice, PageSummaryProvider.of("anything"))
        assertEquals(PageSummaryProvider.OnDevice, PageSummaryProvider.of("on_device"))
        assertEquals(PageSummaryProvider.ChatGPT, PageSummaryProvider.of("chatgpt"))
    }
}
