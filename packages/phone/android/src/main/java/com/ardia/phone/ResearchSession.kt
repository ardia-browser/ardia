package com.ardia.phone

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.ardia.browser.PageFilter
import com.ardia.browser.ReadableContent
import com.ardia.chatgpt.ChatGPTFailure
import com.ardia.research.ResearchDigest
import com.ardia.research.ResearchLink
import com.ardia.research.ResearchSearch
import com.ardia.research.ResearchSource
import java.util.UUID
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

internal class ResearchSession(context: Context, val query: String, val forcesExcerpts: Boolean, private val chatGPT: ChatGPTAccount, filter: PageFilter?) {
    sealed class Phase {
        data object Searching : Phase()
        data class Reading(val done: Int, val total: Int) : Phase()
        data object Writing : Phase()
        data object Done : Phase()
        data class Failed(val message: String) : Phase()
    }

    sealed class Writer {
        data class ChatGPT(val model: String) : Writer()
        data class OnDevice(val fallback: String?) : Writer()
        data class Excerpts(val reason: String) : Writer()
    }

    val id: String = UUID.randomUUID().toString()
    var phase: Phase by mutableStateOf<Phase>(Phase.Searching)
        private set
    var links: List<ResearchLink> by mutableStateOf<List<ResearchLink>>(emptyList())
        private set
    var sources: List<ResearchSource> by mutableStateOf<List<ResearchSource>>(emptyList())
        private set
    var answer: String by mutableStateOf("")
        private set
    var writer: Writer? by mutableStateOf<Writer?>(null)
        private set
    var chatGPTFellBack = false
        private set
    var geminiNanoMissing: String? by mutableStateOf<String?>(null)
        private set
    var rewroteAfterGeminiNanoDownload = false
        private set
    var isWritingWithChatGPT = false
        private set
    var onSettled: ((ResearchSession) -> Unit)? = null

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val loader = ResearchPageLoader(context, filter)
    private var task: Job? = null

    val isFinished: Boolean get() = phase is Phase.Done || phase is Phase.Failed

    fun start() {
        if (task != null) return
        if (!forcesExcerpts && !chatGPT.isConnected) scope.launch { OnDeviceWriter.prepare() }
        task = scope.launch { research() }
    }

    fun retry() {
        task?.cancel()
        task = null
        rewroteAfterGeminiNanoDownload = false
        phase = Phase.Searching
        links = emptyList()
        sources = emptyList()
        answer = ""
        writer = null
        start()
    }

    fun rewrite(afterGeminiNanoDownload: Boolean = false) {
        if (sources.isEmpty() || !isFinished && !isWritingWithChatGPT) return retry()
        task?.cancel()
        rewroteAfterGeminiNanoDownload = afterGeminiNanoDownload
        answer = ""
        writer = null
        phase = Phase.Writing
        task = scope.launch {
            write()
            finish()
            settle()
        }
    }

    fun chatGPTDisconnected() {
        if (isWritingWithChatGPT) rewrite()
    }

    fun cancel() {
        task?.cancel()
        task = null
        scope.cancel()
        loader.finish()
    }

    fun source(number: Int): ResearchSource? = sources.firstOrNull { it.id == number }

    private suspend fun research() {
        try {
            links = loader.searchLinks(query)
            if (links.isEmpty()) {
                phase = Phase.Failed("Couldn’t find pages for this search.")
                return settle()
            }
            sources = readSources(links)
            loader.finish()
            if (sources.isEmpty()) {
                phase = Phase.Failed("Couldn’t read any of the pages for this search.")
                return settle()
            }
            phase = Phase.Writing
            write()
            finish()
            settle()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            loader.finish()
            phase = Phase.Failed("Couldn’t reach the web. Check your connection and try again.")
            settle()
        }
    }

    private fun settle() {
        if (isFinished) onSettled?.invoke(this)
    }

    private fun finish() {
        if (phase !is Phase.Failed) phase = Phase.Done
    }

    private suspend fun readSources(links: List<ResearchLink>): List<ResearchSource> {
        val wanted = minOf(ResearchSearch.RESULT_LIMIT, links.size)
        phase = Phase.Reading(0, wanted)
        val pages = HashMap<Int, ReadableContent>()
        val permits = Semaphore(READ_CONCURRENCY)
        coroutineScope {
            links.mapIndexed { index, link ->
                async {
                    permits.withPermit {
                        if (pages.size >= wanted) return@withPermit
                        val content = loader.read(link)
                        if (content != null && isReadable(content) && pages.size < wanted) pages[index] = content
                        phase = Phase.Reading(minOf(pages.size, wanted), wanted)
                    }
                }
            }.awaitAll()
        }
        val made = mutableListOf<ResearchSource>()
        links.forEachIndexed { index, link ->
            val page = pages[index] ?: return@forEachIndexed
            made += ResearchSource(
                id = made.size + 1,
                url = link.url,
                title = page.title.ifEmpty { link.title },
                siteName = page.siteName.ifEmpty { link.host },
                paragraphs = page.paragraphs,
            )
        }
        return made
    }

    private fun isReadable(content: ReadableContent): Boolean = content.paragraphs.sumOf { it.length } >= ResearchDigest.MINIMUM_SOURCE_CHARACTERS

    private suspend fun write() {
        chatGPTFellBack = false
        geminiNanoMissing = null
        if (forcesExcerpts) return quoteSources("Showing the most relevant lines from the pages.")
        var fallback: String? = null
        if (chatGPT.isConnected) {
            isWritingWithChatGPT = true
            try {
                val prompt = ResearchDigest.prompt(query, sources, CHATGPT_CHARACTER_BUDGET)
                val used = chatGPT.streamAnswer(ResearchDigest.INSTRUCTIONS, prompt) { answer = it }
                writer = Writer.ChatGPT(used.displayName)
                return
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                currentCoroutineContext().ensureActive()
                answer = ""
                chatGPTFellBack = true
                fallback = (error as? ChatGPTFailure ?: ChatGPTFailure.Network).message
            } finally {
                isWritingWithChatGPT = false
            }
        }
        val availability = OnDeviceWriter.availability()
        if (availability != OnDeviceWriter.Availability.Available) {
            geminiNanoMissing = availability.telemetry
            return quoteSources(listOfNotNull(fallback, availability.excerptsNote).joinToString(" "))
        }
        val budget = OnDeviceWriter.characterBudget()
        var failure: Exception? = null
        for (share in listOf(budget, budget / 2)) {
            try {
                val prompt = OnDeviceWriter.fit(ResearchDigest.INSTRUCTIONS, share) { ResearchDigest.prompt(query, sources, it) }
                OnDeviceWriter.stream(ResearchDigest.INSTRUCTIONS, prompt) { answer = it }
                writer = Writer.OnDevice(fallback)
                return
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                currentCoroutineContext().ensureActive()
                answer = ""
                failure = error
            }
        }
        val missed = OnDeviceWriter.Availability.ofWriting(failure)
        geminiNanoMissing = missed.telemetry
        quoteSources(listOfNotNull(fallback, missed.excerptsNote).joinToString(" "))
    }

    private fun quoteSources(reason: String) {
        answer = ResearchDigest.extractiveAnswer(query, sources)
        if (answer.isEmpty()) phase = Phase.Failed("Couldn’t read any of the pages for this search.")
        writer = Writer.Excerpts(reason)
    }

    companion object {
        private const val READ_CONCURRENCY = 3
        private const val CHATGPT_CHARACTER_BUDGET = 24_000
    }
}
