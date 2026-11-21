package com.ardia.phone

import java.io.File
import org.json.JSONArray
import org.json.JSONObject

internal object HeldLinks {
    private val keptFields = setOf("kind", "url", "query", "id", "source")

    fun read(file: File): List<Map<String, Any?>> = runCatching {
        if (!file.isFile) return emptyList()
        val list = JSONArray(file.readText())
        (0 until list.length()).mapNotNull { index ->
            val entry = list.optJSONObject(index) ?: return@mapNotNull null
            entry.keys().asSequence().filter { it in keptFields }.associateWith { entry.optString(it) }.takeIf { it["kind"] != null }
        }
    }.getOrDefault(emptyList())

    fun write(file: File, links: List<Map<String, Any?>>) {
        if (links.isEmpty()) {
            file.delete()
            return
        }
        file.parentFile?.mkdirs()
        val list = JSONArray()
        for (link in links) {
            val entry = JSONObject()
            for ((key, value) in link) if (key in keptFields && value is String) entry.put(key, value)
            list.put(entry)
        }
        val staged = File(file.parentFile, ".${file.name}.partial")
        staged.writeText(list.toString())
        if (!staged.renameTo(file)) {
            file.writeText(list.toString())
            staged.delete()
        }
    }
}
