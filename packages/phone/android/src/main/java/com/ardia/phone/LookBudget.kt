package com.ardia.phone

import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.view.FrameMetrics
import android.view.Window
import org.json.JSONObject

object LookBudget {
    private var layout: Pair<Int, Int>? = null

    fun samplesIn(orientation: Int): Boolean = orientation != Configuration.ORIENTATION_LANDSCAPE

    fun configurationChanged(next: Configuration) {
        val now = next.orientation to next.screenWidthDp
        val before = layout
        layout = now
        if (before == null || before == now) return
        if (FrameSampler.cancel() && PhoneLab.isOn) android.util.Log.i("PAGELAB", "PAGELAB look budget: the sample under way is dropped, the screen turned or resized")
    }

    private const val PREFERENCES = "ardia-look-budget"
    private const val KEY_STATE = "state"
    private const val KEY_FORCED = "forced"

    @Volatile
    private var knownDegraded: Boolean? = null

    private fun preferences(context: Context) = (context.applicationContext ?: context).getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    fun state(context: Context): String? = preferences(context).getString(KEY_STATE, null)

    fun forced(context: Context, lab: Boolean = PhoneLab.isOn): String? = if (lab) preferences(context).getString(KEY_FORCED, null) else null

    fun save(context: Context, state: String) {
        preferences(context).edit().putString(KEY_STATE, state).apply()
        knownDegraded = null
    }

    fun force(context: Context, applied: String?, lab: Boolean = PhoneLab.isOn) {
        check(lab) { "forcing the look budget is a lab switch" }
        preferences(context).edit().apply { if (applied == null) remove(KEY_FORCED) else putString(KEY_FORCED, applied) }.apply()
        knownDegraded = null
    }

    fun appliedFrom(state: String?, forced: String?): Boolean {
        if (forced != null) return forced == "degraded"
        return runCatching { JSONObject(state ?: return false).optString("apply") == "degraded" }.getOrDefault(false)
    }

    fun isDegraded(context: Context): Boolean = knownDegraded ?: appliedFrom(state(context), forced(context)).also { knownDegraded = it }

    fun version(context: Context): String {
        val app = context.applicationContext ?: context
        val info = runCatching { app.packageManager.getPackageInfo(app.packageName, 0) }.getOrNull()
        val code = if (info == null) 0L else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
        val commitId = app.resources.getIdentifier("ardia_build_commit", "string", app.packageName)
        val commit = if (commitId != 0) runCatching { app.getString(commitId) }.getOrNull() else null
        return listOfNotNull(info?.versionName ?: "?", code.toString(), commit?.take(12)).joinToString(" ")
    }

    internal fun forgetForTests() {
        knownDegraded = null
    }
}

internal class MainThreadWork(private val clock: () -> Long = System::nanoTime) : android.util.Printer {
    data class Message(val name: String, val nanos: Long)

    var nanos = 0L
        private set
    var messages = 0L
        private set
    private val longest = ArrayList<Message>(LONGEST + 1)
    private var started = 0L
    private var inMessage = false
    private var counting = false
    private var dispatched = ""

    val longestMessages: List<Message> get() = longest.toList()

    override fun println(line: String) {
        if (line.startsWith(">>>>>")) {
            counting = !isFrame(line)
            dispatched = line
            started = clock()
            inMessage = true
        } else if (line.startsWith("<<<<<") && inMessage) {
            if (counting) {
                val spent = clock() - started
                nanos += spent
                messages += 1
                if (longest.size < LONGEST || spent > longest.last().nanos) {
                    longest += Message(name(dispatched), spent)
                    longest.sortByDescending { it.nanos }
                    if (longest.size > LONGEST) longest.removeAt(longest.lastIndex)
                }
            }
            inMessage = false
        }
    }

    companion object {
        const val LONGEST = 3

        fun isFrame(line: String): Boolean = line.contains("Choreographer\$FrameDisplayEventReceiver") || line.contains("Choreographer\$FrameHandler")

        private fun plain(token: String): String = token.substringBefore('@')

        fun name(line: String): String {
            val body = line.removePrefix(">>>>> Dispatching to ").trim()
            val rest = body.substringAfter('}', "").trim()
            val callback = rest.substringBeforeLast(':').trim()
            if (callback.startsWith(NamedRunnable.PREFIX)) return callback
            val target = Regex("""^Handler \(([^)]+)\)""").find(body)?.groupValues?.get(1) ?: body.substringBefore(' ')
            val what = rest.substringAfterLast(':', "").trim()
            val named = if (callback.isEmpty() || callback == "null") "what $what" else plain(callback)
            return "${plain(target)} $named"
        }
    }
}

internal interface MessageLogging {
    fun current(): android.util.Printer?
    fun set(printer: android.util.Printer?)
}

internal object MainLooperLogging : MessageLogging {
    private val slot = runCatching { Looper::class.java.getDeclaredField("mLogging").apply { isAccessible = true } }.getOrNull()

    override fun current(): android.util.Printer? = runCatching { slot?.get(Looper.getMainLooper()) as? android.util.Printer }.getOrNull()

    override fun set(printer: android.util.Printer?) = Looper.getMainLooper().setMessageLogging(printer)
}

internal class ChainedPrinter(private val own: android.util.Printer, val next: android.util.Printer?) : android.util.Printer {
    @Volatile var forwardOnly = false

    override fun println(line: String) {
        if (!forwardOnly) own.println(line)
        next?.println(line)
    }
}

internal interface FrameReports {
    fun start(report: (totalMillis: Double, waitMillis: Double, deadlineMillis: Double, dropped: Int) -> Unit)
    fun stop()
}

internal class SampleSession(
    private val logging: MessageLogging,
    private val reports: FrameReports,
    private val clock: () -> Long,
    private val refreshMillis: Double,
    private val done: (FrameSampler.Sample?) -> Unit,
) {
    private val totals = ArrayList<Double>()
    private val deadlines = ArrayList<Double>()
    private val waits = ArrayList<Double>()
    private var dropped = 0L
    private val work = MainThreadWork()
    private var installed: ChainedPrinter? = null
    private var previous: android.util.Printer? = null
    private var started = 0L
    private var foreignBefore = 0L
    private var ticksBefore = 0L
    private var workerBefore = 0L
    private var scenesBefore = 0L
    private var blendsBefore = 0L
    private var finished = false

    fun start(): Boolean {
        try {
            started = clock()
            foreignBefore = LookActivity.foreignTraversals
            ticksBefore = LookActivity.tickNanos
            workerBefore = LookActivity.sceneWorkerNanos
            scenesBefore = LookActivity.scenesOffMain
            blendsBefore = LookActivity.blendsOffMain
            previous = logging.current()
            val chained = ChainedPrinter(work, previous)
            logging.set(chained)
            installed = chained
            reports.start { total, wait, deadline, lost ->
                synchronized(this) {
                    if (finished) return@synchronized
                    totals += total
                    waits += wait
                    deadlines += deadline
                    dropped += lost
                }
            }
            return true
        } catch (failure: Exception) {
            close(null)
            return false
        }
    }

    private fun uninstall() {
        val mine = installed ?: return
        installed = null
        mine.forwardOnly = true
        if (logging.current() === mine) logging.set(previous)
    }

    fun end() {
        if (finished) return
        val window = (clock() - started).toDouble()
        val foreign = LookActivity.foreignTraversals - foreignBefore
        val foreignViews = LookActivity.foreignLabels.since(foreignBefore)
        val ticks = (LookActivity.tickNanos - ticksBefore) / 1_000_000.0
        val worker = (LookActivity.sceneWorkerNanos - workerBefore) / 1_000_000.0
        val longest = work.longestMessages.map { "${it.name} ${"%.1f".format(java.util.Locale.ROOT, it.nanos / 1_000_000.0)} ms" }
        val sample = synchronized(this) {
            FrameSampler.Sample(totals.toList(), deadlines.toList(), refreshMillis, window, foreign, waits.toList(), ticks, work.nanos / 1_000_000.0, dropped, worker, work.messages, longest, LookActivity.scenesOffMain - scenesBefore, LookActivity.blendsOffMain - blendsBefore, foreignViews)
        }
        close(sample)
    }

    fun cancel() = close(null)

    private fun close(sample: FrameSampler.Sample?) {
        if (finished) return
        synchronized(this) { finished = true }
        try {
            runCatching { reports.stop() }
            uninstall()
        } finally {
            done(sample)
        }
    }
}

internal object FrameSampler {
    data class Sample(val totals: List<Double>, val deadlines: List<Double>, val refreshMillis: Double, val windowMillis: Double, val foreignFrames: Long, val waits: List<Double>, val tickMillis: Double, val mainThreadMillis: Double, val droppedReports: Long = 0L, val sceneWorkerMillis: Double = 0.0, val mainThreadMessages: Long = 0L, val longestMessages: List<String> = emptyList(), val sceneCount: Long = 0L, val blendCount: Long = 0L, val foreignViews: List<String> = emptyList())

    private var active: SampleSession? = null
    private val main = Handler(Looper.getMainLooper())

    fun cancel(): Boolean {
        val running = active ?: return false
        active = null
        running.cancel()
        return true
    }

    internal fun begin(session: SampleSession, millis: Long, schedule: (Runnable, Long) -> Unit = { run, delay -> main.postDelayed(run, delay) }) {
        active?.cancel()
        active = session
        if (!session.start()) {
            if (active === session) active = null
            return
        }
        schedule(Runnable {
            if (active === session) active = null
            session.end()
        }, millis)
    }

    fun sample(activity: Activity, millis: Long, done: (Sample?) -> Unit) {
        val window: Window = activity.window ?: return done(null)
        if (!LookBudget.samplesIn(activity.resources.configuration.orientation)) {
            if (PhoneLab.isOn) android.util.Log.i("PAGELAB", "PAGELAB look budget: not sampled in landscape; the verdict is portrait's")
            return done(null)
        }
        val refreshRate = (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) activity.display?.refreshRate else null) ?: @Suppress("DEPRECATION") activity.windowManager.defaultDisplay.refreshRate
        val interval = 1_000_000_000.0 / refreshRate.coerceAtLeast(1f)
        val thread = HandlerThread("ardia-frame-sampler").apply { start() }
        val handler = Handler(thread.looper)
        var listener: Window.OnFrameMetricsAvailableListener? = null
        val reports = object : FrameReports {
            override fun start(report: (Double, Double, Double, Int) -> Unit) {
                val made = Window.OnFrameMetricsAvailableListener { _, metrics, lost ->
                    val deadline = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) metrics.getMetric(FrameMetrics.DEADLINE).toDouble() else interval
                    report(
                        metrics.getMetric(FrameMetrics.TOTAL_DURATION) / 1_000_000.0,
                        metrics.getMetric(FrameMetrics.UNKNOWN_DELAY_DURATION) / 1_000_000.0,
                        (if (deadline > 0) deadline else interval) / 1_000_000.0,
                        lost,
                    )
                }
                listener = made
                window.addOnFrameMetricsAvailableListener(made, handler)
            }

            override fun stop() {
                listener?.let { runCatching { window.removeOnFrameMetricsAvailableListener(it) } }
                listener = null
            }
        }
        val session = SampleSession(MainLooperLogging, reports, SystemClock::uptimeMillis, interval / 1_000_000.0) { sample ->
            handler.post {
                try {
                    done(sample)
                } finally {
                    thread.quitSafely()
                }
            }
        }
        begin(session, millis)
    }
}
