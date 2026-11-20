package com.ardia.phone

import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.prompt.Generation
import com.google.mlkit.genai.prompt.GenerativeModel
import com.google.mlkit.genai.prompt.TextPart
import com.google.mlkit.genai.prompt.generateContentRequest
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

internal object OnDeviceWriter {
    enum class Availability { Available, Downloading, Unavailable }

    const val RESPONSE_TOKENS = 256
    private const val INSTRUCTION_TOKENS = 260
    private const val CHARACTERS_PER_TOKEN = 3
    private const val FALLBACK_TOKEN_LIMIT = 4_000

    private val model: GenerativeModel? by lazy { runCatching { Generation.getClient() }.getOrNull() }
    private val background = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var downloading = false

    suspend fun availability(): Availability {
        val client = model ?: return Availability.Unavailable
        val status = try {
            client.checkStatus()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            return Availability.Unavailable
        }
        return when (status) {
            FeatureStatus.AVAILABLE -> Availability.Available
            FeatureStatus.DOWNLOADABLE -> {
                startDownload(client)
                Availability.Downloading
            }
            FeatureStatus.DOWNLOADING -> Availability.Downloading
            else -> Availability.Unavailable
        }
    }

    private fun startDownload(client: GenerativeModel) {
        if (downloading) return
        downloading = true
        background.launch {
            try {
                client.download().collect {}
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
            } finally {
                downloading = false
            }
        }
    }

    suspend fun characterBudget(): Int {
        val limit = runCatching { model?.getTokenLimit() }.getOrNull() ?: FALLBACK_TOKEN_LIMIT
        return maxOf((limit - RESPONSE_TOKENS - INSTRUCTION_TOKENS) * CHARACTERS_PER_TOKEN, 2_000)
    }

    suspend fun stream(instructions: String, prompt: String, onText: (String) -> Unit) {
        val client = model ?: throw IllegalStateException("Gemini Nano is not available")
        val request = generateContentRequest(TextPart("$instructions\n\n$prompt")) {
            temperature = 0.3f
            maxOutputTokens = RESPONSE_TOKENS
        }
        var text = ""
        client.generateContentStream(request).collect { chunk ->
            val delta = chunk.candidates.firstOrNull()?.text.orEmpty()
            if (delta.isEmpty()) return@collect
            text += delta
            onText(text)
        }
        if (text.isBlank()) throw IllegalStateException("Gemini Nano returned nothing")
    }
}
