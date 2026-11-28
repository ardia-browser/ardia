package com.ardia.phone

import kotlin.math.floor
import kotlin.math.roundToInt
import kotlin.math.sqrt

internal object LongScreenshotPlan {
    const val MAX_SCREENS = 20
    const val MIN_BUDGET_BYTES = 48L * 1024 * 1024
    const val MAX_BUDGET_BYTES = 160L * 1024 * 1024
    const val MIN_OUTPUT_BYTES = 16L * 1024 * 1024
    private const val WORKING_COPIES = 3
    const val COMPLETE_TOLERANCE = 24
    const val TILE_HEIGHT = 2048
    private const val BYTES_PER_PIXEL = 4
    private const val OVERLAP_SHARE = 4
    private const val WARM_SHARE = 8
    private const val MIN_OVERLAP = 16
    private const val SAMPLED_COLUMNS = 96
    private const val ROW_STEP = 2
    private const val MIN_TELLING_ROWS = 8
    private const val MIN_SCORE = 0.6
    private const val TIE = 0.01
    private const val CHANNEL_TOLERANCE = 6

    data class Output(val width: Int, val height: Int, val scale: Double)

    data class Slice(val sourceTop: Int, val sourceBottom: Int, val pageTop: Int, val pageBottom: Int)

    data class Crop(val top: Int, val bottom: Int)

    fun pageHeight(reported: Double, viewport: Int): Int {
        if (viewport <= 0) return 0
        val cap = viewport.toLong() * MAX_SCREENS
        if (!reported.isFinite() || reported <= viewport) return viewport
        return minOf(floor(reported).toLong(), cap).toInt()
    }

    fun budget(availableBytes: Long): Long = (availableBytes / 8).coerceIn(MIN_BUDGET_BYTES, MAX_BUDGET_BYTES)

    fun workingBytes(width: Int, viewport: Int): Long = maxOf(0, width).toLong() * maxOf(0, viewport) * BYTES_PER_PIXEL * WORKING_COPIES

    fun outputBudget(availableBytes: Long, width: Int, viewport: Int): Long? = (budget(availableBytes) - workingBytes(width, viewport)).takeIf { it >= MIN_OUTPUT_BYTES }

    enum class Ending { Complete, Stopped, Failed }

    fun ending(filled: Int, pageHeight: Int, viewport: Int, atBottom: Boolean): Ending = when {
        filled >= pageHeight - COMPLETE_TOLERANCE -> Ending.Complete
        atBottom && filled > viewport -> Ending.Complete
        filled <= viewport -> Ending.Failed
        else -> Ending.Stopped
    }

    fun output(width: Int, pageHeight: Int, budgetBytes: Long): Output? {
        if (width <= 0 || pageHeight <= 0 || budgetBytes <= 0) return null
        val bytes = width.toDouble() * pageHeight * BYTES_PER_PIXEL
        val scale = if (bytes <= budgetBytes) 1.0 else sqrt(budgetBytes / bytes)
        val outWidth = (width * scale).toInt().coerceAtLeast(1)
        val shown = outWidth.toDouble() / width
        return Output(outWidth, (pageHeight * shown).roundToInt().coerceAtLeast(1), shown)
    }

    fun stride(viewport: Int): Int = maxOf(1, viewport - viewport / OVERLAP_SHARE)

    fun warmStops(pageHeight: Int, viewport: Int): List<Int> {
        val bottom = pageHeight - viewport
        if (viewport <= 0 || bottom <= 0) return emptyList()
        val step = maxOf(1, viewport / WARM_SHARE)
        return ((step until bottom step step) + bottom).toList()
    }

    fun maxSteps(pageHeight: Int, viewport: Int): Int = if (viewport <= 0) 1 else (maxOf(0, pageHeight - viewport) + stride(viewport) - 1) / stride(viewport) + 3

    fun offset(previous: IntArray, previousHeight: Int, current: IntArray, currentHeight: Int, width: Int, expected: Int): Int? {
        if (width <= 0 || previousHeight <= MIN_OVERLAP || currentHeight <= 0) return null
        if (previous.size < width * previousHeight || current.size < width * currentHeight) return null
        val columns = (0 until width step maxOf(1, width / SAMPLED_COLUMNS)).toList().toIntArray()
        val highest = previousHeight - MIN_OVERLAP
        val telling = (0 until minOf(currentHeight, previousHeight) step ROW_STEP).filter { row -> !uniform(current, row * width, columns) }.toIntArray()
        if (telling.isEmpty()) return expected.takeIf { it in 0..highest }
        var best = -1
        var bestScore = -1.0
        for (move in 0..highest) {
            val overlap = minOf(previousHeight - move, currentHeight)
            var rows = 0
            var matched = 0
            for (row in telling) {
                if (row >= overlap) break
                rows += 1
                if (same(previous, (move + row) * width, current, row * width, columns)) matched += 1
            }
            if (rows < MIN_TELLING_ROWS) continue
            val score = matched.toDouble() / rows
            val closer = best < 0 || kotlin.math.abs(move - expected) < kotlin.math.abs(best - expected)
            if (score > bestScore + TIE || (score >= bestScore - TIE && closer)) {
                best = move
                bestScore = maxOf(score, bestScore)
            }
        }
        if (bestScore >= MIN_SCORE) return best
        return expected.takeIf { bestScore < 0 && it in 0..highest }
    }

    private fun uniform(pixels: IntArray, start: Int, columns: IntArray): Boolean {
        val first = pixels[start + columns[0]]
        return columns.all { near(pixels[start + it], first) }
    }

    private fun same(a: IntArray, aStart: Int, b: IntArray, bStart: Int, columns: IntArray): Boolean = columns.all { near(a[aStart + it], b[bStart + it]) }

    private fun near(a: Int, b: Int): Boolean =
        kotlin.math.abs(((a shr 16) and 0xFF) - ((b shr 16) and 0xFF)) <= CHANNEL_TOLERANCE &&
            kotlin.math.abs(((a shr 8) and 0xFF) - ((b shr 8) and 0xFF)) <= CHANNEL_TOLERANCE &&
            kotlin.math.abs((a and 0xFF) - (b and 0xFF)) <= CHANNEL_TOLERANCE

    fun slice(scrolledTo: Int, filled: Int, captured: Int, pageHeight: Int): Slice? {
        if (captured <= 0 || scrolledTo < 0 || scrolledTo > filled) return null
        val top = filled
        val bottom = minOf(scrolledTo + captured, pageHeight)
        if (bottom <= top) return null
        return Slice(top - scrolledTo, bottom - scrolledTo, top, bottom)
    }

    fun rowIn(output: Output, pageRow: Int): Int = (pageRow * output.scale).roundToInt().coerceIn(0, output.height)

    fun screens(filled: Int, viewport: Int): Int = if (viewport <= 0 || filled <= 0) 0 else ((filled + viewport - 1) / viewport).coerceAtMost(MAX_SCREENS)

    fun tiles(height: Int, tileHeight: Int = TILE_HEIGHT): List<IntRange> {
        if (height <= 0 || tileHeight <= 0) return emptyList()
        return (0 until height step tileHeight).map { top -> top until minOf(top + tileHeight, height) }
    }

    fun crop(height: Int, top: Double, bottom: Double): Crop? {
        if (height <= 0 || !top.isFinite() || !bottom.isFinite()) return null
        val from = top.roundToInt().coerceIn(0, height - 1)
        val to = bottom.roundToInt().coerceIn(from + 1, height)
        return Crop(from, to)
    }
}
