package com.ardia.browser

import java.io.File
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PageMadeDownloadsTest {
    private val token = "0123456789abcdef0123456789abcdef"

    @Test
    fun aBlobsOriginIsItsCreatorsWebOrigin() {
        assertEquals("https://eligrey.com", PageMadeDownloads.blobOrigin("blob:https://eligrey.com/cf30724d-1"))
        assertEquals("https://a.example:8443", PageMadeDownloads.blobOrigin("blob:HTTPS://A.Example:8443/x"))
        assertEquals("https://a.example", PageMadeDownloads.blobOrigin("blob:https://a.example:443/x"))
        assertEquals("http://a.example", PageMadeDownloads.blobOrigin("blob:http://a.example:80/x"))
        assertEquals("https://eligrey.com", PageMadeDownloads.webOrigin("https://eligrey.com"))
        assertNull(PageMadeDownloads.blobOrigin("blob:null/cf30724d"))
        assertNull(PageMadeDownloads.blobOrigin("blob:file:///x"))
        assertNull(PageMadeDownloads.blobOrigin("blob:https://user@a.example/x"))
        assertNull(PageMadeDownloads.blobOrigin("blob:https:///x"))
        assertNull(PageMadeDownloads.blobOrigin("https://a.example/x"))
        assertNull(PageMadeDownloads.webOrigin("null"))
        assertNull(PageMadeDownloads.webOrigin("chrome-extension://abc"))
    }

    @Test
    fun tokensAreFreshHex() {
        val first = PageMadeDownloads.newToken()
        assertTrue(Regex("[0-9a-f]{32}").matches(first))
        assertFalse(first == PageMadeDownloads.newToken())
    }

    @Test
    fun messagesParseOnlyInTheirExactShape() {
        assertEquals(BlobMessage.Hello, PageMadeDownloads.parse("hello"))
        assertEquals(BlobMessage.Missing(token), PageMadeDownloads.parse("missing $token"))
        assertEquals(BlobMessage.Fail(token), PageMadeDownloads.parse("fail $token"))
        assertEquals(BlobMessage.Start(token, 12, "text/plain", "hello world.txt"), PageMadeDownloads.parse("start $token 12 text%2Fplain hello%20world.txt"))
        assertEquals(BlobMessage.Start(token, 0, null, null), PageMadeDownloads.parse("start $token 0  "))
        assertEquals(BlobMessage.Chunk(token, 3, "aGk="), PageMadeDownloads.parse("chunk $token 3 aGk="))
        assertEquals(BlobMessage.Name("blob:https://a.example/1", "a b.txt"), PageMadeDownloads.parse("name blob%3Ahttps%3A%2F%2Fa.example%2F1 a%20b.txt"))
        assertNull(PageMadeDownloads.parse("missing ${token.uppercase()}"))
        assertNull(PageMadeDownloads.parse("missing ${token}0"))
        assertNull(PageMadeDownloads.parse("start $token -1 x y"))
        assertNull(PageMadeDownloads.parse("start $token 1e3 x y"))
        assertNull(PageMadeDownloads.parse("start $token 1234567890123456 x y"))
        assertNull(PageMadeDownloads.parse("start $token 1 x"))
        assertNull(PageMadeDownloads.parse("chunk $token -1 aGk="))
        assertNull(PageMadeDownloads.parse("chunk $token 1 "))
        assertNull(PageMadeDownloads.parse("chunk $token 1 " + "A".repeat(PageMadeDownloads.MAX_CHUNK_CHARS + 4)))
        assertNull(PageMadeDownloads.parse("name blob%3Ax"))
        assertNull(PageMadeDownloads.parse("name blob%3Ax %2F%2F"))
        assertNull(PageMadeDownloads.parse("name blob%3Ax %FF.txt"))
        assertNull(PageMadeDownloads.parse("Hello"))
        assertNull(PageMadeDownloads.parse("next $token 1"))
    }

    @Test
    fun oversizedOrOverSplitMessagesAreRefusedWithoutSplittingThem() {
        assertNull(PageMadeDownloads.parse("name " + "a ".repeat(1_000_000)))
        assertNull(PageMadeDownloads.parse("start " + " ".repeat(1_000_000)))
        assertNull(PageMadeDownloads.parse("name " + "a".repeat(PageMadeDownloads.MAX_KEY_CHARS * 3 + 1) + " b.txt"))
        assertEquals(BlobMessage.Start(token, 1, "text/plain", null), PageMadeDownloads.parse("start $token 1 text%2Fplain " + "a".repeat(PageMadeDownloads.MAX_NAME_FIELD_CHARS + 1)))
        val party = java.net.URLEncoder.encode("\uD83C\uDF89".repeat(257) + ".txt", "UTF-8")
        assertEquals(3_088, party.length)
        assertEquals(BlobMessage.Start(token, 1, "text/plain", null), PageMadeDownloads.parse("start $token 1 text%2Fplain $party"))
        assertNull(PageMadeDownloads.parse("start $token 1 text%2Fplain " + "a".repeat(64 * 1024)))
        assertEquals(BlobMessage.Bye, PageMadeDownloads.parse("bye"))
        assertNull(PageMadeDownloads.parse("bye now"))
        assertNull(PageMadeDownloads.parse("chunk $token 0 " + "A".repeat(PageMadeDownloads.MAX_CHUNK_CHARS + 4)))
        assertNull(PageMadeDownloads.parse("missing $token extra"))
        assertNull(PageMadeDownloads.parse("verylongverb $token"))
        val fullChunk = "chunk $token 9999999 " + "A".repeat(PageMadeDownloads.MAX_CHUNK_CHARS)
        assertTrue(fullChunk.length <= PageMadeDownloads.MAX_MESSAGE_CHARS)
        assertEquals(BlobMessage.Chunk(token, 9_999_999, "A".repeat(PageMadeDownloads.MAX_CHUNK_CHARS)), PageMadeDownloads.parse(fullChunk))
        val started = System.nanoTime()
        repeat(200) { PageMadeDownloads.parse("name " + "a ".repeat(100_000)) }
        assertTrue((System.nanoTime() - started) / 1_000_000 < 2_000)
    }

    @Test
    fun chunksDecodeOnlyAsStrictBase64WithinTheChunkSize() {
        assertEquals("hi", String(PageMadeDownloads.decodeChunk("aGk=")!!))
        assertNull(PageMadeDownloads.decodeChunk("aGk"))
        assertNull(PageMadeDownloads.decodeChunk("a\nGk="))
        assertNull(PageMadeDownloads.decodeChunk("****"))
        assertNull(PageMadeDownloads.decodeChunk(""))
        val full = java.util.Base64.getEncoder().encodeToString(ByteArray(PageMadeDownloads.CHUNK_BYTES))
        assertEquals(PageMadeDownloads.MAX_CHUNK_CHARS, full.length)
        assertEquals(PageMadeDownloads.CHUNK_BYTES, PageMadeDownloads.decodeChunk(full)!!.size)
    }

    @Test
    fun dataAddressesAreKeyedByLengthAndEdges() {
        val url = "data:text/plain," + "x".repeat(500)
        assertEquals("${url.length}:${url.take(64)}:${url.takeLast(64)}", PageMadeDownloads.nameKey(url))
        assertEquals("blob:https://a.example/1", PageMadeDownloads.nameKey("blob:https://a.example/1"))
        assertNull(PageMadeDownloads.nameKey("https://a.example/1"))
    }

    @Test
    fun aDispositionCarriesTheNameBackIntact() {
        for (name in listOf("hello world.txt", "café +1.png", "a;b\"c.txt", "名前.pdf")) {
            assertEquals(name, DownloadRules.dispositionName(PageMadeDownloads.dispositionFor(name)))
        }
    }

    @Test
    fun pageMadeNamesPreferThePagesNameAndFixTheExtension() {
        val extension = { type: String -> mapOf("text/plain" to "txt", "image/png" to "png")[type] }
        assertEquals("hello world.txt", DownloadRules.pageMadeName("hello world.txt", "cf30724d.txt", "text/plain", extensionFor = extension))
        assertEquals("notes.txt", DownloadRules.pageMadeName("notes", "cf30724d.bin", "text/plain", extensionFor = extension))
        assertEquals("cf30724d.png", DownloadRules.pageMadeName(null, "cf30724d.bin", "image/png", extensionFor = extension))
        assertEquals("cf30724d.txt", DownloadRules.pageMadeName("  ", "cf30724d.txt", "text/plain;charset=utf-8", extensionFor = extension))
        assertEquals("cf30724d.bin", DownloadRules.pageMadeName(null, "cf30724d.bin", null, extensionFor = extension))
        assertEquals("passwd", DownloadRules.pageMadeName("../../etc/passwd", "x.bin", null, extensionFor = extension))
        assertEquals("Download", DownloadRules.pageMadeName(null, "..", null, extensionFor = extension))
    }

    @Test
    fun fileNamesDropInvisibleAndDirectionCharacters() {
        assertEquals("invoicetxt.apk", DownloadRules.safeFileName("invoice‮txt.apk"))
        assertEquals("ab.txt", DownloadRules.safeFileName("a​b﻿.txt"))
        assertEquals("ab.txt", DownloadRules.safeFileName("a\u0085  b.txt"))
        assertEquals("ab.txt", DownloadRules.safeFileName("a\uD800b.txt"))
        assertEquals("party 🎉.txt", DownloadRules.safeFileName("party 🎉.txt"))
        val long = DownloadRules.safeFileName("🎉".repeat(100))
        assertFalse(long.isNotEmpty() && Character.isHighSurrogate(long.last()))
    }

    @Test
    fun everySharedHostileValueReachesTheSinksCleanOrNotAtAll() {
        val hostile = sharedHostileStrings()
        assertTrue("the shared list loaded", hostile.size > 50)
        val lineTerminators = Regex("[\\n\\r\\u000c\\u000b\\u0085\\u2028\\u2029]")
        fun assertCleanName(id: String, name: String?) {
            if (name == null) return
            assertFalse("$id: $name", lineTerminators.containsMatchIn(name))
            assertFalse("$id: $name", name.any { it < ' ' || it in '\u007f'..'\u009f' || it in "/\\:*?\"<>|" || Character.getType(it) == Character.FORMAT.toInt() })
            assertFalse("$id: $name", hasLoneSurrogate(name))
            assertFalse("$id: $name", name.startsWith(".") || name.isBlank())
            assertTrue("$id: ${name.length}", name.length <= 120)
        }
        val encode = { value: String -> java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20") }
        for ((id, value) in hostile) {
            val named = PageMadeDownloads.parse("name ${encode("blob:https://a.example/1")} ${encode(value)}") as? BlobMessage.Name
            assertCleanName("name/$id", named?.name)
            val started = PageMadeDownloads.parse("start $token 1 ${encode(value)} ${encode(value)}") as? BlobMessage.Start
            assertCleanName("start/$id", started?.name)
            started?.mimeType?.let { assertTrue("mime/$id: $it", Regex("[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*").matches(it)) }
            PageMadeDownloads.cleanMimeType(value)?.let { assertFalse("mime/$id", lineTerminators.containsMatchIn(it) || it.contains(' ')) }
            assertCleanName("pageMade/$id", DownloadRules.pageMadeName(value, value, value) { null })
            assertCleanName("safe/$id", DownloadRules.safeFileName(value))
            PageMadeDownloads.blobOrigin("blob:$value")?.let { assertTrue("origin/$id: $it", Regex("https?://[^\\s/@\\\\]+").matches(it)) }
            PageMadeDownloads.blobOrigin("blob:https://a.example$value/x")?.let { assertTrue("origin/$id: $it", Regex("https://[^\\s/@\\\\]+").matches(it)) }
            DataUrls.parse("data:$value,x")?.let { assertTrue("data/$id: ${it.mimeType}", PageMadeDownloads.cleanMimeType(it.mimeType) == it.mimeType) }
            assertNull("token/$id", PageMadeDownloads.parse("missing $value"))
        }
        val control = PageMadeDownloads.parse("start $token 1 ${encode("text/plain")} ${encode("report.pdf")}") as BlobMessage.Start
        assertEquals("report.pdf", control.name)
        assertEquals("text/plain", control.mimeType)
    }

    private fun hasLoneSurrogate(text: String): Boolean {
        var index = 0
        while (index < text.length) {
            val char = text[index]
            if (Character.isHighSurrogate(char) && index + 1 < text.length && Character.isLowSurrogate(text[index + 1])) {
                index += 2
                continue
            }
            if (Character.isSurrogate(char)) return true
            index += 1
        }
        return false
    }

    private fun sharedHostileStrings(): List<Pair<String, String>> {
        var root: File? = File("").absoluteFile
        while (root != null && !File(root, "scripts/security/hostile-inputs.mjs").exists()) root = root.parentFile
        val module = File(root ?: error("the repo root was not found"), "scripts/security/hostile-inputs.mjs")
        val process = ProcessBuilder(
            "node",
            "--input-type=module",
            "-e",
            "const m = await import(process.argv[1]); console.log(JSON.stringify(m.HOSTILE_STRINGS.map((v) => [v.id, v.value])))",
            module.toURI().toString(),
        ).redirectErrorStream(true).start()
        val output = process.inputStream.bufferedReader().readText()
        assertTrue("node finished", process.waitFor(30, TimeUnit.SECONDS))
        assertEquals(output, 0, process.exitValue())
        val rows = JSONArray(output.trim())
        return (0 until rows.length()).map { rows.getJSONArray(it).let { row -> row.getString(0) to row.getString(1) } }
    }
}
