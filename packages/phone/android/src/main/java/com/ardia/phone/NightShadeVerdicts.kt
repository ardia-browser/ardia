package com.ardia.phone

import android.content.SharedPreferences
import com.ardia.browser.NightShadeVerdict
import com.ardia.browser.NightShadeVerdictUse
import org.json.JSONArray

class NightShadeVerdicts(
    private val storage: Storage,
    private val limit: Int = LIMIT,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    interface Storage {
        fun read(): String?

        fun write(text: String?)
    }

    private class Entry(val verdict: NightShadeVerdict, var usedAt: Long, var savedAt: Long)

    private val lock = Any()
    private var loaded: LinkedHashMap<String, Entry>? = null
    private val privateVerdicts = LinkedHashMap<String, Entry>()

    fun verdict(host: String, isPrivate: Boolean): NightShadeVerdict? = synchronized(lock) {
        val verdicts = table(isPrivate)
        val entry = verdicts.remove(host) ?: return null
        val now = clock()
        entry.usedAt = maxOf(entry.usedAt, now)
        verdicts[host] = entry
        if (!isPrivate && now - entry.savedAt >= SAVE_USE_AFTER_MILLIS) save()
        entry.verdict
    }

    fun remember(host: String, isPrivate: Boolean, verdict: NightShadeVerdict): NightShadeVerdictUse? = synchronized(lock) {
        if (host.isEmpty()) return null
        val verdicts = table(isPrivate)
        val before = verdicts.remove(host)
        val now = clock()
        verdicts[host] = Entry(verdict, maxOf(now, before?.usedAt ?: now), now)
        while (verdicts.size > limit) verdicts.remove(verdicts.keys.first())
        if (!isPrivate) save()
        when {
            before == null -> NightShadeVerdictUse.Learned
            before.verdict != verdict -> NightShadeVerdictUse.Corrected
            else -> null
        }
    }

    fun forget(since: Long?) = synchronized(lock) {
        privateVerdicts.entries.removeAll { since == null || it.value.usedAt >= since }
        val verdicts = table(false)
        if (verdicts.entries.removeAll { since == null || it.value.usedAt >= since } || since == null) save()
    }

    fun endPrivateBrowsing() = synchronized(lock) { privateVerdicts.clear() }

    fun hosts(isPrivate: Boolean): List<String> = synchronized(lock) { table(isPrivate).keys.toList() }

    private fun table(isPrivate: Boolean): LinkedHashMap<String, Entry> =
        if (isPrivate) privateVerdicts else loaded ?: parse(storage.read()).also { loaded = it }

    private fun save() {
        val verdicts = table(false)
        if (verdicts.isEmpty()) {
            storage.write(null)
            return
        }
        val now = clock()
        val rows = JSONArray()
        for ((host, entry) in verdicts) {
            entry.savedAt = now
            rows.put(JSONArray().put(host).put(entry.verdict.raw).put(entry.usedAt))
        }
        storage.write(rows.toString())
    }

    private fun parse(text: String?): LinkedHashMap<String, Entry> {
        val rows = runCatching { JSONArray(text ?: "[]") }.getOrElse { JSONArray() }
        val parsed = ArrayList<Pair<String, Entry>>()
        for (index in 0 until rows.length()) {
            val row = rows.optJSONArray(index) ?: continue
            val host = row.optString(0).takeIf { it.isNotEmpty() } ?: continue
            val verdict = NightShadeVerdict.of(row.optString(1)) ?: continue
            val usedAt = row.optLong(2, 0L)
            parsed += host to Entry(verdict, usedAt, usedAt)
        }
        val verdicts = LinkedHashMap<String, Entry>()
        for ((host, entry) in parsed.sortedBy { it.second.usedAt }) {
            verdicts.remove(host)
            verdicts[host] = entry
        }
        while (verdicts.size > limit) verdicts.remove(verdicts.keys.first())
        return verdicts
    }

    class Preferences(private val preferences: SharedPreferences) : Storage {
        override fun read(): String? = preferences.getString(KEY, null)

        override fun write(text: String?) {
            preferences.edit().apply { if (text == null) remove(KEY) else putString(KEY, text) }.apply()
        }
    }

    companion object {
        const val LIMIT = 400
        const val SAVE_USE_AFTER_MILLIS = 60_000L
        private const val KEY = "nightShade.verdicts"
    }
}
