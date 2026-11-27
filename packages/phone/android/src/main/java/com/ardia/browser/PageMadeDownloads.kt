package com.ardia.browser

import java.security.SecureRandom

sealed interface BlobMessage {
    data object Hello : BlobMessage

    data class Name(val key: String, val name: String) : BlobMessage

    sealed interface ForRequest : BlobMessage {
        val token: String
    }

    data class Missing(override val token: String) : ForRequest

    data class Start(override val token: String, val size: Long, val mimeType: String?, val name: String?) : ForRequest

    data class Chunk(override val token: String, val index: Int, val base64: String) : ForRequest

    data class Fail(override val token: String) : ForRequest
}

object PageMadeDownloads {
    const val PREFIX = "ardiaBlob:"
    const val MAX_BYTES = 512L * 1024 * 1024
    const val CHUNK_BYTES = 192 * 1024
    const val MAX_CHUNK_CHARS = CHUNK_BYTES / 3 * 4
    const val MAX_NAME_CHARS = 1024
    const val MAX_KEY_CHARS = 2048
    const val DATA_KEY_EDGE = 64
    private const val TOKEN_BYTES = 16
    private const val MAX_SIZE_DIGITS = 15
    private const val MAX_INDEX_DIGITS = 7
    private val tokenPattern = Regex("[0-9a-f]{32}")
    private val digits = Regex("[0-9]+")
    private val mimeToken = Regex("[a-z0-9][a-z0-9!#$&^_.+-]{0,126}")
    private val random = SecureRandom()

    fun newToken(): String {
        val bytes = ByteArray(TOKEN_BYTES).also(random::nextBytes)
        return bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    fun isBlob(url: String): Boolean = url.regionMatches(0, "blob:", 0, 5, ignoreCase = true)

    fun blobOrigin(url: String): String? {
        if (!isBlob(url)) return null
        return webOrigin(url.substring(5))
    }

    fun webOrigin(url: String): String? {
        val scheme = BrowserUrl.scheme(url)?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        val afterScheme = url.indexOf("://").takeIf { it >= 0 }?.plus(3) ?: return null
        val end = url.indexOfAny(charArrayOf('/', '?', '#'), afterScheme).takeIf { it >= 0 } ?: url.length
        val authority = url.substring(afterScheme, end)
        if (authority.isEmpty() || authority.contains('@') || authority.any { it <= ' ' || it.code >= 0x7f || it == '\\' }) return null
        val lowered = authority.lowercase()
        val trimmed = when {
            scheme == "https" && lowered.endsWith(":443") -> lowered.dropLast(4)
            scheme == "http" && lowered.endsWith(":80") -> lowered.dropLast(3)
            else -> lowered
        }
        if (trimmed.isEmpty() || trimmed.startsWith(':')) return null
        return "$scheme://$trimmed"
    }

    fun nameKey(url: String): String? = when {
        isBlob(url) -> url.takeIf { it.length <= MAX_KEY_CHARS }
        DataUrls.isData(url) -> "${url.length}:${url.take(DATA_KEY_EDGE)}:${url.takeLast(DATA_KEY_EDGE)}"
        else -> null
    }

    fun cleanMimeType(raw: String?): String? {
        val type = raw?.substringBefore(';')?.trim()?.lowercase()?.ifEmpty { null } ?: return null
        val slash = type.indexOf('/')
        if (slash <= 0 || slash != type.lastIndexOf('/')) return null
        val major = type.substring(0, slash)
        val minor = type.substring(slash + 1)
        if (major.length > 63 || !mimeToken.matches(major) || !mimeToken.matches(minor)) return null
        return type
    }

    fun parse(text: String): BlobMessage? {
        if (text == "hello") return BlobMessage.Hello
        val verb = text.substringBefore(' ')
        val rest = text.substringAfter(' ', "")
        return when (verb) {
            "name" -> {
                val parts = rest.split(' ')
                if (parts.size != 2 || parts[0].length > MAX_KEY_CHARS * 3 || parts[1].length > MAX_NAME_CHARS * 3) return null
                val key = decoded(parts[0])?.takeIf { it.isNotEmpty() && it.length <= MAX_KEY_CHARS } ?: return null
                val name = decoded(parts[1])?.takeIf { it.length <= MAX_NAME_CHARS }?.let(::cleanName) ?: return null
                BlobMessage.Name(key, name)
            }
            "missing" -> token(rest)?.let(BlobMessage::Missing)
            "fail" -> token(rest)?.let(BlobMessage::Fail)
            "start" -> {
                val parts = rest.split(' ')
                if (parts.size != 4) return null
                val token = token(parts[0]) ?: return null
                val size = parts[1].takeIf { it.length <= MAX_SIZE_DIGITS && digits.matches(it) }?.toLongOrNull() ?: return null
                if (parts[2].length > 512 || parts[3].length > MAX_NAME_CHARS * 3) return null
                val mimeType = cleanMimeType(decoded(parts[2]))
                val name = decoded(parts[3])?.takeIf { it.length <= MAX_NAME_CHARS }?.let(::cleanName)
                BlobMessage.Start(token, size, mimeType, name)
            }
            "chunk" -> {
                val first = rest.indexOf(' ')
                val second = rest.indexOf(' ', first + 1)
                if (first < 0 || second < 0) return null
                val token = token(rest.substring(0, first)) ?: return null
                val index = rest.substring(first + 1, second).takeIf { it.length <= MAX_INDEX_DIGITS && digits.matches(it) }?.toIntOrNull() ?: return null
                val base64 = rest.substring(second + 1)
                if (base64.isEmpty() || base64.length > MAX_CHUNK_CHARS) return null
                BlobMessage.Chunk(token, index, base64)
            }
            else -> null
        }
    }

    fun decodeChunk(base64: String): ByteArray? {
        if (base64.isEmpty() || base64.length > MAX_CHUNK_CHARS || base64.length % 4 != 0) return null
        return runCatching { java.util.Base64.getDecoder().decode(base64) }.getOrNull()?.takeIf { it.isNotEmpty() && it.size <= CHUNK_BYTES }
    }

    fun dispositionFor(name: String): String =
        "attachment; filename*=UTF-8''" + java.net.URLEncoder.encode(name, Charsets.UTF_8.name()).replace("+", "%20")

    private fun cleanName(raw: String): String? = DownloadRules.safeFileName(raw, "").ifEmpty { null }

    private fun token(raw: String): String? = raw.takeIf { tokenPattern.matches(it) }

    private fun decoded(raw: String): String? {
        val bytes = PercentBytes(raw, 0, raw.length).readAll() ?: return null
        val decoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
            .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
        return runCatching { decoder.decode(java.nio.ByteBuffer.wrap(bytes)).toString() }.getOrNull()
    }
}
