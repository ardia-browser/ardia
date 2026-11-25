package com.ardia.phone

import android.os.Bundle

object RestorableState {
    private const val BUNDLE_KEY = "com.ardia.phone.RESTORABLE"
    private val values = LinkedHashMap<String, String>()

    fun get(key: String): String? = synchronized(values) { values[key] }

    fun set(key: String, value: String?) = synchronized(values) {
        if (value == null) values.remove(key) else values[key] = value
    }

    fun save(out: Bundle) {
        val bundle = Bundle()
        synchronized(values) { values.forEach { (key, value) -> bundle.putString(key, value) } }
        out.putBundle(BUNDLE_KEY, bundle)
    }

    fun restore(saved: Bundle?) {
        val bundle = saved?.getBundle(BUNDLE_KEY) ?: return
        synchronized(values) {
            for (key in bundle.keySet()) {
                if (!values.containsKey(key)) bundle.getString(key)?.let { values[key] = it }
            }
        }
    }

    internal fun forgetForTests() = synchronized(values) { values.clear() }
}
