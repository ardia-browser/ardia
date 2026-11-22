package com.ardia.browser

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PageScriptsTest {
    private val iphoneWeb = File("../ios/ArdiaKit/Sources/ArdiaBrowser/Web")
    private val assets = File("src/main/assets/ardia-browser")

    private fun swiftScript(file: String, marker: String): List<String> {
        val source = File(iphoneWeb, file).readText()
        val start = source.indexOf('\n', source.indexOf(marker)) + 1
        val end = source.indexOf("\"\"\"#", start)
        return source.substring(start, end).trimEnd(' ').removeSuffix("\n").split('\n').map { it.removePrefix("  ") }
    }

    @Test
    fun readerScriptIsTheIphoneScript() {
        val iphone = swiftScript("ReadableContent.swift", "static let script = #\"\"\"")
        assertEquals(iphone, File(assets, "readable-content.js").readText().removeSuffix("\n").split('\n'))
    }

    private fun block(lines: List<String>, first: String, last: String): List<String> {
        val trimmed = lines.map { it.trim() }
        val start = trimmed.indexOfFirst { it.startsWith(first) }
        val end = (start until trimmed.size).first { trimmed[it] == last }
        return trimmed.subList(start, end + 1)
    }

    @Test
    fun nightShadeShadesAndMeasuresPagesAsTheIphoneDoes() {
        val iphone = swiftScript("NightShade.swift", "static let nightShadeSource = #\"\"\"")
        val android = File(assets, "night-shade.js").readText().split('\n')
        assertEquals(block(iphone, "const CSS =", "\"picture img{filter:none!important}\";"), block(android, "const CSS =", "\"picture img{filter:none!important}\";"))
        assertEquals(block(iphone, "const luminance =", "};"), block(android, "const luminance =", "};"))
        val iphoneMeasure = block(iphone, "const pageIsLight =", "};")
        assertEquals(iphoneMeasure, block(android, "const pageIsLight =", "};"))
        assertTrue(iphoneMeasure.size > 5)
        val pending = { lines: List<String> -> lines.map { it.trim() }.single { it.startsWith("const stylesPending =") } }
        assertEquals(pending(iphone), pending(android))
    }

    @Test
    fun nightShadeStartsWithItsHostsStateBakedIn() {
        val script = "(baked) => {\n  window.__seen = baked;\n}\n"
        val start = PageScripts.nightShadeAtStart(script, "yahoo.com", NightShadeMode.Always, NightShadeVerdict.Light)
        assertTrue(start.startsWith("if (window === window.top) {"))
        assertTrue(start.contains("((baked) => {\n  window.__seen = baked;\n})({\"host\":\"yahoo.com\",\"mode\":\"always\",\"verdict\":\"light\"});"))
        val unknown = PageScripts.nightShadeAtStart(script, null, NightShadeMode.Automatic, null)
        assertTrue(unknown.contains("({\"host\":null,\"mode\":\"automatic\",\"verdict\":\"unknown\"});"))
        val quoted = PageScripts.nightShadeAtStart(script, "a\"b\\c", NightShadeMode.Disabled, NightShadeVerdict.Dark)
        assertTrue(quoted.contains("\"host\":\"a\\\"b\\\\c\""))
    }

    @Test
    fun theNightShadeAssetIsAFunctionOfItsBakedState() {
        val asset = File(assets, "night-shade.js").readText().trim()
        assertTrue(asset.startsWith("(baked) => {"))
        assertTrue(asset.endsWith("}"))
        assertTrue(asset.contains("\"${PageScripts.NIGHT_SHADE_MESSAGE}\""))
        assertTrue(asset.contains("\"${PageScripts.NIGHT_SHADE_VERDICT_MESSAGE}\""))
        assertTrue(asset.contains("window.${PageScripts.BRIDGE_NAME}"))
    }

    @Test
    fun everyScriptThePagesReadIsAnAsset() {
        val sources = File("src/main/java/com/ardia/browser/PageScripts.kt").readText()
        val names = Regex("read\\(\"([^\"]+)\"\\)").findAll(sources).map { it.groupValues[1] }.toList()
        assertEquals(listOf("night-shade.js", "readable-content.js", "page-look.js"), names)
        for (name in names) assertTrue(name, File(assets, name).isFile)
    }

    @Test
    fun nightShadeAnswersAndReportsAreParsedStrictly() {
        assertEquals("always light", PageScripts.nightShadeState(NightShadeMode.Always, NightShadeVerdict.Light))
        assertEquals("disabled unknown", PageScripts.nightShadeState(NightShadeMode.Disabled, null))
        assertEquals(NightShadeVerdict.Dark, PageScripts.nightShadeVerdict("nightShadeVerdict:dark"))
        assertEquals(NightShadeVerdict.Light, PageScripts.nightShadeVerdict("nightShadeVerdict:light"))
        assertNull(PageScripts.nightShadeVerdict("nightShadeVerdict:sepia"))
        assertNull(PageScripts.nightShadeVerdict("nightShade"))
        assertNull(PageScripts.nightShadeVerdict(null))
        assertNull(TouchScrollers.parse("nightShadeVerdict:light", 7L))
    }

    @Test
    fun noFilterScriptsInstallsNothing() {
        assertNull(PageScripts.filterBundle(emptyList(), emptyList()))
    }

    @Test
    fun filterScriptsRunInTheMainFrameEachIsolatedFromTheOthersFailures() {
        val bundle = PageScripts.filterBundle(listOf("first()", "second()"), emptyList())!!
        assertTrue(bundle.startsWith("(() => {\nif (window !== window.top) return;"))
        assertEquals(2, Regex("try \\{").findAll(bundle).count())
        assertTrue(bundle.indexOf("first()") < bundle.indexOf("second()"))
        assertTrue(!bundle.contains("DOMContentLoaded"))
    }

    @Test
    fun documentEndScriptsWaitForDomContentLoaded() {
        val bundle = PageScripts.filterBundle(listOf("early()"), listOf("late()"))!!
        val listener = bundle.indexOf("DOMContentLoaded")
        assertTrue(bundle.indexOf("early()") < bundle.indexOf("runAtDocumentEnd"))
        assertTrue(bundle.indexOf("late()") in bundle.indexOf("runAtDocumentEnd")..listener)
        assertTrue(bundle.contains("else runAtDocumentEnd();"))
    }

    @Test
    fun nightShadeCallNamesTheMode() {
        assertEquals("window.__ardiaNightShade && window.__ardiaNightShade(\"always\")", PageScripts.nightShadeCall(NightShadeMode.Always))
        assertTrue(PageScripts.mainFrameOnly("x()").startsWith("if (window === window.top) {"))
    }
}
