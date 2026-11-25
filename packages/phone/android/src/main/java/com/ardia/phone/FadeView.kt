package com.ardia.phone

import android.content.Context
import android.graphics.BlendMode
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.views.ExpoView

class FadeEdge : Record {
    @Field
    var length: Double = 0.0

    @Field
    var floor: Double = 0.0
}

internal object FadeRamps {
    data class Edge(val length: Float, val floor: Float)

    data class Ramp(val left: Float, val top: Float, val right: Float, val bottom: Float, val fromX: Float, val fromY: Float, val toX: Float, val toY: Float, val erase: Float)

    fun of(width: Float, height: Float, density: Float, rightToLeft: Boolean, top: Edge?, bottom: Edge?, leading: Edge?, trailing: Edge?): List<Ramp> {
        if (width <= 0f || height <= 0f) return emptyList()
        val ramps = ArrayList<Ramp>(4)
        fun size(edge: Edge?, limit: Float): Float = ((edge?.length ?: 0f) * density).coerceIn(0f, limit)
        fun erase(edge: Edge): Float = 1f - edge.floor.coerceIn(0f, 1f)
        val left = if (rightToLeft) trailing else leading
        val right = if (rightToLeft) leading else trailing
        size(top, height).takeIf { it > 0f }?.let { ramps += Ramp(0f, 0f, width, it, 0f, 0f, 0f, it, erase(top!!)) }
        size(bottom, height).takeIf { it > 0f }?.let { ramps += Ramp(0f, height - it, width, height, 0f, height, 0f, height - it, erase(bottom!!)) }
        size(left, width).takeIf { it > 0f }?.let { ramps += Ramp(0f, 0f, it, height, 0f, 0f, it, 0f, erase(left!!)) }
        size(right, width).takeIf { it > 0f }?.let { ramps += Ramp(width - it, 0f, width, height, width, 0f, width - it, 0f, erase(right!!)) }
        return ramps.filter { it.erase > 0f }
    }
}

class FadeView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
    internal var top: FadeRamps.Edge? = null
    internal var bottom: FadeRamps.Edge? = null
    internal var leading: FadeRamps.Edge? = null
    internal var trailing: FadeRamps.Edge? = null

    private val paint = Paint().apply { blendMode = BlendMode.DST_OUT }
    private var ramps: List<FadeRamps.Ramp> = emptyList()
    private var shaders: List<Shader> = emptyList()
    private var shapedFor: List<Any?> = emptyList()

    internal val fades: Boolean get() = listOf(top, bottom, leading, trailing).any { it != null && it.length > 0f && it.floor < 1f }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) =
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), MeasureSpec.getSize(heightMeasureSpec))

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) = Unit

    fun update() {
        val wanted = if (fades) LAYER_TYPE_HARDWARE else LAYER_TYPE_NONE
        if (layerType != wanted) setLayerType(wanted, null)
        invalidate()
    }

    private fun shape() {
        val key = listOf(width, height, layoutDirection, top, bottom, leading, trailing)
        if (key == shapedFor) return
        shapedFor = key
        ramps = FadeRamps.of(width.toFloat(), height.toFloat(), resources.displayMetrics.density, layoutDirection == LAYOUT_DIRECTION_RTL, top, bottom, leading, trailing)
        shaders = ramps.map { ramp ->
            LinearGradient(ramp.fromX, ramp.fromY, ramp.toX, ramp.toY, Color.argb((ramp.erase * 255f).toInt(), 0, 0, 0), Color.TRANSPARENT, Shader.TileMode.CLAMP)
        }
    }

    override fun dispatchDraw(canvas: Canvas) {
        super.dispatchDraw(canvas)
        if (!fades) return
        shape()
        for (index in ramps.indices) {
            val ramp = ramps[index]
            paint.shader = shaders[index]
            canvas.drawRect(ramp.left, ramp.top, ramp.right, ramp.bottom, paint)
        }
    }
}
