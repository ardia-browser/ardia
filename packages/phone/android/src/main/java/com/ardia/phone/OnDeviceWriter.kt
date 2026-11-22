package com.ardia.phone

import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.prompt.Generation
import com.google.mlkit.genai.prompt.GenerativeModel
import com.google.mlkit.genai.prompt.TextPart
import com.google.mlkit.genai.prompt.generateContentRequest
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

internal object OnDeviceWriter {
    enum class Availability(val telemetry: String?, val reason: String?) {
        Available(null, null),
        Downloading("downloading", "Gemini Nano is still downloading"),
        NotOffered("not_offered", "Google lets apps use Gemini Nano only on newer phones, such as the Pixel 9 and Galaxy S25"),
        NeedsUpdate("needs_update", "Gemini Nano needs a Google AICore or system update first"),
        NeedsSpace("errors", "Gemini Nano needs more free storage to download"),
        Busy("errors", "Gemini Nano is busy right now"),
        Failed("errors", "Gemini Nano didn’t start"),
        ;

        val excerptsNote: String get() = "${reason ?: "Gemini Nano didn’t start"}, so here are the most relevant lines from the pages."

        companion object {
            fun of(status: Int): Availability = when (status) {
                FeatureStatus.AVAILABLE -> Available
                FeatureStatus.DOWNLOADABLE, FeatureStatus.DOWNLOADING -> Downloading
                else -> NotOffered
            }

            fun of(error: Throwable): Availability = when ((error as? GenAiException)?.errorCode) {
                GenAiException.ErrorCode.NOT_AVAILABLE -> NotOffered
                GenAiException.ErrorCode.AICORE_INCOMPATIBLE, GenAiException.ErrorCode.NEEDS_SYSTEM_UPDATE -> NeedsUpdate
                GenAiException.ErrorCode.NOT_ENOUGH_DISK_SPACE -> NeedsSpace
                GenAiException.ErrorCode.BUSY, GenAiException.ErrorCode.PER_APP_BATTERY_USE_QUOTA_EXCEEDED, GenAiException.ErrorCode.BACKGROUND_USE_BLOCKED -> Busy
                else -> Failed
            }
        }
    }

    const val RESPONSE_TOKENS = 256
    private const val INSTRUCTION_TOKENS = 260
    private const val CHARACTERS_PER_TOKEN = 3
    private const val FALLBACK_TOKEN_LIMIT = 4_000
    private const val STATUS_RETRY_DELAY_MS = 400L

    @Volatile
    private var client: GenerativeModel? = null
    private val background = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var downloading = false

    private fun model(): GenerativeModel? = client ?: runCatching { Generation.getClient() }.getOrNull()?.also { client = it }

    suspend fun availability(): Availability {
        val model = model() ?: return Availability.Failed
        val first = status(model)
        if (first != Availability.Busy && first != Availability.Failed) return first
        delay(STATUS_RETRY_DELAY_MS)
        return status(model)
    }

    private suspend fun status(model: GenerativeModel): Availability {
        val status = try {
            model.checkStatus()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            return Availability.of(error)
        }
        if (status == FeatureStatus.DOWNLOADABLE) startDownload(model)
        return Availability.of(status)
    }

    private fun startDownload(model: GenerativeModel) {
        if (downloading) return
        downloading = true
        background.launch {
            try {
                model.download().collect {}
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
            } finally {
                downloading = false
            }
        }
    }

    suspend fun characterBudget(): Int {
        val limit = runCatching { model()?.getTokenLimit() }.getOrNull() ?: FALLBACK_TOKEN_LIMIT
        return maxOf((limit - RESPONSE_TOKENS - INSTRUCTION_TOKENS) * CHARACTERS_PER_TOKEN, 2_000)
    }

    suspend fun stream(instructions: String, prompt: String, onText: (String) -> Unit) {
        val model = model() ?: throw IllegalStateException("Gemini Nano is not available")
        val request = generateContentRequest(TextPart("$instructions\n\n$prompt")) {
            temperature = 0.3f
            maxOutputTokens = RESPONSE_TOKENS
        }
        var text = ""
        model.generateContentStream(request).collect { chunk ->
            val delta = chunk.candidates.firstOrNull()?.text.orEmpty()
            if (delta.isEmpty()) return@collect
            text += delta
            onText(text)
        }
        if (text.isBlank()) throw IllegalStateException("Gemini Nano returned nothing")
    }
}
