package com.ardia.browser

import java.io.InputStream

class DataUrl internal constructor(
    val mimeType: String,
    val isBase64: Boolean,
    val byteCount: Long,
    private val url: String,
    private val payloadStart: Int,
    private val payloadEnd: Int,
) {
    fun body(): InputStream = DataUrlBody(if (isBase64) Base64Bytes(PercentBytes(url, payloadStart, payloadEnd)) else PercentBytes(url, payloadStart, payloadEnd))
}

object DataUrls {
    const val DEFAULT_MIME_TYPE = "text/plain"
    private const val SCHEME = "data:"
    private const val MAX_HEADER_LENGTH = 1024

    fun isData(url: String): Boolean = url.regionMatches(0, SCHEME, 0, SCHEME.length, ignoreCase = true)

    fun hasHeader(url: String): Boolean {
        if (!isData(url)) return false
        val comma = url.indexOf(',', SCHEME.length)
        return comma >= 0 && comma - SCHEME.length <= MAX_HEADER_LENGTH
    }

    fun parse(url: String, maxBytes: Long = PageMadeDownloads.MAX_BYTES): DataUrl? {
        if (!isData(url)) return null
        val comma = url.indexOf(',', SCHEME.length)
        if (comma < 0 || comma - SCHEME.length > MAX_HEADER_LENGTH) return null
        val params = url.substring(SCHEME.length, comma).split(';').map { it.trim() }
        val isBase64 = params.size > 1 && params.last().equals("base64", ignoreCase = true)
        val declared = PercentBytes(params.first(), 0, params.first().length).readAll()?.toString(Charsets.UTF_8)
        val mimeType = PageMadeDownloads.cleanMimeType(declared) ?: DEFAULT_MIME_TYPE
        val fragment = url.indexOf('#', comma + 1)
        val end = if (fragment < 0) url.length else fragment
        val byteCount = if (isBase64) base64Length(url, comma + 1, end) else plainLength(url, comma + 1, end, maxBytes)
        if (byteCount == null || byteCount > maxBytes) return null
        return DataUrl(mimeType, isBase64, byteCount, url, comma + 1, end)
    }

    private fun plainLength(url: String, start: Int, end: Int, maxBytes: Long): Long? {
        val bytes = PercentBytes(url, start, end)
        var count = 0L
        while (bytes.next() >= 0) {
            count += 1
            if (count > maxBytes) return null
        }
        return count
    }

    private fun base64Length(url: String, start: Int, end: Int): Long? {
        val bytes = PercentBytes(url, start, end)
        var symbols = 0L
        var padding = 0
        while (true) {
            val byte = bytes.next()
            if (byte < 0) break
            when {
                isBase64Space(byte) -> Unit
                byte == '='.code -> padding += 1
                padding > 0 -> return null
                base64Value(byte) >= 0 -> symbols += 1
                else -> return null
            }
        }
        if (padding > 2) return null
        if (padding > 0 && (symbols + padding) % 4 != 0L) return null
        if (symbols % 4 == 1L) return null
        return symbols / 4 * 3 + when (symbols % 4) {
            2L -> 1
            3L -> 2
            else -> 0
        }
    }

    internal fun isBase64Space(byte: Int): Boolean = byte == 0x20 || byte == 0x09 || byte == 0x0a || byte == 0x0c || byte == 0x0d

    internal fun base64Value(byte: Int): Int = when (byte) {
        in 'A'.code..'Z'.code -> byte - 'A'.code
        in 'a'.code..'z'.code -> byte - 'a'.code + 26
        in '0'.code..'9'.code -> byte - '0'.code + 52
        '+'.code -> 62
        '/'.code -> 63
        else -> -1
    }
}

internal interface ByteCursor {
    fun next(): Int
}

internal class PercentBytes(private val text: String, private var index: Int, private val end: Int) : ByteCursor {
    private var pending: ByteArray? = null
    private var pendingAt = 0

    override fun next(): Int {
        pending?.let { held ->
            if (pendingAt < held.size) return held[pendingAt++].toInt() and 0xff
            pending = null
        }
        if (index >= end) return -1
        val char = text[index]
        if (char == '%' && index + 2 < end) {
            val high = Character.digit(text[index + 1], 16)
            val low = Character.digit(text[index + 2], 16)
            if (high >= 0 && low >= 0) {
                index += 3
                return high * 16 + low
            }
        }
        if (char.code < 0x80) {
            index += 1
            return char.code
        }
        val width = if (Character.isHighSurrogate(char) && index + 1 < end && Character.isLowSurrogate(text[index + 1])) 2 else 1
        val encoded = text.substring(index, index + width).toByteArray(Charsets.UTF_8)
        index += width
        pending = encoded
        pendingAt = 1
        return encoded[0].toInt() and 0xff
    }

    fun readAll(): ByteArray? {
        val out = java.io.ByteArrayOutputStream()
        while (true) {
            val byte = next()
            if (byte < 0) return out.toByteArray()
            out.write(byte)
        }
    }
}

internal class Base64Bytes(private val source: ByteCursor) : ByteCursor {
    private var held = 0
    private var bits = 0

    override fun next(): Int {
        while (true) {
            if (bits >= 8) {
                bits -= 8
                return (held shr bits) and 0xff
            }
            val byte = source.next()
            if (byte < 0) return -1
            val value = DataUrls.base64Value(byte)
            if (value < 0) continue
            held = ((held shl 6) or value) and 0xffffff
            bits += 6
        }
    }
}

private class DataUrlBody(private val cursor: ByteCursor) : InputStream() {
    override fun read(): Int = cursor.next()

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (length == 0) return 0
        var count = 0
        while (count < length) {
            val byte = cursor.next()
            if (byte < 0) break
            buffer[offset + count] = byte.toByte()
            count += 1
        }
        return if (count == 0) -1 else count
    }
}
