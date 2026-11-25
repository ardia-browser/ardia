package com.ardia.phone

import android.util.Xml
import java.io.File
import org.xmlpull.v1.XmlPullParser

object LegacyPreferencesFile {
    fun read(file: File): Map<String, Any> {
        if (!file.exists()) return emptyMap()
        if (!file.isFile) throw LegacyUnusable("io")
        val bytes = try {
            file.readBytes()
        } catch (error: Exception) {
            throw LegacyUnusable("io")
        }
        if (bytes.isEmpty()) throw LegacyUnusable("corrupt")
        return try {
            parse(bytes)
        } catch (unusable: LegacyUnusable) {
            throw unusable
        } catch (error: Exception) {
            throw LegacyUnusable("corrupt")
        }
    }

    private fun parse(bytes: ByteArray): Map<String, Any> {
        val parser = Xml.newPullParser()
        parser.setInput(bytes.inputStream(), "UTF-8")
        val values = LinkedHashMap<String, Any>()
        var sawMap = false
        var event = parser.next()
        while (event != XmlPullParser.END_DOCUMENT) {
            if (event == XmlPullParser.START_TAG) {
                if (parser.depth == 1) {
                    if (parser.name != "map") throw LegacyUnusable("corrupt")
                    sawMap = true
                } else if (parser.depth == 2) {
                    val name = parser.getAttributeValue(null, "name") ?: throw LegacyUnusable("corrupt")
                    value(parser)?.let { values[name] = it }
                }
            }
            event = parser.next()
        }
        if (!sawMap) throw LegacyUnusable("corrupt")
        return values
    }

    private fun value(parser: XmlPullParser): Any? {
        val attribute = parser.getAttributeValue(null, "value")
        return when (parser.name) {
            "string" -> parser.nextText()
            "boolean" -> when (attribute) {
                "true" -> true
                "false" -> false
                else -> throw LegacyUnusable("corrupt")
            }
            "int" -> attribute?.toIntOrNull() ?: throw LegacyUnusable("corrupt")
            "long" -> attribute?.toLongOrNull() ?: throw LegacyUnusable("corrupt")
            "float" -> attribute?.toFloatOrNull() ?: throw LegacyUnusable("corrupt")
            "set" -> {
                val items = LinkedHashSet<String>()
                val depth = parser.depth
                var event = parser.next()
                while (!(event == XmlPullParser.END_TAG && parser.depth == depth)) {
                    if (event == XmlPullParser.END_DOCUMENT) throw LegacyUnusable("corrupt")
                    if (event == XmlPullParser.START_TAG && parser.name == "string") items += parser.nextText()
                    event = parser.next()
                }
                items
            }
            "null" -> null
            else -> throw LegacyUnusable("corrupt")
        }
    }
}

class LegacyUnusable(val reason: String) : Exception("the previous app's data is unusable: $reason")
