package com.ardia.phone

import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.prompt.GenerateContentRequest
import com.google.mlkit.genai.prompt.Generation
import com.google.mlkit.genai.prompt.GenerativeModel
import com.google.mlkit.genai.prompt.TextPart
import com.google.mlkit.genai.prompt.generateContentRequest
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

internal object OnDeviceWriter {
    enum class Availability(val telemetry: String?, val reason: String?) {
        Available(null, null),
        Downloading("downloading", "Gemini Nano is still downloading"),
        DownloadFailed("download_failed", "Gemini Nano’s download stopped before it finished, so it’s starting again"),
        NotOffered("not_offered", "Google lets apps use Gemini Nano only on newer phones, such as the Pixel 9 and Galaxy S25"),
        NeedsUpdate("needs_update", "Gemini Nano needs a Google AICore or system update first"),
        NeedsSpace("errors", "Gemini Nano needs more free storage to download"),
        Busy("errors", "Gemini Nano is busy right now"),
        Failed("errors", "Gemini Nano didn’t start"),
        WriteFailed("write_failed", "Gemini Nano couldn’t answer this one"),
        ;

        val excerptsNote: String get() = "${reason ?: "Gemini Nano didn’t start"}, so here are the most relevant lines from the pages."

        companion object {
            fun of(status: Int): Availability = when (status) {
                FeatureStatus.AVAILABLE -> Available
                FeatureStatus.DOWNLOADABLE, FeatureStatus.DOWNLOADING -> Downloading
                else -> NotOffered
            }

            fun of(error: Throwable?): Availability = when ((error as? GenAiException)?.errorCode) {
                GenAiException.ErrorCode.NOT_AVAILABLE -> NotOffered
                GenAiException.ErrorCode.AICORE_INCOMPATIBLE, GenAiException.ErrorCode.NEEDS_SYSTEM_UPDATE -> NeedsUpdate
                GenAiException.ErrorCode.NOT_ENOUGH_DISK_SPACE -> NeedsSpace
                GenAiException.ErrorCode.BUSY, GenAiException.ErrorCode.PER_APP_BATTERY_USE_QUOTA_EXCEEDED, GenAiException.ErrorCode.BACKGROUND_USE_BLOCKED -> Busy
                else -> Failed
            }

            fun ofWriting(error: Throwable?): Availability = of(error).takeUnless { it == Failed } ?: WriteFailed

            fun ofDownload(error: Throwable?): Availability = of(error).takeUnless { it == Failed } ?: DownloadFailed
        }
    }

    sealed class Download {
        data object Idle : Download()
        data class Running(val fraction: Float?) : Download()
        data object Ready : Download()
        data class Stopped(val availability: Availability) : Download()
    }

    const val RESPONSE_TOKENS = 256
    private const val INSTRUCTION_TOKENS = 260
    private const val CHARACTERS_PER_TOKEN = 4
    private const val FALLBACK_TOKEN_LIMIT = 4_000
    private const val STATUS_RETRY_DELAY_MS = 400L
    private const val DOWNLOAD_POLL_MS = 5_000L
    private const val DOWNLOAD_POLLS = 360
    private const val FIT_ATTEMPTS = 3

    @Volatile
    private var client: GenerativeModel? = null
    private val background = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val downloadState = MutableStateFlow<Download>(Download.Idle)
    val download: StateFlow<Download> = downloadState.asStateFlow()

    private fun model(): GenerativeModel? = client ?: runCatching { Generation.getClient() }.getOrNull()?.also { client = it }

    suspend fun availability(): Availability {
        val model = model() ?: return Availability.Failed
        val first = status(model)
        if (first != Availability.Busy && first != Availability.Failed) return first
        delay(STATUS_RETRY_DELAY_MS)
        return status(model)
    }

    suspend fun prepare() {
        val model = model() ?: return
        if (status(model) != Availability.Available) return
        try {
            model.warmup()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
        }
    }

    private suspend fun status(model: GenerativeModel): Availability {
        val status = try {
            model.checkStatus()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            return Availability.of(error)
        }
        if (status == FeatureStatus.AVAILABLE) {
            if (downloadState.value is Download.Running) downloadState.value = Download.Ready
            return Availability.Available
        }
        if (status != FeatureStatus.DOWNLOADABLE && status != FeatureStatus.DOWNLOADING) return Availability.of(status)
        val stopped = (downloadState.value as? Download.Stopped)?.availability
        follow(model, status)
        return stopped ?: Availability.Downloading
    }

    private fun follow(model: GenerativeModel, status: Int) {
        val current = downloadState.value
        if (current is Download.Running || !downloadState.compareAndSet(current, Download.Running(null))) return
        background.launch {
            downloadState.value = try {
                if (status == FeatureStatus.DOWNLOADABLE) fetch(model) else await(model)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                Download.Stopped(Availability.ofDownload(error))
            }
        }
    }

    private suspend fun fetch(model: GenerativeModel): Download {
        var total = 0L
        var ended: Download? = null
        model.download().collect { step ->
            when (step) {
                is DownloadStatus.DownloadStarted -> total = step.bytesToDownload
                is DownloadStatus.DownloadProgress -> downloadState.value = Download.Running(if (total > 0) (step.totalBytesDownloaded.toFloat() / total).coerceIn(0f, 1f) else null)
                is DownloadStatus.DownloadCompleted -> ended = Download.Ready
                is DownloadStatus.DownloadFailed -> ended = Download.Stopped(Availability.ofDownload(step.e))
                else -> Unit
            }
        }
        return ended ?: if (model.checkStatus() == FeatureStatus.AVAILABLE) Download.Ready else Download.Stopped(Availability.DownloadFailed)
    }

    private suspend fun await(model: GenerativeModel): Download {
        repeat(DOWNLOAD_POLLS) {
            delay(DOWNLOAD_POLL_MS)
            val status = try {
                model.checkStatus()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                FeatureStatus.DOWNLOADING
            }
            when (status) {
                FeatureStatus.AVAILABLE -> return Download.Ready
                FeatureStatus.DOWNLOADING -> Unit
                FeatureStatus.DOWNLOADABLE -> return Download.Stopped(Availability.DownloadFailed)
                else -> return Download.Stopped(Availability.of(status))
            }
        }
        return Download.Idle
    }

    suspend fun characterBudget(): Int = maxOf((tokenLimit(model()) - RESPONSE_TOKENS - INSTRUCTION_TOKENS) * CHARACTERS_PER_TOKEN, 2_000)

    private suspend fun tokenLimit(model: GenerativeModel?): Int = runCatching { model?.getTokenLimit() }.getOrNull() ?: FALLBACK_TOKEN_LIMIT

    suspend fun fit(instructions: String, characters: Int, prompt: (Int) -> String): String {
        val model = model() ?: return prompt(characters)
        val allowed = tokenLimit(model) - RESPONSE_TOKENS
        var budget = characters
        repeat(FIT_ATTEMPTS) {
            val text = prompt(budget)
            val tokens = try {
                model.countTokens(request(instructions, text)).totalTokens
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                return text
            }
            if (tokens <= allowed) return text
            budget = (budget.toLong() * allowed * 9 / (tokens.toLong() * 10)).toInt()
        }
        return prompt(budget)
    }

    private fun request(instructions: String, prompt: String): GenerateContentRequest = generateContentRequest(TextPart("$instructions\n\n$prompt")) {
        temperature = 0.3f
        maxOutputTokens = RESPONSE_TOKENS
    }

    suspend fun stream(instructions: String, prompt: String, onText: (String) -> Unit) {
        val model = model() ?: throw IllegalStateException("Gemini Nano is not available")
        var text = ""
        model.generateContentStream(request(instructions, prompt)).collect { chunk ->
            val delta = chunk.candidates.firstOrNull()?.text.orEmpty()
            if (delta.isEmpty()) return@collect
            text += delta
            onText(text)
        }
        if (text.isBlank()) throw IllegalStateException("Gemini Nano returned nothing")
    }
}
