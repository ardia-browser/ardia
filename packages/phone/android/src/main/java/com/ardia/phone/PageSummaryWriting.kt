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
        data object Excerpts : Writer("excerpts")
    }

    data class Written(val text: String, val writer: Writer, val note: String, val chatGPTFellBack: Boolean)

    suspend fun write(content: ReadableContent, provider: PageSummaryProvider, onText: (String) -> Unit, reason: String? = null): Written {
        var fallback = reason
        var fellBack = false
        if (provider == PageSummaryProvider.ChatGPT) {
            if (!cloud.isConnected) {
                fallback = NOT_CONNECTED
            } else {
                try {
                    var shown = ""
                    val model = cloud.stream(PageSummaryDigest.INSTRUCTIONS, PageSummaryDigest.prompt(content, CHATGPT_CHARACTER_BUDGET)) {
                        shown = it
                        onText(it)
                    }
                    return Written(shown, Writer.ChatGPT(model), "Written by ChatGPT ($model) on your plan from this page’s text. Check the page for anything important.", chatGPTFellBack = false)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    currentCoroutineContext().ensureActive()
                    onText("")
                    fellBack = true
                    fallback = (error as? ChatGPTFailure ?: ChatGPTFailure.Network).message
                }
            }
        }
        when (local.availability()) {
            OnDeviceWriter.Availability.Available -> Unit
            OnDeviceWriter.Availability.Downloading -> return quote(content, joined(fallback, "Gemini Nano is still downloading. Until it’s ready, here are the page’s key lines."), fellBack)
            OnDeviceWriter.Availability.Unavailable -> return quote(content, joined(fallback, "This phone can’t run Gemini Nano, so here are the page’s key lines."), fellBack)
        }
        val budget = local.characterBudget()
        for (share in listOf(budget, budget / 2)) {
            try {
                var shown = ""
                local.stream(PageSummaryDigest.INSTRUCTIONS, PageSummaryDigest.prompt(content, share)) {
                    shown = it
                    onText(it)
                }
                val note = fallback?.let { "$it Gemini Nano summarized the page on this phone instead." } ?: "Written on this phone by Gemini Nano. The page’s text didn’t leave the phone."
                return Written(shown, Writer.OnDevice, note, fellBack)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                currentCoroutineContext().ensureActive()
                onText("")
            }
        }
        return quote(content, joined(fallback, "Gemini Nano couldn’t summarize this page, so here are its key lines."), fellBack)
    }

    private fun quote(content: ReadableContent, note: String, fellBack: Boolean): Written = Written(PageSummaryDigest.excerpts(content), Writer.Excerpts, note, fellBack)

    private fun joined(first: String?, second: String): String = listOfNotNull(first, second).joinToString(" ")

    companion object {
        const val CHATGPT_CHARACTER_BUDGET = 24_000
        const val NOT_CONNECTED = "ChatGPT isn’t connected, so this summary stayed on your phone. Reconnect it in Settings › Pinch to Summarize."

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
