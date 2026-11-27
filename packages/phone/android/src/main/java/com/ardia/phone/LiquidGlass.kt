package com.ardia.phone

import android.graphics.RenderEffect
import android.graphics.RuntimeShader
import android.os.Build
import androidx.annotation.RequiresApi
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

internal object LiquidGlassRules {
    const val FLAT_GLASS_ARGUMENT = "ArdiaFlatGlass"
    const val LENS_MIN_SDK = Build.VERSION_CODES.TIRAMISU
    const val BLUR_MIN_SDK = Build.VERSION_CODES.S
    const val CIRCULAR_CORNER_EXPONENT = 2f
    const val EDGE_FEATHER_PX = 1f
    const val BEZEL_SHARE_OF_SHORT_SIDE = 0.3f

    enum class Render(val raw: String) { Lens("lens"), Frost("frost"), Solid("solid"), Classic("classic") }

    data class Params(
        val ior: Float,
        val dispersion: Float,
        val bezelDp: Float,
        val depthDp: Float,
        val maxSlope: Float,
        val lightAngle: Float,
        val specularWidthDp: Float,
        val specularStrength: Float,
        val oppositeStrength: Float,
        val specularFalloff: Float,
        val specularSharpness: Float,
        val specularOpacity: Float,
    )

    val defaults = Params(
        ior = 1.5f,
        dispersion = 0.04f,
        bezelDp = 14f,
        depthDp = 9f,
        maxSlope = 5.67f,
        lightAngle = (-Math.PI / 4).toFloat(),
        specularWidthDp = 1.25f,
        specularStrength = 1f,
        oppositeStrength = 0.5f,
        specularFalloff = 0.6f,
        specularSharpness = 6f,
        specularOpacity = 0.5f,
    )

    fun flatAsked(arguments: Map<String, Any>): Boolean = arguments[FLAT_GLASS_ARGUMENT] == true

    fun render(sdk: Int, classic: Boolean, flat: Boolean, blurs: Boolean): Render = when {
        classic -> Render.Classic
        !blurs || sdk < BLUR_MIN_SDK -> Render.Solid
        flat || sdk < LENS_MIN_SDK -> Render.Frost
        else -> Render.Lens
    }

    fun pageLive(sdk: Int, classic: Boolean): Boolean = !classic && sdk >= LENS_MIN_SDK

    fun samplesBackdrop(sdk: Int, classic: Boolean, flat: Boolean, lensFailed: Boolean): Boolean = !lensFailed && lensWanted(sdk, classic, flat, livePath = true)

    fun rimWanted(sdk: Int, classic: Boolean, flat: Boolean, blurs: Boolean): Boolean = blurs && !classic && !flat && sdk >= LENS_MIN_SDK

    fun lensWanted(sdk: Int, classic: Boolean, flat: Boolean, livePath: Boolean): Boolean =
        livePath && render(sdk, classic, flat, blurs = true) == Render.Lens

    fun bezelDp(params: Params, widthDp: Float, heightDp: Float): Float =
        min(params.bezelDp, min(widthDp, heightDp).coerceAtLeast(0f) * BEZEL_SHARE_OF_SHORT_SIDE)

    fun profile(progress: Float): Float {
        val u = 1f - progress.coerceIn(0f, 1f)
        return sqrt(max(1f - u.pow(4), 0.0001f))
    }

    fun slope(progress: Float, maxSlope: Float): Float {
        val u = 1f - progress.coerceIn(0f, 1f)
        val inside = max(1f - u.pow(4), 0.0001f)
        return min(2f * u.pow(3) / sqrt(inside), maxSlope)
    }

    fun shiftRatio(slope: Float, ior: Float): Float {
        val length = sqrt(slope * slope + 1f)
        val eta = 1f / max(ior, 1.0001f)
        val cosine = 1f / length
        val k = 1f - eta * eta * (1f - cosine * cosine)
        if (k < 0f) return 0f
        val along = eta * cosine - sqrt(k)
        val sideways = -along * slope / length
        val down = eta - along / length
        return sideways / max(down, 0.0001f)
    }

    fun maxShiftDp(params: Params, bezelDp: Float): Float {
        var most = 0f
        val steps = 64
        for (step in 0..steps) {
            val progress = step / steps.toFloat()
            val height = params.depthDp + profile(progress) * bezelDp
            val slope = slope(progress, params.maxSlope)
            most = max(most, shiftRatio(slope, params.ior + params.dispersion) * height)
            most = max(most, shiftRatio(slope, params.ior) * height)
            most = max(most, shiftRatio(slope, max(params.ior - params.dispersion, 1.0001f)) * height)
        }
        return most
    }

    fun marginPx(blurPx: Float, shiftPx: Float): Float = ceil(max(blurPx * 2f, shiftPx + EDGE_FEATHER_PX))

    fun light(angle: Float): Pair<Float, Float> = sin(angle) to -cos(angle)

    const val MAX_LENSES = 12

    data class StripLens(
        val left: Float,
        val top: Float,
        val right: Float,
        val bottom: Float,
        val radius: Float,
        val bezel: Float,
        val maxShift: Float,
    )

    data class LensField(
        val lenses: List<StripLens>,
        val exponent: Float,
        val depth: Float,
        val ior: Float,
        val dispersion: Float,
        val maxSlope: Float,
        val saturation: Float,
    )

    fun stripLens(xPx: Int, yPx: Int, widthPx: Int, heightPx: Int, scale: Float, radiusPx: Float, density: Float, bezelDp: Float, shiftDp: Float): StripLens {
        val toLayer = density / scale
        return StripLens(
            left = xPx / scale,
            top = yPx / scale,
            right = (xPx + widthPx) / scale,
            bottom = (yPx + heightPx) / scale,
            radius = min(radiusPx, min(widthPx, heightPx) / 2f).coerceAtLeast(0f) / scale,
            bezel = max(bezelDp * toLayer, 1f),
            maxShift = shiftDp * toLayer,
        )
    }

    fun lensField(lenses: List<StripLens>, density: Float, scale: Float, saturation: Float = 1f, params: Params = defaults): LensField? {
        if (lenses.isEmpty()) return null
        return LensField(
            lenses = lenses.take(MAX_LENSES),
            exponent = CIRCULAR_CORNER_EXPONENT,
            depth = params.depthDp * density / scale,
            ior = params.ior,
            dispersion = params.dispersion,
            maxSlope = params.maxSlope,
            saturation = saturation,
        )
    }

    data class Rim(
        val width: Float,
        val height: Float,
        val radius: Float,
        val exponent: Float,
        val lightX: Float,
        val lightY: Float,
        val band: Float,
        val strength: Float,
        val opposite: Float,
        val falloff: Float,
        val sharpness: Float,
        val opacity: Float,
    )

    fun rim(widthPx: Int, heightPx: Int, radiusPx: Float, density: Float, dark: Boolean, params: Params = defaults): Rim {
        val (x, y) = light(params.lightAngle)
        return Rim(
            width = widthPx.toFloat(),
            height = heightPx.toFloat(),
            radius = min(radiusPx, min(widthPx, heightPx) / 2f).coerceAtLeast(0f),
            exponent = CIRCULAR_CORNER_EXPONENT,
            lightX = x,
            lightY = y,
            band = max(params.specularWidthDp * density, 1f),
            strength = params.specularStrength,
            opposite = params.oppositeStrength,
            falloff = params.specularFalloff,
            sharpness = params.specularSharpness,
            opacity = params.specularOpacity * if (dark) DARK_RIM_SHARE else 1f,
        )
    }

    const val DARK_RIM_SHARE = 0.7f

    private const val SHAPE = """
uniform float exponent;

float pnorm(float2 v) {
    float2 a = abs(v);
    if (a.x + a.y <= 0.0) return 0.0;
    return pow(pow(a.x, exponent) + pow(a.y, exponent), 1.0 / exponent);
}

float boxDistance(float2 p, float4 box, float radius) {
    float2 centre = (box.xy + box.zw) * 0.5;
    float2 extent = (box.zw - box.xy) * 0.5;
    float r = clamp(radius, 0.0, min(extent.x, extent.y));
    float2 q = abs(p - centre) - extent + float2(r);
    return pnorm(max(q, float2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

float2 boxNormal(float2 p, float4 box, float radius) {
    float2 centre = (box.xy + box.zw) * 0.5;
    float2 extent = (box.zw - box.xy) * 0.5;
    float r = clamp(radius, 0.0, min(extent.x, extent.y));
    float2 local = p - centre;
    float2 side = float2(local.x < 0.0 ? -1.0 : 1.0, local.y < 0.0 ? -1.0 : 1.0);
    float2 q = abs(local) - extent + float2(r);
    if (q.x > 0.0 && q.y > 0.0) {
        float2 g = float2(pow(q.x, exponent - 1.0), pow(q.y, exponent - 1.0));
        return normalize(g) * side;
    }
    return q.x > q.y ? float2(side.x, 0.0) : float2(0.0, side.y);
}
"""

    val LENS_SHADER = """
uniform shader backdrop;
$SHAPE
uniform float4 boxes[$MAX_LENSES];
uniform float4 shapes[$MAX_LENSES];
uniform float count;
uniform float depth;
uniform float ior;
uniform float dispersion;
uniform float maxSlope;
uniform float saturation;

half4 saturated(half4 colour) {
    if (colour.a <= 0.0) return colour;
    half3 straight = colour.rgb / colour.a;
    half grey = dot(straight, half3(0.213, 0.715, 0.072));
    return half4(clamp(grey + (straight - grey) * half(saturation), 0.0, 1.0) * colour.a, colour.a);
}

float3 bend(float3 normal, float index) {
    return refract(float3(0.0, 0.0, -1.0), normal, 1.0 / max(index, 1.0001));
}

float2 shift(float3 ray, float height, float maxShift) {
    float2 moved = ray.xy / max(-ray.z, 0.0001) * height;
    float travel = length(moved);
    return travel > maxShift ? moved * (maxShift / travel) : moved;
}

half4 main(float2 p) {
    float edge = 1000000.0;
    float4 box = float4(0.0);
    float4 shape = float4(0.0);
    for (int i = 0; i < $MAX_LENSES; i++) {
        if (float(i) < count) {
            float d = boxDistance(p, boxes[i], shapes[i].x);
            if (d < edge) {
                edge = d;
                box = boxes[i];
                shape = shapes[i];
            }
        }
    }
    if (edge > 1.0) return saturated(backdrop.eval(p));
    float bezel = shape.y;
    float maxShift = shape.z;
    float inward = max(-edge, 0.0);
    float progress = clamp(inward / bezel, 0.0, 1.0);
    float u = 1.0 - progress;
    float inside = max(1.0 - u * u * u * u, 0.0001);
    float slope = inward > bezel ? 0.0 : min(2.0 * u * u * u / sqrt(inside), maxSlope);
    if (slope <= 0.0) return saturated(backdrop.eval(p));
    float height = depth + sqrt(inside) * bezel;
    float3 normal = normalize(float3(boxNormal(p, box, shape.x) * slope, 1.0));
    half4 green = backdrop.eval(p + shift(bend(normal, ior), height, maxShift));
    half red = backdrop.eval(p + shift(bend(normal, ior + dispersion), height, maxShift)).r;
    half blue = backdrop.eval(p + shift(bend(normal, max(ior - dispersion, 1.0001)), height, maxShift)).b;
    half coverage = green.a;
    half4 lensed = half4(min(red, coverage), min(green.g, coverage), min(blue, coverage), coverage);
    return saturated(lensed);
}
"""

    val RIM_SHADER = """
$SHAPE
uniform float2 light;
uniform float band;
uniform float strength;
uniform float opposite;
uniform float falloff;
uniform float sharpness;
uniform float opacity;
uniform float4 box;
uniform float radius;

half4 main(float2 p) {
    float edge = boxDistance(p, box, radius);
    float inward = max(-edge, 0.0);
    float outer = 1.0 - smoothstep(0.0, $EDGE_FEATHER_PX, edge);
    float inner = 1.0 - smoothstep(band, band + $EDGE_FEATHER_PX, inward);
    float mask = outer * inner;
    if (mask <= 0.0) return half4(0.0);
    float2 normal = boxNormal(p, box, radius);
    float progress = clamp(inward / max(band, $EDGE_FEATHER_PX), 0.0, 1.0);
    float fade = falloff * progress * progress;
    float lit = clamp(pow(max(dot(normal, light), 0.0), sharpness) * (strength - fade), 0.0, 1.0);
    float back = clamp(pow(max(dot(normal, -light), 0.0), sharpness) * (opposite - fade), 0.0, 1.0);
    float alpha = clamp((lit + back) * mask, 0.0, 1.0) * opacity;
    return half4(alpha, alpha, alpha, alpha);
}
"""
}

internal class LensBound(private val params: LiquidGlassRules.Params = LiquidGlassRules.defaults) {
    var computed = 0
        private set
    var bezelDp = 0f
        private set
    var shiftDp = 0f
        private set
    private var widthPx = -1
    private var heightPx = -1
    private var density = -1f

    fun measure(widthPx: Int, heightPx: Int, density: Float): LensBound {
        if (widthPx == this.widthPx && heightPx == this.heightPx && density == this.density) return this
        this.widthPx = widthPx
        this.heightPx = heightPx
        this.density = density
        bezelDp = LiquidGlassRules.bezelDp(params, widthPx / density, heightPx / density)
        shiftDp = LiquidGlassRules.maxShiftDp(params, bezelDp)
        computed += 1
        return this
    }
}

internal class ShaderSlot(private val name: String) {
    var failures = 0
        private set

    val failed: Boolean get() = failures > 0

    fun <T : Any> attempt(build: () -> T): T? {
        if (failed) return null
        return try {
            build()
        } catch (failure: RuntimeException) {
            failures += 1
            GlassShaders.onFailed?.invoke()
            android.util.Log.w("PAGELAB", "PAGELAB look glass $name shader failed and is skipped from now on: ${failure.javaClass.simpleName}: ${failure.message}")
            null
        }
    }
}

internal object GlassShaders {
    var lens = ShaderSlot("lens")
        private set
    var rim = ShaderSlot("rim")
        private set
    var makeLens: ((LiquidGlassRules.LensField) -> RenderEffect)? = null
    var makeRim: (() -> RuntimeShader)? = null
    var onFailed: (() -> Unit)? = null

    fun lensFor(field: LiquidGlassRules.LensField, cached: () -> RuntimeShader): RenderEffect? = lens.attempt {
        makeLens?.invoke(field) ?: LiquidGlassShaders.lensEffect(LiquidGlassShaders.apply(cached(), field))
    }

    fun retryFailed(): Boolean {
        val anyFailed = lens.failed || rim.failed
        if (lens.failed) lens = ShaderSlot("lens")
        if (rim.failed) rim = ShaderSlot("rim")
        return anyFailed
    }

    fun reset() {
        lens = ShaderSlot("lens")
        rim = ShaderSlot("rim")
        makeLens = null
        makeRim = null
        onFailed = null
    }
}

@RequiresApi(Build.VERSION_CODES.TIRAMISU)
internal object LiquidGlassShaders {
    fun lens(): RuntimeShader = RuntimeShader(LiquidGlassRules.LENS_SHADER)

    fun apply(shader: RuntimeShader, field: LiquidGlassRules.LensField): RuntimeShader = shader.apply {
        val boxes = FloatArray(LiquidGlassRules.MAX_LENSES * 4)
        val shapes = FloatArray(LiquidGlassRules.MAX_LENSES * 4)
        field.lenses.forEachIndexed { index, lens ->
            boxes[index * 4] = lens.left
            boxes[index * 4 + 1] = lens.top
            boxes[index * 4 + 2] = lens.right
            boxes[index * 4 + 3] = lens.bottom
            shapes[index * 4] = lens.radius
            shapes[index * 4 + 1] = lens.bezel
            shapes[index * 4 + 2] = lens.maxShift
        }
        setFloatUniform("boxes", boxes)
        setFloatUniform("shapes", shapes)
        setFloatUniform("count", field.lenses.size.toFloat())
        setFloatUniform("exponent", field.exponent)
        setFloatUniform("depth", field.depth)
        setFloatUniform("ior", field.ior)
        setFloatUniform("dispersion", field.dispersion)
        setFloatUniform("maxSlope", field.maxSlope)
        setFloatUniform("saturation", field.saturation)
    }

    fun lensEffect(shader: RuntimeShader): RenderEffect = RenderEffect.createRuntimeShaderEffect(shader, "backdrop")

    fun rim(): RuntimeShader = RuntimeShader(LiquidGlassRules.RIM_SHADER)

    fun apply(shader: RuntimeShader, rim: LiquidGlassRules.Rim) {
        shader.setFloatUniform("box", 0f, 0f, rim.width, rim.height)
        shader.setFloatUniform("radius", rim.radius)
        shader.setFloatUniform("exponent", rim.exponent)
        shader.setFloatUniform("light", rim.lightX, rim.lightY)
        shader.setFloatUniform("band", rim.band)
        shader.setFloatUniform("strength", rim.strength)
        shader.setFloatUniform("opposite", rim.opposite)
        shader.setFloatUniform("falloff", rim.falloff)
        shader.setFloatUniform("sharpness", rim.sharpness)
        shader.setFloatUniform("opacity", rim.opacity)
    }
}
