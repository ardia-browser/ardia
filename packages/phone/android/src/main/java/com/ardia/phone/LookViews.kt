package com.ardia.phone

import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.BlendMode
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RadialGradient
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.RenderEffect
import android.graphics.RenderNode
import android.graphics.Shader
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewTreeObserver
import androidx.compose.ui.graphics.toArgb
import com.ardia.design.DeckBackdropStyle
import com.ardia.design.DeckMesh
import com.ardia.design.Frosting
import com.ardia.design.GrainTexture
import com.ardia.design.ProfileBackdropStyle
import com.ardia.design.ProfileLook
import com.ardia.design.SystemPalette
import com.ardia.design.TabsBackdropMotion
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import java.lang.ref.WeakReference
import kotlin.math.PI
import kotlin.math.ceil

internal object LookPaint {
    private val grainBitmap: Bitmap by lazy {
        val pixels = GrainTexture.values().map { value -> (0xFF shl 24) or (value shl 16) or (value shl 8) or value }.toIntArray()
        Bitmap.createBitmap(pixels, GrainTexture.SIDE, GrainTexture.SIDE, Bitmap.Config.ARGB_8888)
    }

    private val meshes = object : LinkedHashMap<Pair<ProfileLook, Boolean>, Bitmap>(8, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Pair<ProfileLook, Boolean>, Bitmap>?): Boolean = size > 12
    }

    private val grains = HashMap<Long, Paint>()

    fun grain(density: Float, opacity: Float): Paint {
        val alpha = (opacity.coerceIn(0f, 1f) * 255f).toInt()
        val key = (density.toRawBits().toLong() shl 32) or alpha.toLong()
        return grains.getOrPut(key) {
            Paint().apply {
                shader = BitmapShader(grainBitmap, Shader.TileMode.REPEAT, Shader.TileMode.REPEAT).apply {
                    setLocalMatrix(Matrix().apply { setScale(density / 2f, density / 2f) })
                }
                blendMode = BlendMode.OVERLAY
                this.alpha = alpha
            }
        }
    }

    private val grainsOver = HashMap<String, Paint>()

    fun grainOver(density: Float, opacity: Float, dark: Boolean, baseLightness: Float): Paint {
        val alpha = opacity.coerceIn(0f, 1f)
        val base = (baseLightness.coerceIn(0.05f, 0.95f) * 20f).toInt() / 20f
        val key = "$density $alpha $dark $base"
        return grainsOver.getOrPut(key) {
            val pixels = GrainTexture.values().map { value -> GrainOver.pixel(value, alpha, dark, base) }.toIntArray()
            val bitmap = Bitmap.createBitmap(pixels, GrainTexture.SIDE, GrainTexture.SIDE, Bitmap.Config.ARGB_8888)
            Paint().apply {
                shader = BitmapShader(bitmap, Shader.TileMode.REPEAT, Shader.TileMode.REPEAT).apply {
                    setLocalMatrix(Matrix().apply { setScale(density / 2f, density / 2f) })
                }
            }
        }
    }

    private data class ThemeMeshKey(val look: ThemeLook, val dark: Boolean, val width: Int, val height: Int)

    private val themeMeshes = object : LinkedHashMap<ThemeMeshKey, Bitmap>(4, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<ThemeMeshKey, Bitmap>?): Boolean = size > 4
    }

    fun forgetCaches() {
        synchronized(meshes) { meshes.clear() }
        synchronized(themeMeshes) { themeMeshes.clear() }
        grains.clear()
        grainsOver.clear()
        ThemeTextures.forgetCaches()
    }

    fun mesh(look: ProfileLook, dark: Boolean): Bitmap = synchronized(meshes) {
        meshes.getOrPut(look to dark) { Bitmap.createBitmap(DeckMesh.pixels(look, dark), DeckMesh.WIDTH, DeckMesh.HEIGHT, Bitmap.Config.ARGB_8888) }
    }

    fun themeMesh(art: ThemeArt, width: Int, height: Int): Bitmap = synchronized(themeMeshes) {
        themeMeshes.getOrPut(ThemeMeshKey(art.look, art.dark, width, height)) {
            Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).also { bitmap ->
                art.drawLayers(Canvas(bitmap), width.toFloat(), height.toFloat())
                bitmap.setHasAlpha(false)
            }
        }
    }
}

abstract class LookView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
    var color: String? = null
        set(value) {
            if (field != value) resolved = null
            field = value
        }
    var themeColors: List<String>? = null
        set(value) {
            if (field != value) resolved = null
            field = value
        }
    var darkThemeColors: List<String>? = null
        set(value) {
            if (field != value) resolved = null
            field = value
        }
    var dark: Boolean? = null

    var themeLook: ThemeLook? = null
        set(value) {
            if (field == value) return
            field = value
            resolved = null
            lightArt = null
            darkArt = null
            themeChanged()
        }

    private var lightArt: ThemeArt? = null
    private var darkArt: ThemeArt? = null

    protected fun themeArt(dark: Boolean): ThemeArt? {
        val theme = themeLook ?: return null
        return if (dark) darkArt ?: ThemeArt(theme, true).also { darkArt = it } else lightArt ?: ThemeArt(theme, false).also { lightArt = it }
    }

    protected open fun themeChanged() = Unit

    private class Resolved(val look: ProfileLook, val lookOrNull: ProfileLook?)

    private var resolved: Resolved? = null

    private fun resolve(): Resolved =
        resolved ?: Resolved(LookRules.look(color, themeColors, darkThemeColors), LookRules.lookOrNull(color, themeColors, darkThemeColors)).also { resolved = it }

    protected val density: Float get() = resources.displayMetrics.density

    protected val isDark: Boolean
        get() = LookRules.dark(dark, resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES, lookOrNull)

    protected val look: ProfileLook get() = resolve().look

    protected val lookOrNull: ProfileLook? get() = resolve().lookOrNull

    protected val lookIsOff: Boolean get() = LookSwitch.isOff(context)

    protected var budgetDegraded: Boolean = false
        private set

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        budgetDegraded = LookBudget.isDegraded(context)
        AttachedLookViews.attach(this)
    }

    override fun onDetachedFromWindow() {
        AttachedLookViews.detach(this)
        super.onDetachedFromWindow()
    }

    init {
        setWillNotDraw(false)
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) =
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), MeasureSpec.getSize(heightMeasureSpec))

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) = Unit

    open fun update() = invalidate()

    internal var drawFailures = 0
        private set

    final override fun onDraw(canvas: Canvas) = drawSafely(canvas)

    internal fun drawSafely(canvas: Canvas) {
        if (width <= 0 || height <= 0) return
        val saved = canvas.saveCount
        try {
            drawLook(canvas)
        } catch (failure: Exception) {
            canvas.restoreToCount(saved)
            fillBounds(canvas, fallbackColor())
            drawFailures += 1
            if (drawFailures == 1) {
                android.util.Log.w("PAGELAB", "PAGELAB look ${javaClass.simpleName} could not draw at ${width}x$height and fell back to a flat colour: ${failure.javaClass.simpleName}: ${failure.message}")
            }
        }
    }

    protected abstract fun drawLook(canvas: Canvas)

    private val fill = Paint()

    protected fun fillBounds(canvas: Canvas, colour: Int) {
        fill.color = colour
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), fill)
    }

    protected open fun fallbackColor(): Int = runCatching { SystemPalette.background.resolve(isDark).toArgb() }.getOrDefault(Color.GRAY)
}

internal object GrainOver {
    fun pixel(value: Int, opacity: Float, dark: Boolean, base: Float): Int {
        val grain = value / 255f
        val lift = 2f * grain - 1f
        val share = if (dark) {
            if (lift < 0f) -lift else lift * base / (1f - base)
        } else {
            if (lift > 0f) lift else -lift * (1f - base) / base
        }
        val alpha = (opacity * share * 255f).toInt().coerceIn(0, 255)
        val channel = if (lift > 0f) 255 else 0
        return Color.argb(alpha, channel, channel, channel)
    }
}

internal object LookActivity {
    @Volatile
    var backdropFrames = 0L
    @Volatile
    var sourceRecordings = 0L
    @Volatile
    var blurLayerRenders = 0L
    @Volatile
    var stripRecords = 0L
    @Volatile
    var stripRefreshes = 0L
    @Volatile
    var retints = 0L
    @Volatile
    var restingLayerHolds = 0L
    @Volatile
    var restingLayered = 0
    @Volatile
    var foreignTraversals = 0L
    val foreignLabels = ForeignLabels()
    @Volatile
    var tickNanos = 0L
    @Volatile
    var sceneWorkerNanos = 0L
    @Volatile
    var scenesOffMain = 0L
    @Volatile
    var blendsOffMain = 0L
    @Volatile
    var fadeCatchUps = 0L
}

internal object DeckLayers {
    fun layerable(backdrop: View): List<View> = restingContent(backdrop).flatMap(::withoutFrosts)

    private fun holdsFrost(view: View): Boolean =
        view is FrostView || (view is android.view.ViewGroup && (0 until view.childCount).any { holdsFrost(view.getChildAt(it)) })

    private fun withoutFrosts(view: View): List<View> = when {
        view is FrostView -> emptyList()
        !holdsFrost(view) -> listOf(view)
        view is android.view.ViewGroup -> (0 until view.childCount).map(view::getChildAt)
            .filter { it.visibility == View.VISIBLE && it.width > 0 && it.height > 0 }
            .flatMap(::withoutFrosts)
        else -> emptyList()
    }

    fun restingContent(backdrop: View): List<View> {
        var child: View = backdrop
        var parent = child.parent as? android.view.ViewGroup
        while (parent != null) {
            val at = parent.indexOfChild(child)
            val later = (at + 1 until parent.childCount).map(parent::getChildAt).filter { it.visibility == View.VISIBLE && it.width > 0 && it.height > 0 }
            if (later.isNotEmpty()) return later
            child = parent
            parent = parent.parent as? android.view.ViewGroup
        }
        return emptyList()
    }
}

internal class ForeignLabels(private val kept: Int = 32) {
    private val seen = ArrayDeque<Pair<Long, String>>()

    @Synchronized
    fun add(traversal: Long, label: String) {
        seen.addLast(traversal to label)
        while (seen.size > kept) seen.removeFirst()
    }

    @Synchronized
    fun since(traversal: Long, most: Int = 4): List<String> = seen.filter { it.first > traversal }.map { it.second }.distinct().take(most)
}

internal class ForeignDraws(private val dirty: (View) -> Boolean = View::isDirty) {
    private val placed = java.util.WeakHashMap<View, Int>()

    private fun placement(view: View): Int {
        var hash = view.left
        hash = hash * 31 + view.top
        hash = hash * 31 + view.right
        hash = hash * 31 + view.bottom
        hash = hash * 31 + view.scrollX
        hash = hash * 31 + view.scrollY
        hash = hash * 31 + java.lang.Float.floatToRawIntBits(view.translationX)
        hash = hash * 31 + java.lang.Float.floatToRawIntBits(view.translationY)
        hash = hash * 31 + java.lang.Float.floatToRawIntBits(view.translationZ)
        hash = hash * 31 + java.lang.Float.floatToRawIntBits(view.scaleX)
        hash = hash * 31 + java.lang.Float.floatToRawIntBits(view.scaleY)
        hash = hash * 31 + java.lang.Float.floatToRawIntBits(view.rotation)
        hash = hash * 31 + java.lang.Float.floatToRawIntBits(view.rotationX)
        hash = hash * 31 + java.lang.Float.floatToRawIntBits(view.rotationY)
        hash = hash * 31 + java.lang.Float.floatToRawIntBits(view.alpha)
        return hash * 31 + view.visibility
    }

    private fun moved(view: View): Boolean {
        val now = placement(view)
        val before = placed.put(view, now)
        return before != null && before != now
    }

    private val seenRect = android.graphics.Rect()
    private val deckRect = android.graphics.Rect()

    fun first(root: View, own: Collection<View>, deck: View? = null): View? {
        val explained = java.util.Collections.newSetFromMap(java.util.IdentityHashMap<View, Boolean>())
        for (view in own) {
            var at: View? = view
            while (at != null && explained.add(at)) at = at.parent as? View
        }
        val area = if (deck != null && deck.getGlobalVisibleRect(deckRect)) deckRect else null
        return walk(root, explained, deck, area)
    }

    private fun walk(view: View, explained: Set<View>, deck: View?, area: android.graphics.Rect?): View? {
        val movedItself = moved(view)
        if (view !in explained) return foreignWithin(view, movedItself, deck, area)
        if (movedItself && seen(view, deck, area)) return view
        if (view is android.view.ViewGroup) for (index in 0 until view.childCount) {
            walk(view.getChildAt(index), explained, deck, area)?.let { return it }
        }
        return null
    }

    private fun foreignWithin(view: View, movedItself: Boolean, deck: View?, area: android.graphics.Rect?): View? {
        if (!movedItself && !dirty(view)) return null
        if (!seen(view, deck, area)) return null
        if (movedItself || view !is android.view.ViewGroup) return view
        var anyChanged = false
        for (index in 0 until view.childCount) {
            val child = view.getChildAt(index)
            val childMoved = moved(child)
            if (!childMoved && !dirty(child)) continue
            anyChanged = true
            foreignWithin(child, childMoved, deck, area)?.let { return it }
        }
        return if (anyChanged) null else view
    }

    private fun seen(view: View, deck: View?, area: android.graphics.Rect?): Boolean {
        if (!view.isShown) return false
        var at: View? = view
        while (at != null) {
            if (at.alpha <= 0f) return false
            at = at.parent as? View
        }
        if (!view.getGlobalVisibleRect(seenRect)) return false
        if (area == null || deck == null) return true
        if (!android.graphics.Rect.intersects(seenRect, area)) return false
        return !(area.contains(seenRect) && DrawOrder.before(view, deck))
    }
}

internal object DrawOrder {
    private fun path(view: View): List<View> = generateSequence(view) { it.parent as? View }.toList().asReversed()

    fun before(first: View, second: View): Boolean {
        val a = path(first)
        val b = path(second)
        var depth = 0
        while (depth < a.size && depth < b.size && a[depth] === b[depth]) depth += 1
        if (depth == 0 || depth >= a.size || depth >= b.size) return false
        val parent = a[depth - 1] as? android.view.ViewGroup ?: return false
        val x = a[depth]
        val y = b[depth]
        val zx = x.z
        val zy = y.z
        if (zx != zy) return zx < zy
        return parent.indexOfChild(x) < parent.indexOfChild(y)
    }
}

internal class NamedRunnable(private val label: String, private val body: () -> Unit) : Runnable {
    override fun run() = body()

    override fun toString(): String = "$PREFIX$label"

    companion object {
        const val PREFIX = "ardia "
    }
}

internal interface SceneWork {
    fun render(job: Runnable)
    fun toMain(job: Runnable)

    companion object {
        private val thread by lazy { android.os.HandlerThread("ardia-look-scene", android.os.Process.THREAD_PRIORITY_DISPLAY).apply { start() } }
        private val worker by lazy { android.os.Handler(thread.looper) }
        private val main by lazy { android.os.Handler(android.os.Looper.getMainLooper()) }

        val background: SceneWork = object : SceneWork {
            override fun render(job: Runnable) {
                worker.post(job)
            }

            override fun toMain(job: Runnable) {
                main.post(job)
            }
        }

        val inline: SceneWork = object : SceneWork {
            override fun render(job: Runnable) = job.run()

            override fun toMain(job: Runnable) = job.run()
        }

        @Volatile
        var current: SceneWork = background
    }
}

internal class SceneRequest(
    val width: Int,
    val height: Int,
    val viewWidth: Float,
    val viewHeight: Float,
    val mesh: Bitmap,
    val shaders: Array<Shader>,
    val centres: FloatArray,
    val radius: Float,
    val blobAlpha: Int,
    val blobs: Boolean,
    val target: Bitmap?,
)

internal class SceneRenderer {
    private val meshPaint = Paint(Paint.FILTER_BITMAP_FLAG)
    private val blobPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val source = Rect()
    private val target = RectF()
    private var base: Bitmap? = null
    private var baseMesh: Bitmap? = null

    private fun base(request: SceneRequest): Bitmap {
        val kept = base?.takeIf { it.width == request.width && it.height == request.height && baseMesh === request.mesh }
        if (kept != null) return kept
        val made = base?.takeIf { it.width == request.width && it.height == request.height } ?: Bitmap.createBitmap(request.width, request.height, Bitmap.Config.RGBA_F16)
        val canvas = Canvas(made)
        source.set(0, 0, request.mesh.width, request.mesh.height)
        target.set(0f, 0f, request.width.toFloat() * (request.viewWidth + 1) / request.viewWidth, request.height.toFloat() * (request.viewHeight + 1) / request.viewHeight)
        canvas.drawBitmap(request.mesh, source, target, meshPaint)
        made.setHasAlpha(false)
        base = made
        baseMesh = request.mesh
        return made
    }

    private val blendPaint = Paint(Paint.FILTER_BITMAP_FLAG)

    fun blend(from: Bitmap, to: Bitmap, share: Float, target: Bitmap?): Bitmap {
        val bitmap = target?.takeIf { it.width == from.width && it.height == from.height && it.isMutable }
            ?: Bitmap.createBitmap(from.width, from.height, Bitmap.Config.RGBA_F16)
        val canvas = Canvas(bitmap)
        canvas.drawBitmap(from, 0f, 0f, null)
        blendPaint.alpha = (share * 255f + 0.5f).toInt().coerceIn(0, 255)
        if (blendPaint.alpha > 0) canvas.drawBitmap(to, 0f, 0f, blendPaint)
        bitmap.setHasAlpha(false)
        return bitmap
    }

    fun render(request: SceneRequest): Bitmap {
        val bitmap = request.target?.takeIf { it.width == request.width && it.height == request.height && it.isMutable }
            ?: Bitmap.createBitmap(request.width, request.height, Bitmap.Config.RGBA_F16)
        val canvas = Canvas(bitmap)
        canvas.drawBitmap(base(request), 0f, 0f, null)
        if (request.blobs) {
            canvas.scale(request.width / request.viewWidth, request.height / request.viewHeight)
            blobPaint.alpha = request.blobAlpha
            for (index in request.shaders.indices) {
                blobPaint.shader = request.shaders[index]
                val saved = canvas.save()
                canvas.translate(request.centres[index * 2], request.centres[index * 2 + 1])
                canvas.drawCircle(0f, 0f, request.radius, blobPaint)
                canvas.restoreToCount(saved)
            }
        }
        bitmap.setHasAlpha(false)
        return bitmap
    }
}

internal object AttachedLookViews {
    private val attached = java.util.WeakHashMap<LookView, Unit>()

    fun attach(view: LookView) = synchronized(attached) { attached[view] = Unit }

    fun detach(view: LookView) = synchronized(attached) { attached.remove(view) }

    fun all(): List<LookView> = synchronized(attached) { attached.keys.toList() }
}

internal object DeckBackdrops {
    private val shown = java.util.WeakHashMap<DeckBackdropView, Unit>()

    fun attach(view: DeckBackdropView) = synchronized(shown) { shown[view] = Unit }

    fun detach(view: DeckBackdropView) = synchronized(shown) { shown.remove(view) }

    fun all(): List<DeckBackdropView> = synchronized(shown) { shown.keys.toList() }
}

class DeckBackdropView(context: Context, appContext: AppContext) : LookView(context, appContext) {
    var reduceMotion: Boolean = false
    var reduceTransparency: Boolean = false

    private val meshPaint = Paint(Paint.FILTER_BITMAP_FLAG)
    private val scenePaint = Paint(Paint.FILTER_BITMAP_FLAG)
    private val sceneTarget = RectF()
    private val blobPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val source = Rect()
    private val target = Rect()
    private val centre = FloatArray(2)

    private var paintedLook: ProfileLook? = null
    private var paintedDark = false
    private var paintedRadius = -1f
    private var paintedArt: ThemeArt? = null
    private var paintedMeshSize = 0L
    private var mesh: Bitmap? = null
    private var blobShaders: Array<Shader> = emptyArray()

    private val themeMeshSize: Long get() = ((width / SCENE_SCALE).coerceAtLeast(1).toLong() shl 32) or (height / SCENE_SCALE).coerceAtLeast(1).toLong()

    private fun baseMesh(look: ProfileLook, dark: Boolean, art: ThemeArt?): Bitmap =
        if (art == null) LookPaint.mesh(look, dark) else LookPaint.themeMesh(art, (width / SCENE_SCALE).coerceAtLeast(1), (height / SCENE_SCALE).coerceAtLeast(1))

    private fun flatColour(look: ProfileLook, dark: Boolean): Int = themeArt(dark)?.flat ?: LookSwitch.flatDeck(look, dark).toArgb()

    override fun themeChanged() {
        forgetPaint()
        post { enclosingSource()?.let(FrostSources::redrawFrostsOf) }
    }

    private fun prepare(look: ProfileLook, dark: Boolean, radius: Float) {
        val art = themeArt(dark)
        val meshSize = if (art == null) 0L else themeMeshSize
        if (look === paintedLook && dark == paintedDark && radius == paintedRadius && art === paintedArt && meshSize == paintedMeshSize && mesh != null) return
        if (paintedLook != null) post { enclosingSource()?.let(FrostSources::redrawFrostsOf) }
        paintedLook = look
        paintedDark = dark
        paintedRadius = radius
        paintedArt = art
        paintedMeshSize = meshSize
        mesh = baseMesh(look, dark, art)
        blobShaders = look.deckBlobs(dark).map { blob ->
            val argb = blob.toArgb()
            RadialGradient(0f, 0f, radius, intArrayOf(argb, argb and 0x00FFFFFF), null, Shader.TileMode.CLAMP)
        }.toTypedArray()
    }

    private val systemStill: Boolean get() = reduceMotion || SystemMotion.reducedNow

    private val themed: Boolean get() = themeLook != null

    private val still: Boolean get() = systemStill || budgetDegraded || themed

    private val noBlobs: Boolean get() = reduceTransparency || budgetDegraded || themed

    internal val isAnimating: Boolean get() = isShown && !lookIsOff && !still && !noBlobs

    internal fun forgetPaint() {
        sceneGeneration += 1
        sceneInFlight = false
        sceneBuffers.clear()
        previousScene = null
        keyFrom = null
        keyTo = null
        keyNext = null
        keyRetired = null
        keyBuffers.clear()
        blendBuffers.clear()
        paintedLook = null
        paintedArt = null
        mesh = null
        blobShaders = emptyArray()
        scene = null
        sceneBase = null
        sceneBaseLook = null
        region = IntArray(0)
        sceneFresh = false
        grainNode?.discardDisplayList()
        grainNode = null
        grainKey = null
    }

    internal var frames = 0L
        private set
    private var drawnMode: String? = null
    private var firstFrameAt = 0L

    internal val framesPerSecond: Int
        get() {
            val elapsed = SystemClock.uptimeMillis() - firstFrameAt
            return if (frames < 2 || elapsed <= 0) 0 else ((frames - 1) * 1000 / elapsed).toInt()
        }

    internal fun meshCentre(): Int {
        val dark = isDark
        val mesh = baseMesh(look, dark, themeArt(dark))
        return mesh.getPixel(mesh.width / 2, mesh.height / 2)
    }

    internal fun firstBlobCentre(): Pair<Float, Float> {
        val angle = if (still) 0f else angle(0, clock(SystemClock.uptimeMillis()))
        return LookRules.blobCenter(0, angle, width.toFloat(), height.toFloat())
    }

    internal fun describe(): String =
        "${width}x$height, ${frames} frames, ${framesPerSecond} fps, ${if (still) "still" else "moving"}, ${if (isDark) "dark" else "light"}, " +
            "transparency ${if (noBlobs) "reduced" else "on"}${if (budgetDegraded) " (look budget: degraded)" else ""}, ${themeLook?.let { "theme ${it.stops.size} stop(s) ${it.texture.key}" } ?: "no theme"}, mesh centre ${LookProbeText.hex(meshCentre())}"

    private var lastOthersDrew = 0L
    private var ownDrawPending = false
    private val foreignDraws = ForeignDraws()
    private val counted = ViewTreeObserver.OnPreDrawListener {
        judgeTraversal()
        true
    }

    internal fun judgeTraversal(): Boolean {
        val own = ArrayList<View>(justLayered.size + 1)
        own += this
        own += justLayered
        enclosingSource()?.let { own += FrostSources.frostsOf(it) }
        val other = foreignDraws.first(rootView, own, this)
        val ours = other == null
        ownDrawPending = false
        justLayered.clear()
        if (ours) return false
        lastOthersDrew = SystemClock.uptimeMillis()
        LookActivity.foreignTraversals += 1
        LookActivity.foreignLabels.add(LookActivity.foreignTraversals, FrameTrace.label(other))
        releaseResting()
        return true
    }

    internal val holdsRestingLayers: Boolean get() = layered.isNotEmpty()

    internal fun stopMotion() {
        sceneGeneration += 1
        sceneInFlight = false
        keyInFlight = false
        blendInFlight = false
        removeCallbacks(tick)
        ownDrawPending = false
        releaseResting()
    }

    private val layered = ArrayList<Pair<View, Int>>()
    private val justLayered = ArrayList<View>()

    private fun holdRestingOnLayers() {
        if (layered.isNotEmpty() || !LookSwitch.deckLayers(context)) return
        for (view in DeckLayers.layerable(this)) {
            if (view.layerType == LAYER_TYPE_HARDWARE) continue
            layered += view to view.layerType
            justLayered += view
            view.setLayerType(LAYER_TYPE_HARDWARE, null)
        }
        if (layered.isEmpty()) return
        LookActivity.restingLayerHolds += 1
        LookActivity.restingLayered = layered.size
        if (PhoneLab.isOn) {
            android.util.Log.i("PAGELAB", "PAGELAB look deck holds its resting content on ${layered.size} layer(s) while the blobs move (hold #${LookActivity.restingLayerHolds}): ${layered.joinToString { (view, _) -> "${FrameTrace.label(view)} ${view.width}x${view.height}" }}")
        }
    }

    private fun releaseResting() {
        if (layered.isEmpty()) return
        for ((view, type) in layered) view.setLayerType(type, null)
        layered.clear()
        justLayered.clear()
        LookActivity.restingLayered = 0
    }
    private var clockBase = 0L
    private var runningSince = SystemClock.uptimeMillis()

    internal var heldStill = false
        private set

    private fun clock(now: Long): Long = if (heldStill) clockBase else clockBase + (now - runningSince)

    private fun holdStill(now: Long) {
        if (heldStill) return
        clockBase = clock(now)
        heldStill = true
    }

    private fun moveOn(now: Long) {
        if (!heldStill) return
        runningSince = now
        heldStill = false
    }

    private var paceMillis = 40L
    private val tick = NamedRunnable("deck tick") { advanceBlobs() }

    private var tickDueAt = 0L

    private fun scheduleTick(pace: Long) {
        val now = SystemClock.uptimeMillis()
        val due = (tickDueAt + pace).let { if (it <= now || it > now + pace) now + pace else it }
        tickDueAt = due
        val handler = handler
        if (handler == null) postDelayed(tick, pace) else handler.postAtTime(tick, due)
    }

    internal fun advanceBlobs() {
        if (!isAnimating) return stopMotion()
        val now = SystemClock.uptimeMillis()
        if (LookRules.othersMovedRecently(lastOthersDrew, now)) {
            holdStill(now)
            postDelayed(tick, paceMillis)
            return
        }
        val started = SystemClock.elapsedRealtimeNanos()
        moveOn(now)
        val at = clock(now)
        if (fades) {
            stepFade(at)
        } else if (!requestScene(at, listOf(scene, previousScene)) { made, look, dark ->
                previousScene = scene
                scene = made
                sceneAt = at
                sceneLook = look
                sceneDark = dark
                sceneFresh = true
                showScene()
            }
        ) {
            sceneFresh = renderScene(at)
            showScene()
        }
        LookActivity.tickNanos += SystemClock.elapsedRealtimeNanos() - started
    }

    private val sceneRenderer = SceneRenderer()
    private var sceneInFlight = false
    private var sceneGeneration = 0
    private var previousScene: Bitmap? = null
    private val sceneBuffers = ArrayList<Bitmap>(3)

    private val fades: Boolean get() = !still && LookSwitch.blobFramesPerSecond(context) == LookRules.PACED

    private var keyFrom: Bitmap? = null
    private var keyFromAt = 0L
    private var keyTo: Bitmap? = null
    private var keyToAt = 0L
    private var keyNext: Bitmap? = null
    private var keyNextAt = 0L
    private var keyRetired: Bitmap? = null
    private var keyInFlight = false
    private var blendInFlight = false
    private var fadeLook: ProfileLook? = null
    private var fadeDark = false
    private val keyBuffers = ArrayList<Bitmap>(5)
    private val blendBuffers = ArrayList<Bitmap>(3)

    internal val fadeScenes: Pair<Bitmap?, Bitmap?> get() = keyFrom to keyTo

    internal val fadeQueue: Triple<Long, Long, Long> get() = Triple(keyFromAt, keyToAt, if (keyNext != null) keyNextAt else -1L)

    internal fun clockForTests(): Long = clock(SystemClock.uptimeMillis())

    private fun fadeIsStale(): Boolean {
        val from = keyFrom ?: return true
        return fadeLook != look || fadeDark != isDark || from.width != (width / SCENE_SCALE).coerceAtLeast(1) || from.height != (height / SCENE_SCALE).coerceAtLeast(1)
    }

    private fun resetFade() {
        sceneGeneration += 1
        sceneInFlight = false
        keyInFlight = false
        blendInFlight = false
        keyFrom = null
        keyTo = null
        keyNext = null
        keyRetired = null
    }

    private fun startFade(at: Long): Boolean {
        resetFade()
        scene = null
        if (!renderScene(at)) return false
        keyFrom = scene
        keyFromAt = at
        fadeLook = look
        fadeDark = isDark
        return true
    }

    private fun shiftFade(at: Long) {
        val next = keyNext ?: return
        keyRetired = keyFrom
        keyFrom = keyTo
        keyTo = next
        keyNext = null
        val late = at - keyToAt
        keyFromAt = if (late > 0) at else keyToAt
        keyToAt = keyFromAt + LookRules.FADE_SCENE_MILLIS
        if (late > 0) LookActivity.fadeCatchUps += 1
    }

    private fun stepFade(at: Long) {
        if (fadeIsStale() && !startFade(at)) return
        if (keyTo != null && at >= keyToAt) shiftFade(at)
        if (!keyInFlight) {
            val target = when {
                keyTo == null -> keyFromAt + LookRules.FADE_SCENE_MILLIS
                keyNext == null -> keyToAt + LookRules.FADE_SCENE_MILLIS
                else -> -1L
            }
            if (target >= 0) {
                keyInFlight = true
                val asked = requestKeyframe(target, listOf(keyFrom, keyTo, keyNext, keyRetired, scene)) { made ->
                    keyInFlight = false
                    if (made == null) return@requestKeyframe
                    if (keyTo == null) {
                        keyTo = made
                        keyToAt = target
                    } else {
                        keyNext = made
                        keyNextAt = target
                    }
                }
                if (!asked) keyInFlight = false
            }
        }
        val from = keyFrom ?: return
        val to = keyTo
        if (to == null) {
            if (scene !== from) {
                previousScene = scene
                scene = from
            }
            sceneLook = fadeLook
            sceneDark = fadeDark
            sceneFresh = true
            showScene()
            return
        }
        if (blendInFlight) return
        blendInFlight = true
        val share = fadeShare(at)
        val generation = sceneGeneration
        val target = blendBuffers.firstOrNull { buffer -> buffer !== scene && buffer !== previousScene && buffer.width == from.width && buffer.height == from.height }
        val work = SceneWork.current
        val renderer = sceneRenderer
        work.render(Runnable {
            val started = SystemClock.elapsedRealtimeNanos()
            val made = runCatching { renderer.blend(from, to, share, target) }.getOrNull()
            LookActivity.sceneWorkerNanos += SystemClock.elapsedRealtimeNanos() - started
            LookActivity.blendsOffMain += 1
            work.toMain(NamedRunnable("deck blend hand-back") {
                val applied = SystemClock.elapsedRealtimeNanos()
                blendInFlight = false
                if (made == null || generation != sceneGeneration || !isAnimating) return@NamedRunnable
                if (blendBuffers.none { it === made }) {
                    blendBuffers.removeAll { it.width != made.width || it.height != made.height }
                    blendBuffers += made
                }
                previousScene = scene
                scene = made
                sceneLook = fadeLook
                sceneDark = fadeDark
                sceneFresh = true
                showScene()
                LookActivity.tickNanos += SystemClock.elapsedRealtimeNanos() - applied
            })
        })
    }

    internal fun fadeShare(at: Long): Float {
        if (keyTo == null || keyToAt <= keyFromAt) return 0f
        return ((at - keyFromAt).toFloat() / (keyToAt - keyFromAt)).coerceIn(0f, 1f)
    }

    private fun requestKeyframe(at: Long, inUse: List<Bitmap?>, apply: (Bitmap?) -> Unit): Boolean {
        if (width <= 0 || height <= 0 || lookIsOff || noBlobs) return false
        val request = sceneRequest(at, emptyList()) ?: return false
        val free = keyBuffers.firstOrNull { buffer -> inUse.none { it === buffer } && buffer.width == request.width && buffer.height == request.height }
        val sized = SceneRequest(request.width, request.height, request.viewWidth, request.viewHeight, request.mesh, request.shaders, request.centres, request.radius, request.blobAlpha, request.blobs, free)
        val generation = sceneGeneration
        val look = look
        val dark = isDark
        val work = SceneWork.current
        val renderer = sceneRenderer
        work.render(Runnable {
            val started = SystemClock.elapsedRealtimeNanos()
            val made = runCatching { renderer.render(sized) }.getOrNull()
            LookActivity.sceneWorkerNanos += SystemClock.elapsedRealtimeNanos() - started
            LookActivity.scenesOffMain += 1
            work.toMain(NamedRunnable("deck scene hand-back") {
                if (generation != sceneGeneration) return@NamedRunnable
                if (made == null || look != fadeLook || dark != fadeDark) return@NamedRunnable apply(null)
                if (keyBuffers.none { it === made }) {
                    keyBuffers.removeAll { it.width != made.width || it.height != made.height }
                    keyBuffers += made
                }
                apply(made)
            })
        })
        return true
    }

    private fun sceneRequest(at: Long, inUse: List<Bitmap?>): SceneRequest? {
        val w = width.toFloat()
        val h = height.toFloat()
        val dark = isDark
        val radius = LookRules.blobRadius(w, h)
        prepare(look, dark, radius)
        val meshBitmap = mesh ?: return null
        val sceneWidth = (width / SCENE_SCALE).coerceAtLeast(1)
        val sceneHeight = (height / SCENE_SCALE).coerceAtLeast(1)
        val shaders = blobShaders
        val centres = FloatArray(shaders.size * 2)
        for (index in shaders.indices) {
            LookRules.blobCenterInto(index, if (still) 0f else angle(index, at), w, h, centre)
            centres[index * 2] = centre[0]
            centres[index * 2 + 1] = centre[1]
        }
        val free = sceneBuffers.firstOrNull { buffer -> inUse.none { it === buffer } && buffer.width == sceneWidth && buffer.height == sceneHeight }
        return SceneRequest(sceneWidth, sceneHeight, w, h, meshBitmap, shaders, centres, radius, (DeckBackdropStyle.blobOpacity(dark) * 255f).toInt(), true, free)
    }

    internal fun sceneForTests(at: Long): Bitmap? = sceneRequest(at, emptyList())?.let { SceneRenderer().render(SceneRequest(it.width, it.height, it.viewWidth, it.viewHeight, it.mesh, it.shaders, it.centres, it.radius, it.blobAlpha, it.blobs, null)) }

    private fun requestScene(at: Long, inUse: List<Bitmap?>, apply: (Bitmap, ProfileLook, Boolean) -> Unit): Boolean {
        if (width <= 0 || height <= 0 || lookIsOff || noBlobs) return false
        if (sceneInFlight) return true
        val w = width.toFloat()
        val h = height.toFloat()
        val look = look
        val dark = isDark
        val radius = LookRules.blobRadius(w, h)
        prepare(look, dark, radius)
        val meshBitmap = mesh ?: return false
        val sceneWidth = (width / SCENE_SCALE).coerceAtLeast(1)
        val sceneHeight = (height / SCENE_SCALE).coerceAtLeast(1)
        val shaders = blobShaders
        val centres = FloatArray(shaders.size * 2)
        for (index in shaders.indices) {
            LookRules.blobCenterInto(index, if (still) 0f else angle(index, at), w, h, centre)
            centres[index * 2] = centre[0]
            centres[index * 2 + 1] = centre[1]
        }
        val free = sceneBuffers.firstOrNull { buffer -> inUse.none { it === buffer } && buffer.width == sceneWidth && buffer.height == sceneHeight }
        val request = SceneRequest(sceneWidth, sceneHeight, w, h, meshBitmap, shaders, centres, radius, (DeckBackdropStyle.blobOpacity(dark) * 255f).toInt(), true, free)
        val generation = sceneGeneration
        val work = SceneWork.current
        val renderer = sceneRenderer
        sceneInFlight = true
        work.render(Runnable {
            val started = SystemClock.elapsedRealtimeNanos()
            val made = runCatching { renderer.render(request) }.getOrNull()
            LookActivity.sceneWorkerNanos += SystemClock.elapsedRealtimeNanos() - started
            work.toMain(NamedRunnable("deck scene hand-back") {
                val applied = SystemClock.elapsedRealtimeNanos()
                sceneInFlight = false
                if (made == null || generation != sceneGeneration || !isAnimating) return@NamedRunnable
                if (sceneBuffers.none { it === made }) {
                    sceneBuffers.removeAll { it.width != sceneWidth || it.height != sceneHeight }
                    sceneBuffers += made
                }
                LookActivity.scenesOffMain += 1
                apply(made, look, dark)
                LookActivity.tickNanos += SystemClock.elapsedRealtimeNanos() - applied
            })
        })
        return true
    }

    private fun showScene() {
        ownDrawPending = true
        holdRestingOnLayers()
        invalidate()
        enclosingSource()?.let(FrostSources::sceneChanged)
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        DeckBackdrops.attach(this)
        viewTreeObserver.addOnPreDrawListener(counted)
    }

    override fun onDetachedFromWindow() {
        DeckBackdrops.detach(this)
        viewTreeObserver.removeOnPreDrawListener(counted)
        stopMotion()
        super.onDetachedFromWindow()
    }

    override fun onVisibilityAggregated(isVisible: Boolean) {
        super.onVisibilityAggregated(isVisible)
        if (!isVisible) stopMotion() else invalidate()
    }

    private fun stopMotionAfterDraw() {
        removeCallbacks(tick)
        ownDrawPending = false
        if (layered.isNotEmpty()) post { if (!isAnimating) releaseResting() }
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (PhoneLab.isOn) android.util.Log.i("PAGELAB", "PAGELAB look deck size ${oldw}x$oldh -> ${w}x$h")
    }

    override fun drawLook(canvas: Canvas) {
        val dark = isDark
        val look = look
        val drawn = "${if (dark) "dark" else "light"}, look $look${themeLook?.let { ", theme ${it.stops.size} stop(s) ${it.texture.key} at ${it.angle.toInt()}°" } ?: ""}, ${width}x$height, " +
            "${if (systemStill) "still (reduce motion${if (!reduceMotion) ", read natively" else ""})" else if (budgetDegraded) "still (look budget)" else if (themed) "still (theme)" else "moving"}, " +
            "${if (reduceTransparency) "no blobs (reduce transparency)" else if (budgetDegraded) "no blobs (look budget)" else if (themed) "no blobs (theme)" else "blobs"}, " +
            (if (lookIsOff) "look switched off in the lab: flat colour" else "look on") +
            ", backdrop drawn as ${LookSwitch.backdropDraw(context).label} (scene ${(width / SCENE_SCALE).coerceAtLeast(1)}x${(height / SCENE_SCALE).coerceAtLeast(1)})"
        if (drawn != drawnMode) {
            drawnMode = drawn
            if (PhoneLab.isOn) {
                val asked = this.dark?.let { if (it) "dark" else "light" } ?: "the system's mode"
                android.util.Log.i("PAGELAB", "PAGELAB look deck draws $drawn (asked $asked${if (lookOrNull?.isAlwaysDark == true) ", this look is always dark" else ""})")
            }
        }
        if (frames == 0L) {
            firstFrameAt = SystemClock.uptimeMillis()
            if (PhoneLab.isOn) android.util.Log.i("PAGELAB", "PAGELAB look deck first frame ${width}x$height ${if (dark) "dark" else "light"} ${if (still) "still" else "moving"}")
        }
        frames += 1
        LookActivity.backdropFrames += 1
        if (lookIsOff) {
            stopMotionAfterDraw()
            fillBounds(canvas, flatColour(look, dark))
            return
        }
        val w = width.toFloat()
        val h = height.toFloat()
        val at = clock(SystemClock.uptimeMillis())
        if (noBlobs) {
            stopMotionAfterDraw()
            drawScene(canvas, look, dark, w, h, at)
            sceneFresh = false
            return
        }
        if (!paint(canvas, LookSwitch.backdropDraw(context), look, dark, at)) return
        val animated = !still
        removeCallbacks(tick)
        if (!animated || !isShown) {
            stopMotionAfterDraw()
        } else {
            when (val delay = if (fades) LookRules.FADE_FRAME_MILLIS else LookRules.nextBlobFrameMillis(LookSwitch.blobFramesPerSecond(context), w, h)) {
                0L -> postOnAnimation(tick)
                else -> {
                    paceMillis = delay
                    scheduleTick(delay)
                }
            }
        }
    }

    override fun fallbackColor(): Int = runCatching { flatColour(look, isDark) }.getOrDefault(super.fallbackColor())

    internal fun paint(canvas: Canvas, mode: LookSwitch.BackdropDraw, look: ProfileLook = this.look, dark: Boolean = isDark, at: Long = clock(SystemClock.uptimeMillis())): Boolean {
        val w = width.toFloat()
        val h = height.toFloat()
        val fresh = sceneFresh
        sceneFresh = false
        when (mode) {
            LookSwitch.BackdropDraw.Full -> {
                if (!drawScene(canvas, look, dark, w, h, at)) return false
                val art = themeArt(dark)
                if (art != null) art.drawTexture(canvas, w, h, density) else canvas.drawRect(0f, 0f, w, h, LookPaint.grain(density, DeckBackdropStyle.grainOpacity(dark)))
                if (!fresh) renderScene(at)
            }
            LookSwitch.BackdropDraw.Small, LookSwitch.BackdropDraw.SmallNoGrain -> {
                if (fades && fadeIsStale() && !startFade(at)) return false
                val shown = scene
                val stale = shown == null || sceneLook !== look || sceneDark != dark || shown.width != (width / SCENE_SCALE).coerceAtLeast(1) || shown.height != (height / SCENE_SCALE).coerceAtLeast(1)
                if (!fresh && (stale || still) && !renderScene(at)) return false
                val small = scene ?: return false
                sceneTarget.set(0f, 0f, w, h)
                canvas.drawBitmap(small, null, sceneTarget, scenePaint)
                if (mode == LookSwitch.BackdropDraw.Small) drawGrain(canvas, dark)
            }
            LookSwitch.BackdropDraw.Flat -> {
                fillBounds(canvas, flatColour(look, dark))
                if (!fresh) renderScene(at)
            }
        }
        return true
    }

    private fun drawScene(canvas: Canvas, look: ProfileLook, dark: Boolean, w: Float, h: Float, at: Long): Boolean {
        val radius = LookRules.blobRadius(w, h)
        prepare(look, dark, radius)
        val meshBitmap = mesh ?: return false
        source.set(0, 0, meshBitmap.width, meshBitmap.height)
        target.set(0, 0, width + 1, height + 1)
        canvas.drawBitmap(meshBitmap, source, target, meshPaint)
        if (noBlobs) return true
        drawBlobs(canvas, dark, w, h, at, radius)
        return true
    }

    private fun drawBlobs(canvas: Canvas, dark: Boolean, w: Float, h: Float, at: Long, radius: Float) {
        val animated = !still
        val now = at
        blobPaint.alpha = (DeckBackdropStyle.blobOpacity(dark) * 255f).toInt()
        for (index in blobShaders.indices) {
            val angle = if (animated) angle(index, now) else 0f
            LookRules.blobCenterInto(index, angle, w, h, centre)
            blobPaint.shader = blobShaders[index]
            val saved = canvas.save()
            canvas.translate(centre[0], centre[1])
            canvas.drawCircle(0f, 0f, radius, blobPaint)
            canvas.restoreToCount(saved)
        }
    }

    private var sceneBase: Bitmap? = null
    private var sceneBaseLook: ProfileLook? = null
    private var sceneBaseDark = false

    private fun meshBase(look: ProfileLook, dark: Boolean, sceneWidth: Int, sceneHeight: Int, w: Float, h: Float): Bitmap? {
        val kept = sceneBase?.takeIf { it.width == sceneWidth && it.height == sceneHeight && sceneBaseLook === look && sceneBaseDark == dark && mesh != null && paintedLook === look }
        if (kept != null) return kept
        val radius = LookRules.blobRadius(w, h)
        prepare(look, dark, radius)
        val meshBitmap = mesh ?: return null
        val base = sceneBase?.takeIf { it.width == sceneWidth && it.height == sceneHeight } ?: Bitmap.createBitmap(sceneWidth, sceneHeight, Bitmap.Config.RGBA_F16).also { sceneBase = it }
        val canvas = Canvas(base)
        canvas.scale(sceneWidth / w, sceneHeight / h)
        source.set(0, 0, meshBitmap.width, meshBitmap.height)
        target.set(0, 0, width + 1, height + 1)
        canvas.drawBitmap(meshBitmap, source, target, meshPaint)
        base.setHasAlpha(false)
        sceneBaseLook = look
        sceneBaseDark = dark
        return base
    }

    private var scene: Bitmap? = null
    private var region = IntArray(0)

    private fun regionAverage(bitmap: Bitmap, x0: Int, y0: Int, x1: Int, y1: Int): Int {
        val width = x1 - x0
        val height = y1 - y0
        if (width <= 0 || height <= 0) return Color.GRAY
        if (region.size < width * height) region = IntArray(width * height)
        bitmap.getPixels(region, 0, width, x0, y0, width, height)
        return FrostTint.average(region, width, 0, 0, width, height)
    }
    private var sceneAt = Long.MIN_VALUE
    private var sceneLook: ProfileLook? = null
    private var sceneDark = false
    private var sceneFresh = false
    private var grainNode: RenderNode? = null
    private var grainKey: String? = null

    internal val sceneSize: Pair<Int, Int>? get() = scene?.let { it.width to it.height }

    internal val shownScene: Bitmap? get() = scene

    private fun renderScene(at: Long): Boolean {
        if (width <= 0 || height <= 0 || lookIsOff) return false
        val w = width.toFloat()
        val h = height.toFloat()
        val sceneWidth = (width / SCENE_SCALE).coerceAtLeast(1)
        val sceneHeight = (height / SCENE_SCALE).coerceAtLeast(1)
        val look = look
        val dark = isDark
        val kept = scene?.takeIf { it.width == sceneWidth && it.height == sceneHeight }
        if (kept != null && at == sceneAt && look === sceneLook && dark == sceneDark) return true
        val bitmap = kept ?: Bitmap.createBitmap(sceneWidth, sceneHeight, Bitmap.Config.RGBA_F16).also {
            scene = it
        }
        sceneAt = Long.MIN_VALUE
        val base = meshBase(look, dark, sceneWidth, sceneHeight, w, h) ?: return false
        val canvas = Canvas(bitmap)
        canvas.drawBitmap(base, 0f, 0f, null)
        canvas.scale(sceneWidth / w, sceneHeight / h)
        if (!noBlobs) drawBlobs(canvas, dark, w, h, at, LookRules.blobRadius(w, h))
        bitmap.setHasAlpha(false)
        sceneAt = at
        sceneLook = look
        sceneDark = dark
        return true
    }

    private fun drawGrain(canvas: Canvas, dark: Boolean) {
        val art = themeArt(dark)
        if (art != null && art.grainAlpha <= 0f) return
        val paint: Paint
        val kind: String
        if (art != null) {
            paint = ThemeTextures.paint(art.texture, density, art.grainAlpha)
            kind = "${art.texture.key} ${paint.alpha}"
        } else {
            val base = FrostTint.lightness(mesh?.let { it.getPixel(it.width / 2, it.height / 2) } ?: LookSwitch.flatDeck(look, dark).toArgb())
            paint = LookPaint.grainOver(density, DeckBackdropStyle.grainOpacity(dark) * if (dark) SMALL_GRAIN_DARK else SMALL_GRAIN_LIGHT, dark, base)
            kind = "$dark $base"
        }
        if (!canvas.isHardwareAccelerated) {
            canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
            return
        }
        val key = "${width}x$height $kind"
        val node = grainNode ?: RenderNode("ardiaGrain").also { grainNode = it }
        if (key != grainKey) {
            node.setPosition(0, 0, width, height)
            val recording = node.beginRecording(width, height)
            try {
                recording.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
            } finally {
                node.endRecording()
            }
            grainKey = key
        }
        canvas.drawRenderNode(node)
    }

    internal fun sceneColours(left: Float, top: Float, right: Float, bottom: Float, out: IntArray): Boolean {
        if (width <= 0 || height <= 0 || lookIsOff) return false
        if (scene == null && !renderScene(clock(SystemClock.uptimeMillis()))) return false
        val bitmap = scene ?: return false
        val sceneWidth = bitmap.width
        val sceneHeight = bitmap.height
        val w = width.toFloat()
        val h = height.toFloat()
        val x0 = (left / w * sceneWidth).toInt().coerceIn(0, sceneWidth - 1)
        val x1 = (right / w * sceneWidth).toInt().coerceIn(x0 + 1, sceneWidth)
        val y0 = (top / h * sceneHeight).toInt().coerceIn(0, sceneHeight - 1)
        val y1 = (bottom / h * sceneHeight).toInt().coerceIn(y0 + 1, sceneHeight)
        val middle = ((y0 + y1) / 2).coerceIn(y0 + 1, y1)
        out[0] = regionAverage(bitmap, x0, y0, x1, middle)
        out[1] = regionAverage(bitmap, x0, if (middle < y1) middle else y0, x1, y1)
        return true
    }

    private fun enclosingSource(): FrostSourceView? {
        var current: android.view.ViewParent? = parent
        while (current != null) {
            if (current is FrostSourceView) return current
            current = current.parent
        }
        return null
    }

    companion object {
        const val SCENE_SCALE = 8
        const val SMALL_GRAIN_LIGHT = 1.12f
        const val SMALL_GRAIN_DARK = 1.4f
    }

    private fun angle(index: Int, now: Long): Float {
        val loop = TabsBackdropMotion.loopsMillis[index]
        val progress = (now % loop).toFloat() / loop
        val full = (2 * PI).toFloat()
        return if (index % 2 == 0) full * progress else full * (1f - progress)
    }
}

class ProfileBackdropView(context: Context, appContext: AppContext) : LookView(context, appContext) {
    var themed: Boolean = false
    var softened: Boolean = false
    var fadesOut: Boolean = false

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val mask = Paint().apply { xfermode = PorterDuffXfermode(PorterDuff.Mode.DST_IN) }

    override fun drawLook(canvas: Canvas) {
        val dark = isDark
        val w = width.toFloat()
        val h = height.toFloat()
        if (lookIsOff) {
            fillBounds(canvas, shownArt(dark)?.flat ?: LookSwitch.flatBackdrop(look, dark, themed).toArgb())
            return
        }
        if (!fadesOut) {
            drawBackdrop(canvas, dark, w, h)
            return
        }
        paint.shader = null
        paint.color = SystemPalette.background.resolve(dark).toArgb()
        canvas.drawRect(0f, 0f, w, h, paint)
        val layer = canvas.saveLayer(0f, 0f, w, h, null)
        drawBackdrop(canvas, dark, w, h)
        val (positions, alphas) = LookRules.fadeMask()
        mask.shader = LinearGradient(0f, 0f, 0f, h, alphas.map { alpha -> Color.argb((alpha * 255f).toInt(), 0, 0, 0) }.toIntArray(), positions, Shader.TileMode.CLAMP)
        canvas.drawRect(0f, 0f, w, h, mask)
        canvas.restoreToCount(layer)
    }

    private fun shownArt(dark: Boolean): ThemeArt? = if (themed) themeArt(dark) else null

    private fun drawBackdrop(canvas: Canvas, dark: Boolean, w: Float, h: Float) {
        val art = shownArt(dark)
        if (art != null) {
            art.draw(canvas, w, h, density)
            if (softened || fadesOut) {
                paint.shader = null
                paint.color = ProfileBackdropStyle.softening.resolve(dark).toArgb()
                canvas.drawRect(0f, 0f, w, h, paint)
            }
            return
        }
        val look = look
        val colors = look.backdropColors(dark, themed).map { it.toArgb() }.toIntArray()
        paint.shader = null
        if (colors.size >= 2) {
            val diagonal = look.showsTheme(dark, themed)
            paint.shader = LinearGradient(0f, 0f, if (diagonal) w else 0f, h, colors, null, Shader.TileMode.CLAMP)
        } else {
            paint.color = colors.firstOrNull() ?: Color.TRANSPARENT
        }
        canvas.drawRect(0f, 0f, w, h, paint)
        if (softened || fadesOut) {
            paint.shader = null
            paint.color = ProfileBackdropStyle.softening.resolve(dark).toArgb()
            canvas.drawRect(0f, 0f, w, h, paint)
        }
        canvas.drawRect(0f, 0f, w, h, LookPaint.grain(density, ProfileBackdropStyle.grainOpacity(dark)))
    }
}

class FilmGrainView(context: Context, appContext: AppContext) : LookView(context, appContext) {
    var opacity: Float = ProfileBackdropStyle.LIGHT_GRAIN

    override fun drawLook(canvas: Canvas) = Unit

    override fun dispatchDraw(canvas: Canvas) {
        super.dispatchDraw(canvas)
        if (lookIsOff || width <= 0 || height <= 0) return
        runCatching { canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), LookPaint.grain(density, opacity)) }
    }
}

internal object FrostSources {
    enum class PageMode(val raw: String) { Live("live"), Solid("solid") }

    private val sources = HashMap<String, WeakReference<FrostSourceView>>()
    private val frosts = java.util.WeakHashMap<FrostView, Unit>()

    @Volatile
    var pageMode: PageMode = PageMode.Solid

    fun register(id: String, view: FrostSourceView) {
        synchronized(sources) { sources[id] = WeakReference(view) }
        view.invalidate()
        redrawFrostsNamed(id)
    }

    fun unregister(id: String, view: FrostSourceView) {
        val removed = synchronized(sources) {
            if (sources[id]?.get() === view) sources.remove(id) != null else false
        }
        if (removed) redrawFrostsNamed(id)
    }

    private fun redrawFrostsNamed(id: String) {
        for (frost in frosts()) if (frost.source == id) frost.invalidate()
    }

    fun find(id: String?): FrostSourceView? = id?.let { synchronized(sources) { sources[it]?.get() } }

    fun attach(view: FrostView) = synchronized(frosts) { frosts[view] = Unit }

    fun detach(view: FrostView) = synchronized(frosts) { frosts.remove(view) }

    fun frosts(): List<FrostView> = synchronized(frosts) { frosts.keys.toList() }

    fun allSources(): List<FrostSourceView> = synchronized(sources) { sources.values.mapNotNull { it.get() } }

    fun anyFrostCanBlur(id: String?): Boolean = id != null && frosts().any { it.source == id && it.isAttachedToWindow && it.wantsSource() }

    fun sourceChanged(id: String?) {
        find(id)?.invalidate()
    }

    fun redrawFrostsOf(source: FrostSourceView) {
        for (frost in frosts()) if (frost.source != null && find(frost.source) === source) frost.invalidate()
    }

    fun wakeFrostsWaitingOn(source: FrostSourceView) {
        for (frost in frostsOf(source)) if (frost.waitsOnSource()) frost.invalidate()
    }

    fun retintFrostsOf(source: FrostSourceView) {
        for (frost in frosts()) if (frost.lastChoice?.path == FrostPage.Path.Tinted && frost.source != null && find(frost.source) === source) frost.retint()
    }

    fun sceneChanged(source: FrostSourceView) {
        for (frost in frostsOf(source)) if (frost.lastChoice?.path == FrostPage.Path.Tinted) frost.retint()
    }

    fun frostsOf(source: FrostSourceView): List<FrostView> = frosts().filter { it.source != null && find(it.source) === source }
}

class FrostSourceView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
    private var recorder: RenderNode? = null

    internal val node: RenderNode? get() = recorder

    internal val isRecording: Boolean get() = recorder != null

    var sourceId: String? = null
        set(value) {
            if (field == value) return
            field?.let { FrostSources.unregister(it, this) }
            field = value
            if (isAttachedToWindow) value?.let { FrostSources.register(it, this) }
        }

    internal val hasContent: Boolean get() = recorder?.hasDisplayList() == true

    private var pageKnown = false
    private var pageHeld = false

    internal val holdsPage: Boolean
        get() {
            if (!pageKnown) {
                pageHeld = FrostPage.holdsPage(this)
                pageKnown = true
            }
            return pageHeld
        }

    private var knownFinding: FrostTint.Finding? = null

    internal val finding: FrostTint.Finding
        get() = knownFinding ?: FrostTint.inspect(this).also { knownFinding = it }

    internal val holdsOnlyBackdrop: Boolean get() = finding.backdrop != null

    internal fun backdrop(): DeckBackdropView? = finding.backdrop

    private val laidOut = ViewTreeObserver.OnGlobalLayoutListener {
        val pageBefore = if (pageKnown) pageHeld else null
        pageKnown = false
        val before = knownFinding
        knownFinding = null
        if ((before != null && before != finding) || (pageBefore != null && pageBefore != holdsPage)) FrostSources.redrawFrostsOf(this)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (recorder != null) FrostSources.redrawFrostsOf(this)
    }

    private val strips = HashMap<FrostStrip.Key, FrostStrip>()

    internal val stripsHeld: Collection<FrostStrip> get() = strips.values

    data class StripStats(val count: Int, val bytes: Long)

    @Volatile
    internal var stripStats = StripStats(0, 0L)
        private set

    private fun publishStats() {
        stripStats = StripStats(strips.size, strips.values.sumOf { it.bytes })
    }

    internal fun join(frost: FrostView, key: FrostStrip.Key, drawingTime: Long, wanted: Rect): FrostStrip {
        var evicted = false
        val iterator = strips.entries.iterator()
        while (iterator.hasNext()) {
            val (held, strip) = iterator.next()
            if (held == key || !strip.consumers.remove(frost)) continue
            strip.stale = true
            if (strip.consumers.isEmpty()) {
                strip.release()
                iterator.remove()
                evicted = true
            } else {
                strip.wakeOneConsumer()
            }
        }
        val strip = strips.getOrPut(key) { FrostStrip(key) }
        if (strip.consumers.add(frost)) strip.stale = true
        strip.discardRetiredBefore(drawingTime)
        if (strip.stale || strip.laidOutAt != drawingTime || !strip.covers(FrostStrip.place(wanted, width, height, key.scale))) layout(strip, drawingTime, frost)
        if (evicted) publishStats()
        return strip
    }

    internal fun leave(frost: FrostView) {
        var changed = false
        val iterator = strips.values.iterator()
        while (iterator.hasNext()) {
            val strip = iterator.next()
            if (!strip.consumers.remove(frost)) continue
            changed = true
            strip.stale = true
            if (strip.consumers.isEmpty()) {
                strip.release()
                iterator.remove()
            } else {
                strip.wakeOneConsumer()
            }
        }
        if (changed) publishStats()
    }

    private var stripsBehind = false

    private val beforeDraw = ViewTreeObserver.OnPreDrawListener {
        if (stripsBehind) refreshStrips()
        true
    }

    override fun onDescendantInvalidated(child: View, target: View) {
        super.onDescendantInvalidated(child, target)
        if (strips.isNotEmpty()) stripsBehind = true
    }

    private fun refreshStrips() {
        stripsBehind = false
        val content = recorder ?: return
        for (strip in strips.values) if (strip.refresh(content)) LookActivity.stripRefreshes += 1
    }

    private fun layout(strip: FrostStrip, drawingTime: Long, drawing: FrostView?) {
        val content = recorder ?: return
        val area = Rect()
        val theirs = Rect()
        val sharing = ArrayList<FrostView>()
        for (consumer in strip.consumers) {
            if (consumer.stripNeed(this, theirs) != strip.key) continue
            if (sharing.isEmpty()) area.set(theirs) else area.union(theirs)
            sharing += consumer
        }
        if (sharing.isEmpty()) {
            strip.laidOutAt = drawingTime
            return
        }
        val placed = FrostStrip.place(area, width, height, strip.key.scale)
        val slots = FrostStrip.slotOrder(sharing.mapNotNull { consumer -> consumer.lensIn(this, placed, strip.key.scale)?.let { consumer to it } }) { it.first.number }
        val lenses = LiquidGlassRules.lensField(slots.map { it.second }, resources.displayMetrics.density, strip.key.scale, strip.key.saturation)
        val slotted = slots.map { it.first }.toSet()
        if (!strip.stale && strip.laysOut(placed, lenses, slotted, sharing)) {
            strip.laidOutAt = drawingTime
            return
        }
        val routedBefore = sharing.associateWith { strip.nodeFor(it) }
        strip.record(content, placed, drawingTime, lenses, slotted, sharing)
        strip.stale = false
        for ((consumer, node) in routedBefore) if (consumer !== drawing && strip.nodeFor(consumer) !== node) consumer.invalidate()
        publishStats()
        LookActivity.stripRecords += 1
    }

    private fun stopRecording() {
        recorder?.discardDisplayList()
        recorder = null
        strips.values.forEach(FrostStrip::release)
        strips.clear()
        publishStats()
    }

    internal fun release() {
        stopRecording()
        invalidate()
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) =
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), MeasureSpec.getSize(heightMeasureSpec))

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) = Unit

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        sourceId?.let { FrostSources.register(it, this) }
        viewTreeObserver.addOnGlobalLayoutListener(laidOut)
        viewTreeObserver.addOnPreDrawListener(beforeDraw)
    }

    override fun onDetachedFromWindow() {
        viewTreeObserver.removeOnGlobalLayoutListener(laidOut)
        viewTreeObserver.removeOnPreDrawListener(beforeDraw)
        sourceId?.let { FrostSources.unregister(it, this) }
        stopRecording()
        super.onDetachedFromWindow()
    }

    override fun dispatchDraw(canvas: Canvas) {
        val wanted = canvas.isHardwareAccelerated && width > 0 && height > 0 && !LookSwitch.isOff(context) && FrostSources.anyFrostCanBlur(sourceId)
        if (!wanted) {
            if (recorder != null) stopRecording()
            super.dispatchDraw(canvas)
            return
        }
        val fresh = recorder == null
        val node = recorder ?: RenderNode("ardiaFrostSource").also { recorder = it }
        LookActivity.sourceRecordings += 1
        node.setPosition(0, 0, width, height)
        node.setUseCompositingLayer(holdsPage, null)
        val recording = node.beginRecording(width, height)
        try {
            super.dispatchDraw(recording)
        } finally {
            node.endRecording()
        }
        canvas.drawRenderNode(node)
        if (fresh) FrostSources.redrawFrostsOf(this) else FrostSources.wakeFrostsWaitingOn(this)
    }
}

internal object FrostPage {
    const val SOURCE_NOT_DRAWN = "source not drawn yet"
    const val OFF_SCREEN = "off screen: nothing to blur until it is seen"
    const val NO_SOURCE = "no source"
    const val INSIDE_SOURCE = "inside its own source"

    fun unsourced(choice: Choice?): Boolean = choice?.path == Path.Fallback && (choice.reason == NO_SOURCE || choice.reason == INSIDE_SOURCE)

    fun holdsPage(view: View, sized: (View) -> Boolean = { it.width > 0 && it.height > 0 }): Boolean {
        if (view.visibility != View.VISIBLE) return false
        if (view is android.webkit.WebView) return sized(view)
        if (view !is android.view.ViewGroup) return false
        for (index in 0 until view.childCount) if (holdsPage(view.getChildAt(index), sized)) return true
        return false
    }

    enum class Path { Live, Solid, Fallback, Tinted }

    fun wantsSource(choice: Choice?, onlyBackdropUnder: Boolean, blurOverBackdrop: Boolean, holdsPage: Boolean, pageMode: FrostSources.PageMode): Boolean = when {
        holdsPage && pageMode == FrostSources.PageMode.Solid -> false
        choice == null -> !(onlyBackdropUnder && !blurOverBackdrop)
        else -> choice.path == Path.Live || choice.reason == SOURCE_NOT_DRAWN || choice.reason == NO_SOURCE
    }

    data class Choice(val path: Path, val reason: String)

    fun choose(
        blurSupported: Boolean,
        reduceTransparency: Boolean,
        budgetDegraded: Boolean = false,
        onlyBackdropUnder: Boolean = false,
        blurOverBackdrop: Boolean = false,
        hasSource: Boolean,
        sourceHasContent: Boolean,
        hardware: Boolean,
        insideSource: Boolean,
        holdsPage: Boolean,
        pageMode: FrostSources.PageMode,
        lookOff: Boolean = false,
        onScreen: Boolean = true,
    ): Choice = when {
        lookOff -> Choice(Path.Fallback, "look turned off in the lab")
        !onScreen -> Choice(Path.Fallback, OFF_SCREEN)
        reduceTransparency -> Choice(Path.Fallback, "reduce transparency")
        budgetDegraded -> Choice(Path.Fallback, "look budget: this phone measured over budget")
        hasSource && onlyBackdropUnder && (!blurOverBackdrop || !blurSupported) -> Choice(Path.Tinted, "only the backdrop under it: a fill tinted from the backdrop's colours, no blur")
        !blurSupported -> Choice(Path.Fallback, "below Android 12")
        !hasSource -> Choice(Path.Fallback, NO_SOURCE)
        !hardware -> Choice(Path.Fallback, "software canvas")
        insideSource -> Choice(Path.Fallback, INSIDE_SOURCE)
        holdsPage && pageMode == FrostSources.PageMode.Solid -> Choice(Path.Solid, "page under the frost, solid page mode")
        !sourceHasContent -> Choice(Path.Fallback, SOURCE_NOT_DRAWN)
        holdsPage -> Choice(Path.Live, "page under the frost, redrawn every frame")
        else -> Choice(Path.Live, "no page under the frost")
    }
}

internal class FrostStrip(val key: Key, private val afterNextFrame: (() -> Unit) -> Unit = FrostStrip::afterNextFrame) {
    data class Key(val blurPx: Float, val saturation: Float, val scale: Float)

    val node = RenderNode("ardiaFrostStrip").apply { setUseCompositingLayer(true, null) }
    private val filtered = RenderNode("ardiaFrostStripFiltered")
    private var plainNode: RenderNode? = null
    private var plainFiltered: RenderNode? = null
    val consumers = LinkedHashSet<FrostView>()
    var stale = true
    var laidOutAt = Long.MIN_VALUE
    var left = 0
        private set
    var top = 0
        private set
    var width = 0
        private set
    var height = 0
        private set
    var records = 0L
        private set
    private var effectSet = false
    private var lensesApplied: LiquidGlassRules.LensField? = null
    private var lensShader: android.graphics.RuntimeShader? = null
    private var slotted: Set<FrostView> = emptySet()
    var lensed = 0
        private set

    val holdsPlain: Boolean get() = plainNode != null

    fun wakeOneConsumer() {
        consumers.firstOrNull { it.samplesNow }?.invalidate()
    }

    var refreshes = 0L
        private set

    fun refresh(source: RenderNode): Boolean {
        if (!effectSet || width <= 0 || height <= 0) return false
        draw(source)
        refreshes += 1
        return true
    }

    fun covers(area: Rect): Boolean = width > 0 && height > 0 && area.left >= left && area.top >= top && area.right <= left + width && area.bottom <= top + height

    fun laysOut(placed: Rect, lenses: LiquidGlassRules.LensField?, slots: Set<FrostView>, drawers: Collection<FrostView>): Boolean =
        effectSet && placed.left == left && placed.top == top && placed.width() == width && placed.height() == height &&
            lenses == lensesApplied && slots == slotted && !(lenses != null && lensed == 0 && !GlassShaders.lens.failed) &&
            (lensed == 0 || drawers.all { it in slots }) == (plainNode == null)

    fun nodeFor(frost: FrostView): RenderNode = if (lensed == 0 || frost in slotted) node else plainNode ?: node

    fun record(source: RenderNode, placed: Rect, drawingTime: Long, lenses: LiquidGlassRules.LensField? = null, slots: Set<FrostView> = emptySet(), drawers: Collection<FrostView> = slots) {
        laidOutAt = drawingTime
        left = placed.left
        top = placed.top
        width = placed.width()
        height = placed.height()
        records += 1
        val scaledLeft = (left / key.scale).toInt()
        val scaledTop = (top / key.scale).toInt()
        val scaledWidth = ceil(width / key.scale).toInt().coerceAtLeast(1)
        val scaledHeight = ceil(height / key.scale).toInt().coerceAtLeast(1)
        node.setPosition(scaledLeft, scaledTop, scaledLeft + scaledWidth, scaledTop + scaledHeight)
        filtered.setPosition(0, 0, scaledWidth, scaledHeight)
        val lensBack = lenses != null && lensed == 0 && !GlassShaders.lens.failed
        val lensesMoved = !effectSet || lenses != lensesApplied || lensBack
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && lensesMoved) {
            val lens = if (lenses != null && Build.VERSION.SDK_INT >= LiquidGlassRules.LENS_MIN_SDK) GlassShaders.lensFor(lenses) { lensShader ?: LiquidGlassShaders.lens().also { lensShader = it } } else null
            val blur = key.blurPx / key.scale
            filtered.setRenderEffect(if (lens == null) FrostStrip.frosted(blur, key.saturation) else RenderEffect.createChainEffect(lens, RenderEffect.createBlurEffect(blur, blur, Shader.TileMode.CLAMP)))
            lensed = if (lens == null) 0 else lenses?.lenses?.size ?: 0
            lensesApplied = lenses
            effectSet = true
        }
        slotted = slots
        val plainWanted = lensed > 0 && drawers.any { it !in slots }
        if (plainWanted) {
            val outer = plainNode ?: RenderNode("ardiaFrostStripPlain").apply { setUseCompositingLayer(true, null) }.also { plainNode = it }
            val inner = plainFiltered ?: RenderNode("ardiaFrostStripPlainFiltered").also { plainFiltered = it }
            outer.setPosition(scaledLeft, scaledTop, scaledLeft + scaledWidth, scaledTop + scaledHeight)
            inner.setPosition(0, 0, scaledWidth, scaledHeight)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) inner.setRenderEffect(FrostStrip.frosted(key.blurPx / key.scale, key.saturation))
        } else {
            dropPlain()
        }
        draw(source)
    }

    private val retired = ArrayList<Pair<RenderNode, Long>>()

    val retiring: Int get() = retired.size

    private fun dropPlain() {
        val gone = listOfNotNull(plainNode, plainFiltered)
        plainNode = null
        plainFiltered = null
        if (gone.isEmpty()) return
        gone.forEach { retired += it to laidOutAt }
        afterNextFrame { discard(gone) }
    }

    private fun discard(nodes: List<RenderNode>) {
        for (node in nodes) if (retired.removeAll { it.first === node }) node.discardDisplayList()
    }

    fun discardRetiredBefore(drawingTime: Long) {
        if (retired.isEmpty()) return
        val gone = retired.filter { it.second != drawingTime }
        gone.forEach { it.first.discardDisplayList() }
        retired.removeAll(gone)
    }

    private fun discardRetired() {
        retired.forEach { it.first.discardDisplayList() }
        retired.clear()
    }

    private fun draw(source: RenderNode) {
        drawInto(filtered, node, source)
        val outer = plainNode
        val inner = plainFiltered
        if (outer != null && inner != null) drawInto(inner, outer, source)
    }

    private fun drawInto(inner: RenderNode, outer: RenderNode, source: RenderNode) {
        val recording = inner.beginRecording()
        try {
            recording.scale(1f / key.scale, 1f / key.scale)
            recording.translate(-left.toFloat(), -top.toFloat())
            recording.drawRenderNode(source)
        } finally {
            inner.endRecording()
        }
        val layer = outer.beginRecording()
        try {
            layer.drawRenderNode(inner)
        } finally {
            outer.endRecording()
        }
    }

    fun release() {
        node.discardDisplayList()
        filtered.discardDisplayList()
        dropPlain()
        discardRetired()
        laidOutAt = Long.MIN_VALUE
        stale = true
        effectSet = false
        lensesApplied = null
        slotted = emptySet()
        lensed = 0
        width = 0
        height = 0
    }

    val bytes: Long get() = if (width <= 0 || height <= 0) 0L else ceil(width / key.scale).toLong() * ceil(height / key.scale).toLong() * 4 * (if (holdsPlain) 4 else 2)

    companion object {
        fun afterNextFrame(work: () -> Unit) {
            android.view.Choreographer.getInstance().postFrameCallback { work() }
        }

        fun place(area: Rect, sourceWidth: Int, sourceHeight: Int, scale: Float): Rect {
            val step = scale.toInt().coerceAtLeast(1)
            val left = (area.left.coerceIn(0, sourceWidth) / step) * step
            val top = (area.top.coerceIn(0, sourceHeight) / step) * step
            val right = area.right.coerceIn(left, sourceWidth.coerceAtLeast(left))
            val bottom = area.bottom.coerceIn(top, sourceHeight.coerceAtLeast(top))
            return Rect(left, top, right, bottom)
        }

        fun <T> slotOrder(candidates: List<T>, order: (T) -> Int): List<T> = candidates.sortedBy(order).take(LiquidGlassRules.MAX_LENSES)

        @androidx.annotation.RequiresApi(Build.VERSION_CODES.S)
        fun frosted(radius: Float, saturation: Float): RenderEffect {
            val blur = RenderEffect.createBlurEffect(radius, radius, Shader.TileMode.CLAMP)
            if (saturation == 1f) return blur
            val matrix = android.graphics.ColorMatrix().apply { setSaturation(saturation) }
            return RenderEffect.createChainEffect(RenderEffect.createColorFilterEffect(android.graphics.ColorMatrixColorFilter(matrix)), blur)
        }
    }
}

internal object FrostScale {
    const val MAX_LOW_RES_BLUR = 6f
    const val MAX_SCALE = 8f

    fun of(blurPixels: Float): Float = ceil(blurPixels / MAX_LOW_RES_BLUR).coerceIn(1f, MAX_SCALE)
}

internal object FrostRefresh {

    fun label(name: String?, source: String?, variant: String?, number: Int): String =
        name?.takeIf { it.isNotBlank() } ?: "${source ?: "-"}/${variant ?: "bar"} #$number"

    private var made = 0

    fun nextNumber(): Int = synchronized(this) { ++made }
}

open class FrostView(context: Context, appContext: AppContext) : LookView(context, appContext) {
    var source: String? = null
        set(value) {
            if (field == value) return
            val before = field
            field = value
            forgetLayer()
            FrostSources.sourceChanged(before)
            FrostSources.sourceChanged(value)
            invalidate()
        }
    var name: String? = null
    var variant: String? = null

    internal val number = FrostRefresh.nextNumber()

    internal val logLabel: String get() = FrostRefresh.label(name, source, variant, number)
    private var joined: FrostSourceView? = null
    var cornerRadius: Float = 0f
    var reduceTransparency: Boolean = false
        set(value) {
            if (field == value) return
            field = value
            FrostSources.sourceChanged(source)
        }

    private var blurNode: RenderNode? = null
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val bounds = RectF()
    private val clip = Path()
    private val here = IntArray(2)
    private val there = IntArray(2)
    private var lastOffset = Long.MIN_VALUE

    private val seen = Rect()

    private fun onScreen(): Boolean = isAttachedToWindow && width > 0 && height > 0 && getGlobalVisibleRect(seen)

    private val moved = ViewTreeObserver.OnPreDrawListener {
        if (!samplesNow) return@OnPreDrawListener true
        if (lastChoice?.reason == FrostPage.OFF_SCREEN) {
            if (onScreen()) invalidate()
            return@OnPreDrawListener true
        }
        if (lastChoice?.path == FrostPage.Path.Live && !onScreen()) {
            invalidate()
            return@OnPreDrawListener true
        }
        if (lastChoice?.path != FrostPage.Path.Live) return@OnPreDrawListener true
        val from = FrostSources.find(source)
        if (from != null) {
            val offset = offsetTo(from)
            if (offset != lastOffset) invalidate()
        }
        true
    }

    internal var lastChoice: FrostPage.Choice? = null
        private set

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        viewTreeObserver.addOnPreDrawListener(moved)
        FrostSources.attach(this)
        FrostSources.sourceChanged(source)
    }

    override fun onDetachedFromWindow() {
        FrostSources.detach(this)
        viewTreeObserver.removeOnPreDrawListener(moved)
        forgetLayer()
        FrostSources.sourceChanged(source)
        super.onDetachedFromWindow()
    }

    internal open fun canBlur(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && Frosting.isBlurSupported && !reduceTransparency && !lookIsOff && !budgetDegraded

    internal val holdsLayer: Boolean get() = blurNode != null

    internal var layerWidth = 0
        private set
    internal var layerHeight = 0
        private set

    internal open fun lensReach(): Float = 0f

    internal open fun pageLive(): Boolean = false

    internal open fun blursBackdrop(): Boolean = LookSwitch.blurOverBackdrop(context)

    internal open fun settled(choice: FrostPage.Choice) = Unit

    internal open fun solidFill(dark: Boolean): Int? = null

    internal open fun lensAt(xPx: Int, yPx: Int, scale: Float): LiquidGlassRules.StripLens? = null

    internal open val samplesNow: Boolean get() = isAttachedToWindow && isShown

    override fun onVisibilityAggregated(isVisible: Boolean) {
        super.onVisibilityAggregated(isVisible)
        if (!isVisible) forgetLayer() else invalidate()
    }

    internal open fun forgetLayer() {
        joined?.leave(this)
        joined = null
        blurNode?.discardDisplayList()
        blurNode = null
        layerWidth = 0
        layerHeight = 0
    }

    private fun effectivePageMode(): FrostSources.PageMode = if (pageLive()) FrostSources.PageMode.Live else FrostSources.pageMode

    internal fun waitsOnSource(): Boolean = samplesNow && lastChoice?.path != FrostPage.Path.Live && wantsSource()

    internal fun wantsSource(): Boolean {
        if (!canBlur()) return false
        val from = FrostSources.find(source)
        return FrostPage.wantsSource(lastChoice, onlyBackdropUnder = from?.holdsOnlyBackdrop == true, blurOverBackdrop = blursBackdrop(), holdsPage = from?.holdsPage == true, pageMode = effectivePageMode())
    }

    private var reportedFinding: String? = null

    private fun report(choice: FrostPage.Choice, found: String?) {
        if (choice == lastChoice && found == reportedFinding) return
        val wanted = wantsSource()
        val changed = choice != lastChoice
        lastChoice = choice
        reportedFinding = found
        if (wantsSource() != wanted) FrostSources.sourceChanged(source)
        if (changed) settled(choice)
        if (PhoneLab.isOn) {
            android.util.Log.i("PAGELAB", "PAGELAB look frost $logLabel ${width}x$height path=${choice.path.name.lowercase()} (${choice.reason}); source ${source ?: "none"}: ${found ?: "not found"}")
        }
    }

    override fun drawLook(canvas: Canvas) {
        val dark = isDark
        val style = LookRules.frost(variant, lookOrNull)
        val radius = cornerRadius * density
        bounds.set(0f, 0f, width.toFloat(), height.toFloat())
        clip.reset()
        clip.addRoundRect(bounds, radius, radius, Path.Direction.CW)
        val from = FrostSources.find(source)
        val blurs = canBlur()
        val choice = FrostPage.choose(
            blurSupported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && Frosting.isBlurSupported,
            reduceTransparency = reduceTransparency,
            budgetDegraded = budgetDegraded,
            onlyBackdropUnder = from?.holdsOnlyBackdrop == true,
            blurOverBackdrop = blursBackdrop(),
            hasSource = from != null,
            sourceHasContent = from?.hasContent == true,
            hardware = canvas.isHardwareAccelerated,
            insideSource = from != null && isInside(from),
            holdsPage = blurs && from?.holdsPage == true,
            pageMode = effectivePageMode(),
            lookOff = lookIsOff,
            onScreen = onScreen(),
        )
        report(choice, from?.finding?.why)
        if (choice.path == FrostPage.Path.Live && from != null) {
            val layerNode = blurNode ?: RenderNode("ardiaFrost").also { blurNode = it }
            val blur = style.blurRadius.value * density
            val scale = FrostScale.of(blur)
            val margin = LiquidGlassRules.marginPx(blur, lensReach())
            val offset = offsetTo(from)
            lastOffset = offset
            val dx = (offset shr 32).toInt()
            val dy = offset.toInt()
            if (joined !== from) joined?.leave(this)
            joined = from
            val strip = from.join(this, FrostStrip.Key(blur, style.saturation, scale), drawingTime, stripArea(-dx, -dy, margin))
            layerWidth = ceil((width + margin * 2) / scale).toInt()
            layerHeight = ceil((height + margin * 2) / scale).toInt()
            layerNode.setPosition(0, 0, layerWidth, layerHeight)
            LookActivity.blurLayerRenders += 1
            val recording = layerNode.beginRecording()
            try {
                recording.translate((dx + margin) / scale, (dy + margin) / scale)
                recording.drawRenderNode(strip.nodeFor(this))
            } finally {
                layerNode.endRecording()
            }
            canvas.save()
            canvas.clipPath(clip)
            canvas.translate(-margin, -margin)
            canvas.scale(scale, scale)
            canvas.drawRenderNode(layerNode)
            canvas.restore()
            paint.style = Paint.Style.FILL
            paint.color = style.tint.resolve(dark).toArgb()
            canvas.drawPath(clip, paint)
        } else if (choice.path == FrostPage.Path.Tinted && from != null && tintedFill(canvas, from, style, dark)) {
            if (blurNode != null || joined != null) forgetLayer()
        } else {
            if (blurNode != null || joined != null) forgetLayer()
            paint.style = Paint.Style.FILL
            paint.color = solidFill(dark) ?: style.fallback.resolve(dark).toArgb()
            canvas.drawPath(clip, paint)
        }
        style.edge?.let { edge ->
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = style.edgeWidth.value * density
            paint.color = edge.resolve(dark).toArgb()
            canvas.drawPath(clip, paint)
        }
    }

    private val sampled = IntArray(2)
    private val tinted = IntArray(2)
    private val drawnTint = IntArray(2)
    private var tintDrawn = false

    internal var retints = 0L
        private set
    internal var retintsSkipped = 0L
        private set

    private fun tintColours(from: FrostSourceView, style: com.ardia.design.FrostedStyle, dark: Boolean): Boolean {
        val backdrop = from.backdrop() ?: return false
        backdrop.getLocationInWindow(there)
        getLocationInWindow(here)
        val left = (here[0] - there[0]).toFloat()
        val top = (here[1] - there[1]).toFloat()
        if (!backdrop.sceneColours(left, top, left + width, top + height, sampled)) return false
        val tint = style.tint.resolve(dark).toArgb()
        tinted[0] = FrostTint.frosted(sampled[0], style.saturation, tint)
        tinted[1] = FrostTint.frosted(sampled[1], style.saturation, tint)
        return true
    }

    internal fun retint() {
        val from = FrostSources.find(source) ?: return
        if (!tintColours(from, LookRules.frost(variant, lookOrNull), isDark)) return invalidate()
        if (tintDrawn && tinted[0] == drawnTint[0] && tinted[1] == drawnTint[1]) {
            retintsSkipped += 1
            return
        }
        retints += 1
        LookActivity.retints += 1
        invalidate()
    }

    private fun tintedFill(canvas: Canvas, from: FrostSourceView, style: com.ardia.design.FrostedStyle, dark: Boolean): Boolean {
        if (!tintColours(from, style, dark)) return false
        paint.style = Paint.Style.FILL
        paint.shader = LinearGradient(0f, 0f, 0f, height.toFloat(), tinted[0], tinted[1], Shader.TileMode.CLAMP)
        canvas.drawPath(clip, paint)
        paint.shader = null
        drawnTint[0] = tinted[0]
        drawnTint[1] = tinted[1]
        tintDrawn = true
        return true
    }

    private val stripBox = Rect()

    private fun stripArea(x: Int, y: Int, margin: Float): Rect {
        val reach = ceil(margin).toInt()
        stripBox.set(x - reach, y - reach, x + width + reach, y + height + reach)
        return stripBox
    }

    internal fun stripNeed(from: FrostSourceView, into: Rect): FrostStrip.Key? {
        if (!samplesNow || width <= 0 || height <= 0 || !canBlur()) return null
        val style = LookRules.frost(variant, lookOrNull)
        val blur = style.blurRadius.value * density
        val margin = LiquidGlassRules.marginPx(blur, lensReach())
        val offset = offsetTo(from)
        into.set(stripArea(-(offset shr 32).toInt(), -offset.toInt(), margin))
        return FrostStrip.Key(blur, style.saturation, FrostScale.of(blur))
    }

    internal fun lensIn(from: FrostSourceView, placed: Rect, scale: Float): LiquidGlassRules.StripLens? {
        val offset = offsetTo(from)
        return lensAt(-(offset shr 32).toInt() - placed.left, -offset.toInt() - placed.top, scale)
    }

    private fun offsetTo(from: View): Long {
        from.getLocationInWindow(there)
        getLocationInWindow(here)
        val dx = there[0] - here[0]
        val dy = there[1] - here[1]
        return (dx.toLong() shl 32) or (dy.toLong() and 0xFFFFFFFFL)
    }

    private fun isInside(from: View): Boolean {
        var current: android.view.ViewParent? = parent
        while (current != null) {
            if (current === from) return true
            current = current.parent
        }
        return false
    }
}

internal object LookMemory {
    private const val MB = 1024.0 * 1024.0

    data class Counts(
        val sources: Int,
        val recording: Int,
        val frosts: Int,
        val holdingLayers: Int,
        val layerBytes: Long,
        val decks: Int,
        val animating: Int,
        val recordingNames: List<String> = emptyList(),
        val layerNames: List<String> = emptyList(),
        val heldStill: Int = 0,
        val tinted: Int = 0,
        val strips: Int = 0,
    )

    fun counts(): Counts {
        val sources = FrostSources.allSources()
        val frosts = FrostSources.frosts()
        val layered = frosts.filter { it.holdsLayer }
        val decks = DeckBackdrops.all()
        val strips = sources.map { it.stripStats }
        return Counts(
            sources = sources.size,
            recording = sources.count { it.isRecording },
            frosts = frosts.size,
            holdingLayers = layered.size,
            layerBytes = layered.sumOf { it.layerWidth.toLong() * it.layerHeight * 4 } + strips.sumOf { it.bytes },
            strips = strips.sumOf { it.count },
            decks = decks.size,
            animating = decks.count { it.isAnimating && !it.heldStill },
            recordingNames = sources.filter { it.isRecording }.map { it.sourceId ?: "?" },
            layerNames = layered.map { it.logLabel },
            heldStill = decks.count { it.heldStill },
            tinted = frosts.count { it.lastChoice?.path == FrostPage.Path.Tinted },
        )
    }

    fun line(context: Context): String {
        val counts = counts()
        val largest = FrostSources.frosts().filter { it.holdsLayer }.maxByOrNull { it.layerWidth.toLong() * it.layerHeight }
        return "look ${if (LookSwitch.isOff(context)) "off" else "on"}: ${counts.recording} of ${counts.sources} frost source(s) recording ${counts.recordingNames}, " +
            "${counts.holdingLayers} of ${counts.frosts} frost(s) holding a layer over ${counts.strips} shared blur strip(s) (${counts.tinted} tinted from the backdrop), about ${"%.1f".format(counts.layerBytes / MB)} MB" +
            (largest?.let { " (largest ${it.logLabel} ${it.layerWidth}x${it.layerHeight})" } ?: "") +
            ", ${counts.animating} of ${counts.decks} deck backdrop(s) animating (${counts.heldStill} held still while the screen moves), frosts with a layer ${counts.layerNames}"
    }

    fun trim(): String {
        val hidden = FrostSources.frosts().filter { !it.isShown && it.holdsLayer }
        hidden.forEach { it.forgetLayer() }
        DeckBackdrops.all().filter { !it.isShown }.forEach { it.forgetPaint() }
        LookPaint.forgetCaches()
        return "look trimmed: dropped ${hidden.size} hidden frost layer(s) and the look's paint caches"
    }

    fun releaseAll(): String {
        val before = counts()
        FrostSources.frosts().forEach {
            it.forgetLayer()
            it.invalidate()
        }
        FrostSources.allSources().forEach { it.release() }
        DeckBackdrops.all().forEach {
            it.stopMotion()
            it.forgetPaint()
            it.invalidate()
        }
        LookPaint.forgetCaches()
        return "look released for the hidden app: ${before.holdingLayers} frost layer(s) (about ${"%.1f".format(before.layerBytes / MB)} MB), " +
            "${before.recording} source recording(s), the deck paint and caches; all are rebuilt when the app is seen again"
    }

    fun release(level: Int): String = when {
        level >= android.content.ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN -> releaseAll()
        ImageMemory.clearsOn(level) -> trim()
        else -> "look kept"
    }
}

internal object FrostTint {
    fun lightness(colour: Int): Float = (0.213f * Color.red(colour) + 0.715f * Color.green(colour) + 0.072f * Color.blue(colour)) / 255f

    fun average(pixels: IntArray, stride: Int, x0: Int, y0: Int, x1: Int, y1: Int): Int {
        var r = 0L
        var g = 0L
        var b = 0L
        var n = 0L
        for (y in y0 until y1) for (x in x0 until x1) {
            val pixel = pixels[y * stride + x]
            if (Color.alpha(pixel) == 0) continue
            r += Color.red(pixel)
            g += Color.green(pixel)
            b += Color.blue(pixel)
            n += 1
        }
        if (n == 0L) return Color.GRAY
        return Color.rgb((r / n).toInt(), (g / n).toInt(), (b / n).toInt())
    }

    fun frosted(base: Int, saturation: Float, tint: Int): Int {
        val r = Color.red(base)
        val g = Color.green(base)
        val b = Color.blue(base)
        val luminance = 0.213f * r + 0.715f * g + 0.072f * b
        fun saturate(channel: Int) = (luminance + (channel - luminance) * saturation).coerceIn(0f, 255f)
        val alpha = Color.alpha(tint) / 255f
        fun over(channel: Float, tintChannel: Int) = (tintChannel * alpha + channel * (1f - alpha)).toInt().coerceIn(0, 255)
        return Color.rgb(over(saturate(r), Color.red(tint)), over(saturate(g), Color.green(tint)), over(saturate(b), Color.blue(tint)))
    }

    data class Finding(val backdrop: DeckBackdropView?, val why: String)

    fun inspect(source: android.view.ViewGroup): Finding {
        val drawn = ArrayList<View>()
        for (index in 0 until source.childCount) collectDrawn(source.getChildAt(index), drawn)
        if (drawn.size > MOST_VIEWS) return Finding(null, "more than $MOST_VIEWS views drawn: blur it")
        val at = drawn.indexOfFirst { it is DeckBackdropView }
        if (at < 0) return Finding(null, "no deck backdrop in it, ${drawn.size} view(s) drawn: blur it")
        val backdrop = drawn[at] as DeckBackdropView
        val box = boundsIn(backdrop, source)
        if (box[0] > 0 || box[1] > 0 || box[2] < source.width || box[3] < source.height) {
            return Finding(null, "the deck backdrop covers ${box[0]},${box[1]} to ${box[2]},${box[3]} of ${source.width}x${source.height}: blur it")
        }
        val wrappers = generateSequence<android.view.ViewParent>(backdrop.parent) { it.parent }.takeWhile { it !== source }.toSet<Any>()
        val under = drawn.subList(0, at).count { it !in wrappers }
        val above = drawn.subList(at + 1, drawn.size)
        val drawing = above.firstOrNull { !drawsNothingOver(it) }
        if (drawing != null) return Finding(null, "${describe(drawing)} draws over the deck backdrop: blur it")
        return Finding(backdrop, "only the deck backdrop shows: $under view(s) under it hidden by it, ${above.size} over it that draw nothing")
    }

    private const val MOST_VIEWS = 32

    private fun collectDrawn(view: View, into: MutableList<View>) {
        if (into.size > MOST_VIEWS || view.visibility != View.VISIBLE || view.alpha == 0f || view.width == 0 || view.height == 0) return
        into += view
        if (view is android.view.ViewGroup) for (index in 0 until view.childCount) collectDrawn(view.getChildAt(index), into)
    }

    private fun drawsNothingOver(view: View): Boolean {
        if (view is FilmGrainView) return true
        if (view is LookView) return false
        if (view.background != null || view.foreground != null) return false
        return view is android.view.ViewGroup || view.javaClass == View::class.java
    }

    private fun boundsIn(view: View, ancestor: View): IntArray {
        var left = 0
        var top = 0
        var current: View = view
        while (current !== ancestor) {
            left += current.left
            top += current.top
            current = current.parent as? View ?: break
        }
        return intArrayOf(left, top, left + view.width, top + view.height)
    }

    private fun describe(view: View): String =
        "${view.javaClass.simpleName} ${view.width}x${view.height}${if (view.background != null) " with a background" else ""}${if (view.foreground != null) " with a foreground" else ""}"
}
