package com.ardia.browser

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DataUrlsTest {
    private fun bytes(url: String): ByteArray {
        val parsed = DataUrls.parse(url)
        assertNotNull(url, parsed)
        val body = parsed!!.body().use { it.readBytes() }
        assertEquals("the declared length matches what the body gives for $url", parsed.byteCount, body.size.toLong())
        return body
    }

    @Test
    fun plainTextIsPercentDecoded() {
        assertEquals("hello world", String(bytes("data:,hello%20world")))
        assertEquals("a,b", String(bytes("data:text/plain,a,b")))
        assertEquals("café", String(bytes("data:text/plain;charset=utf-8,caf%C3%A9")))
        assertEquals("café", String(bytes("data:text/plain;charset=utf-8,café")))
        assertEquals("100%", String(bytes("data:,100%")))
        assertEquals("%zz", String(bytes("data:,%zz")))
    }

    @Test
    fun base64IsDecodedForgivingWhitespaceAndPercentEncoding() {
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
        val encoded = java.util.Base64.getEncoder().encodeToString(png)
        assertArrayEquals(png, bytes("data:image/png;base64,$encoded"))
        assertArrayEquals(png, bytes("data:image/png;base64,${encoded.chunked(3).joinToString(" \n")}"))
        assertArrayEquals(png, bytes("data:image/png;BASE64,${encoded.replace("=", "%3D")}"))
        assertEquals("hi?", String(bytes("data:;base64,aGk/")))
        assertEquals("hi?", String(bytes("data:;base64,aGk%2F")))
        assertEquals("a", String(bytes("data:;base64,YQ")))
        assertEquals("ab", String(bytes("data:;base64,YWI")))
        assertEquals("", String(bytes("data:;base64,")))
    }

    @Test
    fun malformedBase64IsRefused() {
        assertNull(DataUrls.parse("data:;base64,a"))
        assertNull(DataUrls.parse("data:;base64,YQ==="))
        assertNull(DataUrls.parse("data:;base64,YQ=A"))
        assertNull(DataUrls.parse("data:;base64,Y*Q="))
        assertNull(DataUrls.parse("data:;base64,YQ="))
    }

    @Test
    fun theTypeDefaultsToPlainTextAndIsCleaned() {
        assertEquals("text/plain", DataUrls.parse("data:,x")!!.mimeType)
        assertEquals("image/svg+xml", DataUrls.parse("data:IMAGE/SVG+XML;charset=utf-8,<svg/>")!!.mimeType)
        assertEquals("text/plain", DataUrls.parse("data:text/html\r\nx-evil: 1,x")!!.mimeType)
        assertEquals("text/plain", DataUrls.parse("data:../../etc,x")!!.mimeType)
        assertEquals("application/pdf", DataUrls.parse("data:application%2Fpdf;base64,JVBERi0=")!!.mimeType)
    }

    @Test
    fun theFragmentIsNotPartOfThePayload() {
        assertEquals("abc", String(bytes("data:,abc#frag")))
    }

    @Test
    fun onlyDataAddressesWithAHeaderAreTaken() {
        assertTrue(DataUrls.hasHeader("DATA:,x"))
        assertFalse(DataUrls.hasHeader("data:text/plain"))
        assertFalse(DataUrls.hasHeader("blob:https://a.example/1"))
        assertFalse(DataUrls.hasHeader("data:" + "a".repeat(2000) + ",x"))
        assertNull(DataUrls.parse("https://a.example/data:,x"))
        assertNull(DataUrls.parse("data:" + "a".repeat(2000) + ",x"))
    }

    @Test
    fun aPayloadOverTheCapIsRefused() {
        assertNull(DataUrls.parse("data:,${"a".repeat(101)}", maxBytes = 100))
        assertNotNull(DataUrls.parse("data:,${"a".repeat(100)}", maxBytes = 100))
        assertNull(DataUrls.parse("data:;base64,${"QUFB".repeat(34)}", maxBytes = 100))
    }

    @Test
    fun aLargePayloadDecodesQuickly() {
        val raw = ByteArray(8 * 1024 * 1024) { (it * 31).toByte() }
        val url = "data:application/octet-stream;base64," + java.util.Base64.getEncoder().encodeToString(raw)
        val started = System.nanoTime()
        assertArrayEquals(raw, bytes(url))
        val millis = (System.nanoTime() - started) / 1_000_000
        println("ArdiaDownloadTiming 8 MB base64 data address parsed and decoded in $millis ms")
        assertTrue("decoding took $millis ms", millis < 5_000)
    }
}
