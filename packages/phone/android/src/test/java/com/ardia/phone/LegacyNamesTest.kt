package com.ardia.phone

import org.junit.Assert.assertEquals
import org.junit.Test

class LegacyNamesTest {
    private val frozen: Map<String, String> by lazy {
        val stream = javaClass.getResourceAsStream(FIXTURE) ?: error("$FIXTURE is missing")
        stream.bufferedReader().readLines().filter { it.isNotBlank() }.associate { line ->
            val (path, declaration) = line.split('\t', limit = 2)
            val (name, value) = Regex("""const val (\w+) = "([^"]+)"""").find(declaration)?.destructured ?: error("no constant in $line")
            "${path.substringAfterLast('/')}#$name" to value
        }
    }

    private fun constant(file: String, name: String): String = frozen["$file#$name"] ?: error("$name from $file isn't in $FIXTURE")

    @Test
    fun theLegacyReaderOpensTheFilesTheComposeAppWrites() {
        assertEquals("the Compose app's database", constant("BrowserDatabase.kt", "FILE_NAME"), PhoneLegacy.DATABASE_FILE)
        assertEquals("its browser preferences", constant("BrowserStore.kt", "PREFERENCES_NAME"), PhoneLegacy.BROWSER)
        assertEquals("its blocking preferences", constant("AppEnvironment.kt", "BLOCKING_PREFERENCES"), PhoneLegacy.BLOCKING)
        assertEquals("its reader preferences", constant("ReaderView.kt", "STORE"), PhoneLegacy.READER)
    }

    @Test
    fun theFrozenNamesAreTheReleaseReferencesFourAndNoMore() {
        assertEquals(4, frozen.size)
    }

    private companion object {
        const val FIXTURE = "compose-store-names-01a149d87.tsv"
    }
}
