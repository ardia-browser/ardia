package com.ardia.phone

import com.ardia.browser.ReadableContent
import com.ardia.chatgpt.ChatGPTFailure
import com.ardia.research.PageSummaryDigest
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

internal enum class PageSummaryProvider(val raw: String) {
    OnDevice("on_device"),
    ChatGPT("chatgpt"),
    ;

    companion object {
        fun of(raw: String?): PageSummaryProvider = entries.firstOrNull { it.raw == raw } ?: OnDevice
    }
}

internal interface PageSummaryCloud {
    val isConnected: Boolean

    suspend fun stream(instructions: String, prompt: String, onText: (String) -> Unit): String
}

internal interface PageSummaryLocal {
    suspend fun availability(): OnDeviceWriter.Availability

    suspend fun characterBudget(): Int

    suspend fun stream(instructions: String, prompt: String, onText: (String) -> Unit)
}

internal class PageSummaryWriting(private val cloud: PageSummaryCloud, private val local: PageSummaryLocal) {
    sealed class Writer(val outcome: String) {
        data class ChatGPT(val model: String) : Writer("chatgpt")
        data object OnDevice : Writer("on_device")
    }

    sealed interface Result

    data class Written(val text: String, val writer: Writer, val note: String, val chatGPTFellBack: Boolean) : Result

    data class Unwritten(val message: String) : Result

    suspend fun write(content: ReadableContent, provider: PageSummaryProvider, onText: (String) -> Unit, reason: String? = null): Result {
        var note = reason
        var problem = reason
        var fellBack = false
        if (provider == PageSummaryProvider.ChatGPT) {
            if (!cloud.isConnected) {
                note = NOT_CONNECTED
                problem = NOT_CONNECTED_UNWRITTEN
            } else {
                try {
                    var shown = ""
                    val model = cloud.stream(PageSummaryDigest.INSTRUCTIONS, PageSummaryDigest.prompt(content, CHATGPT_CHARACTER_BUDGET)) {
                        shown = it
                        onText(it)
                    }
                    if (shown.isNotBlank()) return Written(shown, Writer.ChatGPT(model), "Written by ChatGPT ($model) on your plan from this page’s text. Check the page for anything important.", chatGPTFellBack = false)
                    note = EMPTY_CHATGPT_ANSWER
                    problem = EMPTY_CHATGPT_ANSWER
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    currentCoroutineContext().ensureActive()
                    note = (error as? ChatGPTFailure ?: ChatGPTFailure.Network).message
                    problem = note
                }
                onText("")
                fellBack = true
            }
        }
        when (local.availability()) {
            OnDeviceWriter.Availability.Available -> Unit
            OnDeviceWriter.Availability.Downloading -> return Unwritten(joined(problem, NANO_DOWNLOADING))
            OnDeviceWriter.Availability.Unavailable -> return Unwritten(joined(problem, NANO_UNAVAILABLE))
        }
        val budget = local.characterBudget()
        for (share in listOf(budget, budget / 2)) {
            try {
                var shown = ""
                local.stream(PageSummaryDigest.INSTRUCTIONS, PageSummaryDigest.prompt(content, share)) {
                    shown = it
                    onText(it)
                }
                if (shown.isBlank()) continue
                val written = note?.let { "$it Gemini Nano summarized the page on this phone instead." } ?: "Written on this phone by Gemini Nano. The page’s text didn’t leave the phone."
                return Written(shown, Writer.OnDevice, written, fellBack)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                currentCoroutineContext().ensureActive()
                onText("")
            }
        }
        return Unwritten(joined(problem, NANO_FAILED))
    }

    private fun joined(first: String?, second: String): String = listOfNotNull(first, second).joinToString(" ")

    companion object {
        const val CHATGPT_CHARACTER_BUDGET = 24_000
        const val NOT_CONNECTED = "ChatGPT isn’t connected, so this summary stayed on your phone. Reconnect it in Settings › Pinch to Summarize."
        const val NOT_CONNECTED_UNWRITTEN = "ChatGPT isn’t connected. Reconnect it in Settings › Pinch to Summarize."
        const val EMPTY_CHATGPT_ANSWER = "ChatGPT didn’t write a summary."
        const val NANO_UNAVAILABLE = "Gemini Nano is unavailable on this phone."
        const val NANO_DOWNLOADING = "Gemini Nano is still downloading. Try again when it’s ready."
        const val NANO_FAILED = "Gemini Nano couldn’t summarize this page."

        fun live(account: ChatGPTAccount): PageSummaryWriting = PageSummaryWriting(
            object : PageSummaryCloud {
                override val isConnected: Boolean get() = account.isConnected

                override suspend fun stream(instructions: String, prompt: String, onText: (String) -> Unit): String = account.streamAnswer(instructions, prompt, onText).displayName
            },
            object : PageSummaryLocal {
                override suspend fun availability(): OnDeviceWriter.Availability = OnDeviceWriter.availability()

                override suspend fun characterBudget(): Int = OnDeviceWriter.characterBudget()

                override suspend fun stream(instructions: String, prompt: String, onText: (String) -> Unit) = OnDeviceWriter.stream(instructions, prompt, onText)
            },
        )
    }
}
