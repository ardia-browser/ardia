package com.ardia.phone

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import kotlin.math.roundToInt

internal object PageBands {
    const val SMALLEST_PAGE_SHARE = 4

    data class Frame(val top: Int, val bottom: Int) {
        val isEmpty: Boolean get() = top == 0 && bottom == 0
    }

    fun frame(height: Int, top: Int, bottom: Int): Frame {
        val wantedTop = top.coerceAtLeast(0)
        val wantedBottom = bottom.coerceAtLeast(0)
        val room = height - height / SMALLEST_PAGE_SHARE
        if (height <= 0 || wantedTop + wantedBottom <= room) return Frame(wantedTop, wantedBottom)
        val scale = room.toFloat() / (wantedTop + wantedBottom)
        return Frame((wantedTop * scale).toInt(), (wantedBottom * scale).toInt())
    }

    fun toneOffsets(tone: Pair<Int, Int>, bands: Frame): Pair<Int, Int> =
        (tone.first - bands.top).coerceAtLeast(0) to (tone.second - bands.bottom).coerceAtLeast(0)

    fun colour(band: Int?, surface: Int?): Int? = band ?: surface

    data class Scaled(val width: Int, val height: Int, val pageTop: Int, val pageHeight: Int)

    fun scaled(pictureWidth: Int, pictureHeight: Int, viewWidth: Int, viewHeight: Int, bands: Frame): Scaled {
        val scale = pictureWidth / viewWidth.toFloat()
        val top = (bands.top * scale).roundToInt()
        val bottom = (bands.bottom * scale).roundToInt()
        val height = maxOf((viewHeight * scale).roundToInt(), top + pictureHeight + bottom)
        return Scaled(pictureWidth, height, top, pictureHeight)
    }

    fun compose(picture: Bitmap, viewWidth: Int, viewHeight: Int, bands: Frame, topColour: Int?, bottomColour: Int?): Bitmap {
        if (bands.isEmpty || viewWidth <= 0 || viewHeight <= 0) return picture
        val source = if (picture.config == Bitmap.Config.HARDWARE) picture.copy(Bitmap.Config.ARGB_8888, false) else picture
        val layout = scaled(source.width, source.height, viewWidth, viewHeight, bands)
        val out = Bitmap.createBitmap(layout.width, layout.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(out)
        val paint = Paint()
        topColour?.let {
            paint.color = it
            canvas.drawRect(0f, 0f, layout.width.toFloat(), layout.pageTop.toFloat(), paint)
        }
        canvas.drawBitmap(source, 0f, layout.pageTop.toFloat(), null)
        bottomColour?.let {
            paint.color = it
            canvas.drawRect(0f, (layout.pageTop + layout.pageHeight).toFloat(), layout.width.toFloat(), layout.height.toFloat(), paint)
        }
        if (source !== picture) source.recycle()
        return out
    }
}
