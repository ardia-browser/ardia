package com.ardia.phone

import java.io.File
import org.json.JSONArray
import org.json.JSONObject

class FolderPicks(private val file: File, private val grants: Grants, private val clock: () -> Long = System::currentTimeMillis) {
    interface Grants {
        fun take(tree: String): Boolean

        fun release(tree: String)

        fun connected(): String?
    }

    private data class Pick(val tree: String, val at: Long)

    fun picked(tree: String): Boolean = synchronized(LOCK) {
        if (!grants.take(tree)) return false
        val connected = grants.connected()
        load().filter { it.tree != tree && it.tree != connected }.forEach { grants.release(it.tree) }
        save(if (tree == connected) emptyList() else listOf(Pick(tree, clock())))
        true
    }

    fun holds(tree: String): Boolean = synchronized(LOCK) { load().any { it.tree == tree } }

    fun connected(tree: String) = synchronized(LOCK) {
        load().filter { it.tree != tree }.forEach { grants.release(it.tree) }
        save(emptyList())
    }

    fun forget(tree: String) = synchronized(LOCK) {
        val picks = load()
        if (picks.none { it.tree == tree }) return
        if (tree != grants.connected()) grants.release(tree)
        save(picks.filter { it.tree != tree })
    }

    fun sweep() = synchronized(LOCK) {
        val connected = grants.connected()
        val (stale, fresh) = load().partition { clock() - it.at > UNUSED_MILLIS }
        stale.filter { it.tree != connected }.forEach { grants.release(it.tree) }
        if (stale.isNotEmpty()) save(fresh)
    }

    private fun load(): List<Pick> = runCatching {
        val list = JSONObject(file.readText()).getJSONArray("picks")
        (0 until list.length()).map { list.getJSONObject(it) }.map { Pick(it.getString("tree"), it.getLong("at")) }
    }.getOrDefault(emptyList())

    private fun save(picks: List<Pick>) {
        file.parentFile?.mkdirs()
        val list = JSONArray().apply { picks.forEach { put(JSONObject().put("tree", it.tree).put("at", it.at)) } }
        val staged = File(file.parentFile, ".${file.name}.partial")
        staged.writeText(JSONObject().put("picks", list).toString())
        if (!staged.renameTo(file)) file.writeText(staged.readText())
    }

    companion object {
        const val UNUSED_MILLIS = 24L * 60 * 60 * 1000
        private val LOCK = Any()
    }
}
