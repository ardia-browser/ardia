package com.ardia.research

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

data class ResearchLink(val url: String, val title: String) {
    val host: String get() = ResearchSearch.bareHost(url) ?: url
}

object ResearchSearch {
    const val RESULT_LIMIT = 5
    const val CANDIDATE_LIMIT = 10

    data class RawResult(val href: String, val title: String)

    private val unreadableHosts = setOf(
        "youtube.com", "youtu.be", "tiktok.com", "instagram.com", "facebook.com", "x.com", "twitter.com",
        "pinterest.com", "linkedin.com",
    )

    private val anchorPattern = Regex("<a(\\s[^>]*)>(.*?)</a>", RegexOption.DOT_MATCHES_ALL)
    private val hrefPattern = Regex("href=\"([^\"]*)\"")
    private val tagPattern = Regex("<[^>]*>")
    private val whitespace = Regex("\\s+")

    fun isUnreadable(host: String): Boolean = unreadableHosts.any { host == it || host.endsWith(".$it") }

    fun resultsPage(query: String): String = "https://html.duckduckgo.com/html/?q=" + URLEncoder.encode(query, "UTF-8").replace("+", "%20").replace("*", "%2A").replace("%7E", "~")

    fun bareHost(url: String): String? {
        val host = runCatching { URI(url).host }.getOrNull()?.lowercase() ?: return null
        return if (host.startsWith("www.")) host.removePrefix("www.") else host
    }

    fun links(raw: List<RawResult>, limit: Int = CANDIDATE_LIMIT): List<ResearchLink> {
        val links = mutableListOf<ResearchLink>()
        val hosts = mutableSetOf<String>()
        for (result in raw) {
            val url = destination(result.href) ?: continue
            val bare = bareHost(url) ?: continue
            if (bare.endsWith("duckduckgo.com") || isUnreadable(bare) || !hosts.add(bare)) continue
            val title = result.title.trim().replace(whitespace, " ")
            links += ResearchLink(url, title.ifEmpty { bare })
            if (links.size == limit) break
        }
        return links
    }

    fun destination(href: String): String? {
        val absolute = if (href.startsWith("//")) "https:$href" else href
        val uri = runCatching { URI(absolute) }.getOrNull() ?: return null
        val host = uri.host?.lowercase()
        if (host != null && host.endsWith("duckduckgo.com")) {
            if (uri.path != "/l/") return null
            val target = queryValue(uri.rawQuery, "uddg") ?: return null
            return destination(target)
        }
        val scheme = uri.scheme?.lowercase() ?: return null
        if ((scheme != "https" && scheme != "http") || host.isNullOrEmpty()) return null
        return absolute
    }

    private fun queryValue(rawQuery: String?, name: String): String? {
        for (pair in rawQuery.orEmpty().split('&')) {
            val key = pair.substringBefore('=')
            if (key == name) return runCatching { URLDecoder.decode(pair.substringAfter('=', ""), "UTF-8") }.getOrNull()
        }
        return null
    }

    fun links(html: String, limit: Int = CANDIDATE_LIMIT): List<ResearchLink> {
        val raw = mutableListOf<RawResult>()
        for (match in anchorPattern.findAll(html)) {
            val tag = match.groupValues[1]
            if (!tag.contains("result__a")) continue
            val href = hrefPattern.find(tag)?.groupValues?.get(1) ?: continue
            raw += RawResult(decodingEntities(href), decodingEntities(match.groupValues[2].replace(tagPattern, "")))
        }
        return links(raw, limit)
    }

    fun decodingEntities(text: String): String {
        var result = text
        for ((entity, value) in listOf("&quot;" to "\"", "&#x27;" to "'", "&#39;" to "'", "&lt;" to "<", "&gt;" to ">", "&nbsp;" to " ", "&amp;" to "&")) {
            result = result.replace(entity, value)
        }
        return result
    }
}
