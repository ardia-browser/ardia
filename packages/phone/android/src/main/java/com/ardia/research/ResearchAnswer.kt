package com.ardia.research

object ResearchAnswer {
    sealed class Block(val text: String) {
        class Heading(text: String) : Block(text)
        class Bullet(text: String) : Block(text)
        class Paragraph(text: String) : Block(text)

        override fun equals(other: Any?): Boolean = other is Block && other::class == this::class && other.text == text
        override fun hashCode(): Int = 31 * this::class.hashCode() + text.hashCode()
        override fun toString(): String = "${this::class.simpleName}($text)"
    }

    data class CitationRun(val range: IntRange, val numbers: List<Int>)

    private val bulletPrefixes = listOf("- ", "* ", "• ", "– ")
    private val headingPrefixes = listOf("### ", "## ", "# ")
    private val citationRunPattern = Regex("\\s*((?:\\[\\d{1,2}(?:\\s*,\\s*\\d{1,2})*\\])+)")
    private val citationPattern = Regex("\\[(\\d{1,2}(?:\\s*,\\s*\\d{1,2})*)\\]")
    private val spacedCitationPattern = Regex("\\s*\\[\\d{1,2}(?:\\s*,\\s*\\d{1,2})*\\]")

    fun blocks(answer: String): List<Block> = answer.lines().mapNotNull { raw ->
        val line = raw.trim()
        if (line.isEmpty()) return@mapNotNull null
        stripping(line, headingPrefixes)?.let { heading ->
            val text = unbolded(heading)
            return@mapNotNull if (text.isEmpty()) null else Block.Heading(text)
        }
        stripping(line, bulletPrefixes)?.let { first ->
            var bullet = first
            while (true) bullet = stripping(bullet, bulletPrefixes) ?: break
            val text = unbolded(bullet)
            return@mapNotNull if (text.isEmpty()) null else Block.Bullet(text)
        }
        val text = unbolded(line)
        if (text.endsWith(":") && text.length < 60 && !text.contains(". ")) Block.Heading(text.dropLast(1)) else Block.Paragraph(text)
    }

    fun citations(text: String): List<Int> {
        val found = mutableListOf<Int>()
        for (match in citationPattern.findAll(text)) {
            for (number in match.groupValues[1].split(',').mapNotNull { it.trim().toIntOrNull() }) {
                if (number !in found) found += number
            }
        }
        return found
    }

    fun citationRuns(text: String): List<CitationRun> = citationRunPattern.findAll(text).map { CitationRun(it.range, citations(it.groupValues[1])) }.toList()

    fun withoutCitations(text: String): String = text.replace(spacedCitationPattern, "")

    fun spoken(answer: String): String = blocks(answer).map { block ->
        val text = withoutCitations(block.text).trim()
        val last = text.lastOrNull() ?: return@map ""
        if (last in ".!?:") text else "$text."
    }.filter { it.isNotEmpty() }.joinToString("\n")

    private fun stripping(line: String, prefixes: List<String>): String? {
        for (prefix in prefixes) if (line.startsWith(prefix)) return line.removePrefix(prefix).trim()
        return null
    }

    private fun unbolded(text: String): String = text.replace("**", "").replace("__", "").trim()
}
