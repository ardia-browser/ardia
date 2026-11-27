package com.ardia.phone

import java.io.ByteArrayInputStream
import java.nio.file.Files
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppUpdateHandoffTest {
    private val base = "https://github.com/ardia-browser/ardia/releases/download"

    @Test
    fun takesOnlyThisRepositorysReleaseApk() {
        assertEquals("Ardia-1.0.2.apk", AppUpdateHandoff.releaseApkName("$base/android-v1.0.2/Ardia-1.0.2.apk"))
        assertEquals("Ardia-1.0.3-nightly.2.apk", AppUpdateHandoff.releaseApkName("$base/android-v1.0.3-nightly.2/Ardia-1.0.3-nightly.2.apk"))
        listOf(
            "$base/android-v1.0.2/Ardia-1.0.3.apk",
            "$base/android-v1.0.02/Ardia-1.0.02.apk",
            "$base/android-v1.0.2/Ardia-1.0.2.apk?x=1",
            "$base/android-v1.0.2/Ardia-1.0.2.apk#x",
            "$base/android-v1.0.2/Ardia-1.0.2.apk\n",
            "$base/android-v1.0.2/../android-v1.0.2/Ardia-1.0.2.apk",
            "http://github.com/ardia-browser/ardia/releases/download/android-v1.0.2/Ardia-1.0.2.apk",
            "https://github.com.evil.example/ardia-browser/ardia/releases/download/android-v1.0.2/Ardia-1.0.2.apk",
            "https://user@github.com/ardia-browser/ardia/releases/download/android-v1.0.2/Ardia-1.0.2.apk",
            "https://github.com/someone/ardia/releases/download/android-v1.0.2/Ardia-1.0.2.apk",
            "javascript:alert(1)",
            "file:///sdcard/Download/Ardia-1.0.2.apk",
            "",
            "$base/android-v1.0.2/Ardia-1.0.2.apk" + "x".repeat(300),
        ).forEach { assertNull(it, AppUpdateHandoff.releaseApkName(it)) }
    }

    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    @Test
    fun keepsOnlyACopyWhoseSha256MatchesTheRelease() {
        val directory = Files.createTempDirectory("updates").toFile()
        val apk = ByteArray(300_000) { (it * 31).toByte() }
        val copy = directory.resolve("Ardia-1.0.2.apk")
        assertEquals("verified", AppUpdateHandoff.verifiedCopy(ByteArrayInputStream(apk), copy, sha256(apk)))
        assertTrue(copy.readBytes().contentEquals(apk))
        val tampered = apk.copyOf().also { it[1234] = (it[1234] + 1).toByte() }
        assertEquals("mismatch", AppUpdateHandoff.verifiedCopy(ByteArrayInputStream(tampered), copy, sha256(apk)))
        assertFalse(copy.exists())
        assertEquals(emptyList<String>(), directory.list()!!.toList())
        directory.deleteRecursively()
    }

    @Test
    fun aCopyThatFailsHalfwayLeavesNothingBehindAndSaysSo() {
        val directory = Files.createTempDirectory("updates").toFile()
        val apk = ByteArray(300_000) { (it * 7).toByte() }
        val breaking = object : java.io.InputStream() {
            private var served = 0
            override fun read(): Int = throw UnsupportedOperationException()
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                if (served > 100_000) throw java.io.IOException("storage went away")
                val count = minOf(length, apk.size - served)
                System.arraycopy(apk, served, buffer, offset, count)
                served += count
                return count
            }
        }
        assertEquals("copy_failed", AppUpdateHandoff.verifiedCopy(breaking, directory.resolve("Ardia-1.0.2.apk"), sha256(apk)))
        assertEquals(emptyList<String>(), directory.list()!!.toList())
        directory.deleteRecursively()
    }
}
