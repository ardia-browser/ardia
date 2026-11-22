package com.ardia.phone

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.ardia.browser.ReadableContent
import com.ardia.research.PageSummaryDigest
import java.util.UUID
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

internal class PageSummarySession(
    val trigger: Trigger,
    val pageId: String,
    val document: Long,
    val isPrivate: Boolean,
    title: String,
    private val provider: PageSummaryProvider,
    private val writing: PageSummaryWriting,
    private val read: suspend () -> ReadableContent,
    private val isCurrent: () -> Boolean,
) {
    enum class Trigger(val raw: String) {
        Pinch("pinch"),
        Menu("menu"),
    }

    sealed class Phase {
        data object Reading : Phase()
        data object Writing : Phase()
        data object Done : Phase()
        data class Failed(val message: String) : Phase()
    }

    val id: String = UUID.randomUUID().toString()
    var title: String by mutableStateOf(title)
        private set
    var phase: Phase by mutableStateOf<Phase>(Phase.Reading)
        private set
    var text: String by mutableStateOf("")
        private set
    var note: String? by mutableStateOf<String?>(null)
        private set
    var writer: PageSummaryWriting.Writer? = null
        private set
    var chatGPTFellBack = false
        private set
    var geminiNanoMissing: String? = null
        private set
    var onSettled: ((PageSummarySession) -> Unit)? = null

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var task: Job? = null
    private var content: ReadableContent? = null
    private var writesWithChatGPT = false

    val outcome: String get() = if (phase is Phase.Failed) "failed" else writer?.outcome ?: "failed"

    val usesChatGPT: Boolean get() = provider == PageSummaryProvider.ChatGPT

    fun start() {
        if (task != null) return
        task = scope.launch { run() }
    }

    fun cancel() {
        onSettled = null
        task?.cancel()
        task = null
        scope.cancel()
    }

    fun chatGPTDisconnected() {
        val extracted = content ?: return
        if (!writesWithChatGPT) return
        task?.cancel()
        writesWithChatGPT = false
        text = ""
        task = scope.launch { write(extracted, PageSummaryProvider.OnDevice, "ChatGPT was disconnected.") }
    }

    private suspend fun run() {
        val extracted = try {
            read()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            return fail("Couldn’t read this page.")
        }
        if (!isCurrent()) return
        if (extracted.title.isNotEmpty()) title = extracted.title
        if (!PageSummaryDigest.isSummarizable(extracted)) return fail("There isn’t enough text on this page to summarize.")
        content = extracted
        write(extracted, provider, null)
    }

    private suspend fun write(extracted: ReadableContent, using: PageSummaryProvider, reason: String?) {
        phase = Phase.Writing
        writesWithChatGPT = using == PageSummaryProvider.ChatGPT
        val result = try {
            writing.write(extracted, using, { if (isCurrent()) text = it }, reason)
        } finally {
            writesWithChatGPT = false
        }
        if (!isCurrent()) return
        val written = when (result) {
            is PageSummaryWriting.Unwritten -> {
                geminiNanoMissing = result.geminiNanoMissing
                return fail(result.message)
            }
            is PageSummaryWriting.Written -> result
        }
        if (written.text.isBlank()) return fail("Couldn’t summarize this page.")
        text = written.text
        writer = written.writer
        note = written.note
        chatGPTFellBack = written.chatGPTFellBack
        phase = Phase.Done
        onSettled?.invoke(this)
    }

    private fun fail(message: String) {
        if (!isCurrent()) return
        text = ""
        phase = Phase.Failed(message)
        onSettled?.invoke(this)
    }
}
