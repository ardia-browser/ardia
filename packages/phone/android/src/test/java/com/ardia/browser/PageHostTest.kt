package com.ardia.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PageHostTest {
    @Test
    fun hostsCompareLowercasedWithoutATrailingDot() {
        assertEquals("docs.example.com", PageHost.key("https://Docs.Example.COM./a"))
        assertEquals("docs.example.com", PageHost.key("https://docs.example.com/b"))
    }

    @Test
    fun internationalHostComparesAsPunycode() {
        assertEquals("xn--bcher-kva.example", PageHost.key("https://xn--bcher-kva.example/"))
        assertEquals("xn--bcher-kva.example", PageHost.key("https://Bücher.example./"))
    }

    @Test
    fun subdomainsAreDifferentHosts() {
        assertNotEquals(PageHost.key("https://www.ck/"), PageHost.key("https://a.www.ck/"))
        assertEquals("www.ck", PageHost.key("https://www.ck/"))
    }

    @Test
    fun pageWithoutAHostHasNone() {
        assertNull(PageHost.key("about:blank"))
    }
}
