package com.ardia.phone

import android.animation.TimeInterpolator
import android.view.animation.PathInterpolator
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.sin
import kotlin.math.sqrt

data class MotionValues(
    val opacity: Float = 1f,
    val translateX: Float = 0f,
    val translateY: Float = 0f,
    val scale: Float = 1f,
    val cornerRadius: Float? = null,
) {
    fun value(channel: MotionChannel): Float? = when (channel) {
        MotionChannel.Opacity -> opacity
        MotionChannel.TranslateX -> translateX
        MotionChannel.TranslateY -> translateY
        MotionChannel.Scale -> scale
        MotionChannel.CornerRadius -> cornerRadius
    }

    fun with(channel: MotionChannel, value: Float): MotionValues = when (channel) {
        MotionChannel.Opacity -> copy(opacity = value)
        MotionChannel.TranslateX -> copy(translateX = value)
        MotionChannel.TranslateY -> copy(translateY = value)
        MotionChannel.Scale -> copy(scale = value)
        MotionChannel.CornerRadius -> copy(cornerRadius = value)
    }
}

enum class MotionChannel { Opacity, TranslateX, TranslateY, Scale, CornerRadius }

sealed class MotionCurve {
    abstract val durationMillis: Long
    abstract val interpolator: TimeInterpolator

    data class Timing(val millis: Long, val points: List<Float>?) : MotionCurve() {
        val controlPoints: List<Float> get() = points?.takeIf { it.size == 4 } ?: FALLBACK_POINTS
        override val durationMillis: Long get() = millis.coerceAtLeast(0)
        override val interpolator: TimeInterpolator get() = controlPoints.let { PathInterpolator(it[0], it[1], it[2], it[3]) }
    }

    data class Spring(val response: Double, val dampingFraction: Double, val settledFraction: Double = SpringSolution.SETTLED) : MotionCurve() {
        private val solved by lazy { SpringSolution(response.coerceAtLeast(0.01), dampingFraction.coerceIn(0.0, 2.0), settledFraction) }
        override val durationMillis: Long get() = solved.settlingMillis
        override val interpolator: TimeInterpolator get() = solved
        fun progress(seconds: Double): Double = solved.position(seconds)
    }

    fun overPixels(pixels: Float): MotionCurve {
        if (this !is Spring || pixels <= 0f) return this
        return copy(settledFraction = (HALF_PIXEL / pixels).toDouble().coerceIn(SpringSolution.SETTLED_AT_MOST_ONCE, SpringSolution.SETTLED_AT_MOST))
    }

    companion object {
        val FALLBACK_POINTS = listOf(0f, 0f, 0.58f, 1f)
        const val HALF_PIXEL = 0.5f
    }
}

internal class SpringSolution(response: Double, dampingFraction: Double, private val settled: Double = SETTLED) : TimeInterpolator {
    private val omega = 2 * PI / response
    private val zeta = dampingFraction

    fun position(t: Double): Double {
        if (t <= 0) return 0.0
        return when {
            zeta < 1 -> {
                val damped = omega * sqrt(1 - zeta * zeta)
                1 - exp(-zeta * omega * t) * (cos(damped * t) + (zeta * omega / damped) * sin(damped * t))
            }
            zeta == 1.0 -> 1 - exp(-omega * t) * (1 + omega * t)
            else -> {
                val root = omega * sqrt(zeta * zeta - 1)
                val r1 = -zeta * omega + root
                val r2 = -zeta * omega - root
                1 - (r2 * exp(r1 * t) - r1 * exp(r2 * t)) / (r2 - r1)
            }
        }
    }

    val settlingMillis: Long = run {
        var last = 0
        var step = 1
        while (step <= 10_000) {
            if (abs(1 - position(step / 1000.0)) > settled) last = step
            step += 1
        }
        (last + 1).toLong()
    }

    override fun getInterpolation(input: Float): Float = if (input >= 1f) 1f else position(input * settlingMillis / 1000.0).toFloat()

    companion object {
        const val SETTLED = 0.001
        const val SETTLED_AT_MOST = 0.02
        const val SETTLED_AT_MOST_ONCE = 0.00001
    }
}

interface MotionSurface {
    val animates: Boolean

    val motionEnabled: Boolean get() = animates

    fun set(values: MotionValues, channels: Set<MotionChannel>)

    fun startRenderThread(targets: Map<MotionChannel, Float>, curve: MotionCurve)

    fun cancelRenderThread()

    fun startClock(durationMillis: Long, onFrame: (Float) -> Unit, onEnd: (Boolean) -> Unit): MotionClock

    fun pixels(channel: MotionChannel, change: Float): Float = change
}

interface MotionClock {
    val fraction: Float

    fun cancel()
}

class MotionRunner(private val surface: MotionSurface) {
    var onEnd: ((Boolean) -> Unit)? = null
    var nearEndPx: Float? = null
    var onNearEnd: ((Float) -> Unit)? = null
    var trace: ((String) -> Unit)? = null
    var shown: MotionValues? = null
        private set
    var move = 0
        private set

    private var from: MotionValues? = null
    private var curve: MotionCurve? = null
    private var clock: MotionClock? = null
    private var moving: Set<MotionChannel> = emptySet()
    private var reported = 0
    private var nearSent = 0

    private fun sendNear(mine: Int, remaining: Float) {
        if (nearSent == mine || mine != move) return
        nearSent = mine
        trace?.invoke("move #$mine near its end, ${"%.1f".format(remaining)} px left")
        onNearEnd?.invoke(remaining)
    }

    fun presentation(): MotionValues? {
        val target = shown ?: return null
        val start = from ?: return target
        val running = clock ?: return target
        val progress = curve?.interpolator?.getInterpolation(running.fraction) ?: 1f
        var values = target
        for (channel in moving) {
            val a = start.value(channel) ?: continue
            val b = target.value(channel) ?: continue
            values = values.with(channel, a + (b - a) * progress)
        }
        return values
    }

    fun show(next: MotionValues, nextCurve: MotionCurve, start: MotionValues? = null) {
        if (next == shown) return
        val mounting = shown == null && start != null && start != next
        val before = if (mounting) start else presentation()
        trace?.invoke("show #${move + 1} ${if (mounting) "mount from $start" else if (shown == null) "first, no motion" else "from where it is $before${if (clock != null) ", interrupting #$move" else ""}"} to $next")
        move += 1
        val mine = move
        stopRunning()
        shown = next
        val allowed = if (mounting) surface.motionEnabled else surface.animates
        val changed = if (before == null || !allowed) emptySet() else MotionChannel.entries.filter { channel ->
            val start = before.value(channel)
            val end = next.value(channel)
            start != null && end != null && abs(start - end) > 0.0001f
        }.toSet()
        surface.set(if (changed.isEmpty()) next else changed.fold(next) { values, channel -> values.with(channel, before!!.value(channel)!!) }, MotionChannel.entries.toSet())
        if (changed.isEmpty()) {
            if (before != null) {
                if (nearEndPx != null) sendNear(mine, 0f)
                onEnd?.invoke(true)
            }
            return
        }
        val travel = changed.maxOf { channel -> surface.pixels(channel, abs(next.value(channel)!! - before!!.value(channel)!!)) }
        val fitted = nextCurve.overPixels(travel)
        trace?.invoke("move #$mine ${changed.joinToString(",")} over ${travel.toInt()} px, ${fitted.durationMillis} ms")
        val nearAt = nearEndPx?.let { nearFraction(fitted, travel, it) }
        from = before
        curve = fitted
        moving = changed
        surface.startRenderThread(changed.filter { it != MotionChannel.CornerRadius }.associateWith { next.value(it)!! }, fitted)
        val corners = MotionChannel.CornerRadius in changed
        if (nearAt != null && nearAt <= 0f) sendNear(mine, travel)
        clock = surface.startClock(fitted.durationMillis, onFrame = { fraction ->
            if (nearAt != null && fraction >= nearAt) sendNear(mine, (1 - fitted.interpolator.getInterpolation(fraction)) * travel)
            if (corners && mine == move) {
                val a = before!!.cornerRadius!!
                val b = next.cornerRadius!!
                surface.set(next.copy(cornerRadius = a + (b - a) * fitted.interpolator.getInterpolation(fraction)), setOf(MotionChannel.CornerRadius))
            }
        }) { finished ->
            if (mine != move || reported == mine) {
                trace?.invoke("move #$mine stopped, finished $finished, not reported (now #$move)")
                return@startClock
            }
            reported = mine
            if (finished && nearAt != null) sendNear(mine, 0f)
            trace?.invoke("move #$mine ended, finished $finished")
            clock = null
            moving = emptySet()
            surface.set(next, MotionChannel.entries.toSet())
            onEnd?.invoke(finished)
        }
    }

    companion object {
        private const val NEAR_STEPS = 2000

        fun nearFraction(curve: MotionCurve, travel: Float, pixels: Float): Float {
            if (travel <= pixels) return 0f
            for (step in 0..NEAR_STEPS) {
                val fraction = step.toFloat() / NEAR_STEPS
                if ((1 - curve.interpolator.getInterpolation(fraction)) * travel <= pixels) return fraction
            }
            return 1f
        }
    }

    fun interrupt() {
        if (clock == null) return
        val now = presentation()
        move += 1
        stopRunning()
        now?.let { surface.set(it, MotionChannel.entries.toSet()) }
        onEnd?.invoke(false)
    }

    private fun stopRunning() {
        val running = clock ?: return
        clock = null
        surface.cancelRenderThread()
        running.cancel()
        moving = emptySet()
    }
}
