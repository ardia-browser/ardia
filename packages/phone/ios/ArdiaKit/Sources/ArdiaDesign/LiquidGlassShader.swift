public enum LiquidGlassShader {
  public static let vertexName = "liquidGlassVertex"
  public static let fragmentName = "liquidGlassFragment"

  public enum Uniform: Int, CaseIterable, Sendable {
    case width, height, scale, radius, exponent
    case bezel, depth, maxShift, ior, dispersion, maxSlope
    case saturation, live, lens, rim
    case uvLeft, uvTop, uvWidth, uvHeight
    case lightX, lightY, band, strength, opposite, falloff, sharpness, rimOpacity
    case edgeWidth
    case fillRed, fillGreen, fillBlue, fillAlpha
    case frostRed, frostGreen, frostBlue, frostAlpha
    case edgeRed, edgeGreen, edgeBlue, edgeAlpha
    case tintRed, tintGreen, tintBlue, tintAlpha
    case rimOnly
    case ceiling, floor
  }

  public struct Frame: Equatable, Sendable {
    public var width: Double
    public var height: Double
    public var scale: Double
    public var radius: Double
    public var live: Bool
    public var lens: Bool
    public var rim: Bool
    public var dark: Bool
    public var uv: (left: Double, top: Double, width: Double, height: Double)
    public var fill: GlassInk
    public var tint: GlassInk
    public var style: GlassFrostStyle
    public var params: LiquidGlassParams
    public var bound: LiquidGlassBound?
    public var rimOnly = false
    public var toneLimit: (ceiling: Double, floor: Double) = (1, 0)

    public init(width: Double, height: Double, scale: Double, radius: Double, live: Bool, lens: Bool, rim: Bool, dark: Bool, uv: (left: Double, top: Double, width: Double, height: Double) = (0, 0, 1, 1), fill: GlassInk, tint: GlassInk = .clear, style: GlassFrostStyle = .glass, params: LiquidGlassParams = .defaults, bound: LiquidGlassBound? = nil) {
      self.width = width
      self.height = height
      self.scale = scale
      self.radius = radius
      self.live = live
      self.lens = lens
      self.rim = rim
      self.dark = dark
      self.uv = uv
      self.fill = fill
      self.tint = tint
      self.style = style
      self.params = params
      self.bound = bound
    }

    public static func == (lhs: Frame, rhs: Frame) -> Bool {
      lhs.uniforms == rhs.uniforms
    }

    public var uniforms: [Float] {
      let bound = self.bound ?? {
        var measured = LiquidGlassBound(params: params)
        measured.measure(width: width, height: height)
        return measured
      }()
      let light = LiquidGlassRules.light(params.lightAngle)
      var values = [Float](repeating: 0, count: Uniform.allCases.count)
      func set(_ uniform: Uniform, _ value: Double) { values[uniform.rawValue] = Float(value) }
      func set(_ first: Uniform, ink: GlassInk) {
        for (offset, channel) in ink.premultiplied.enumerated() { values[first.rawValue + offset] = channel }
      }
      set(.width, width)
      set(.height, height)
      set(.scale, scale)
      set(.radius, LiquidGlassRules.radius(capsule: false, cornerRadius: radius, width: width, height: height))
      set(.exponent, LiquidGlassRules.circularCornerExponent)
      set(.bezel, max(bound.bezel, 1 / scale))
      set(.depth, params.depth)
      set(.maxShift, bound.shift)
      set(.ior, params.ior)
      set(.dispersion, params.dispersion)
      set(.maxSlope, params.maxSlope)
      set(.saturation, style.saturation)
      set(.live, live ? 1 : 0)
      set(.lens, lens ? 1 : 0)
      set(.rim, rim ? 1 : 0)
      set(.uvLeft, uv.left)
      set(.uvTop, uv.top)
      set(.uvWidth, uv.width)
      set(.uvHeight, uv.height)
      set(.lightX, light.x)
      set(.lightY, light.y)
      set(.band, max(params.specularWidth, 1 / scale))
      set(.strength, params.specularStrength)
      set(.opposite, params.oppositeStrength)
      set(.falloff, params.specularFalloff)
      set(.sharpness, params.specularSharpness)
      set(.rimOpacity, LiquidGlassRules.rimOpacity(params, dark: dark))
      set(.edgeWidth, style.edgeWidth)
      set(.fillRed, ink: fill)
      set(.frostRed, ink: style.tint(dark: dark))
      set(.edgeRed, ink: style.edge(dark: dark))
      set(.tintRed, ink: tint)
      set(.rimOnly, rimOnly ? 1 : 0)
      set(.ceiling, dark ? min(LiquidGlassRules.readableCeiling, toneLimit.ceiling) : toneLimit.ceiling)
      set(.floor, dark ? toneLimit.floor : max(LiquidGlassRules.readableFloor, toneLimit.floor))
      return values
    }
  }

  public static let source = """
#include <metal_stdlib>
using namespace metal;

struct GlassUniforms {
  float width; float height; float scale; float radius; float exponent;
  float bezel; float depth; float maxShift; float ior; float dispersion; float maxSlope;
  float saturation; float live; float lens; float rim;
  float uvLeft; float uvTop; float uvWidth; float uvHeight;
  float lightX; float lightY; float band; float strength; float opposite; float falloff; float sharpness; float rimOpacity;
  float edgeWidth;
  float fillRed; float fillGreen; float fillBlue; float fillAlpha;
  float frostRed; float frostGreen; float frostBlue; float frostAlpha;
  float edgeRed; float edgeGreen; float edgeBlue; float edgeAlpha;
  float tintRed; float tintGreen; float tintBlue; float tintAlpha;
  float rimOnly;
  float ceiling; float floor;
};

struct GlassVertexOut {
  float4 position [[position]];
};

vertex GlassVertexOut liquidGlassVertex(uint id [[vertex_id]]) {
  float2 corners[3] = { float2(-1.0, -1.0), float2(3.0, -1.0), float2(-1.0, 3.0) };
  GlassVertexOut out;
  out.position = float4(corners[id], 0.0, 1.0);
  return out;
}

static float pnorm(float2 v, float exponent) {
  float2 a = abs(v);
  if (a.x + a.y <= 0.0) return 0.0;
  return pow(pow(a.x, exponent) + pow(a.y, exponent), 1.0 / exponent);
}

static float shapeDistance(float2 p, constant GlassUniforms &u) {
  float2 extent = float2(u.width, u.height) * 0.5;
  float r = clamp(u.radius, 0.0, min(extent.x, extent.y));
  float2 q = abs(p - extent) - extent + float2(r);
  return pnorm(max(q, float2(0.0)), u.exponent) + min(max(q.x, q.y), 0.0) - r;
}

static float2 shapeNormal(float2 p, constant GlassUniforms &u) {
  float2 extent = float2(u.width, u.height) * 0.5;
  float r = clamp(u.radius, 0.0, min(extent.x, extent.y));
  float2 local = p - extent;
  float2 side = float2(local.x < 0.0 ? -1.0 : 1.0, local.y < 0.0 ? -1.0 : 1.0);
  float2 q = abs(local) - extent + float2(r);
  if (q.x > 0.0 && q.y > 0.0) {
    float2 g = float2(pow(q.x, u.exponent - 1.0), pow(q.y, u.exponent - 1.0));
    return normalize(g) * side;
  }
  return q.x > q.y ? float2(side.x, 0.0) : float2(0.0, side.y);
}

static float3 bend(float3 normal, float index) {
  return refract(float3(0.0, 0.0, -1.0), normal, 1.0 / max(index, 1.0001));
}

static float2 shiftBy(float3 ray, float height, float maxShift) {
  float2 moved = ray.xy / max(-ray.z, 0.0001) * height;
  float travel = length(moved);
  return travel > maxShift ? moved * (maxShift / travel) : moved;
}

static float4 saturated(float4 c, float amount) {
  if (c.a <= 0.0) return c;
  float3 plain = c.rgb / c.a;
  float luma = dot(plain, float3(0.213, 0.715, 0.072));
  float3 shifted = clamp(mix(float3(luma), plain, amount), 0.0, 1.0);
  return float4(shifted * c.a, c.a);
}

static float4 backdrop(texture2d<float> source, sampler smooth, float2 p, constant GlassUniforms &u) {
  float2 uv = float2(u.uvLeft, u.uvTop) + p / float2(u.width, u.height) * float2(u.uvWidth, u.uvHeight);
  return saturated(source.sample(smooth, uv), u.saturation);
}

static float4 over(float4 top, float4 under) {
  return top + under * (1.0 - top.a);
}

static float rimLight(float2 p, float edge, float inward, float feather, constant GlassUniforms &u) {
  float outer = 1.0 - smoothstep(0.0, feather, edge);
  float inner = 1.0 - smoothstep(u.band, u.band + feather, inward);
  float mask = outer * inner;
  if (mask <= 0.0) return 0.0;
  float2 normal = shapeNormal(p, u);
  float2 light = float2(u.lightX, u.lightY);
  float progress = clamp(inward / max(u.band, feather), 0.0, 1.0);
  float fade = u.falloff * progress * progress;
  float lit = clamp(pow(max(dot(normal, light), 0.0), u.sharpness) * (u.strength - fade), 0.0, 1.0);
  float back = clamp(pow(max(dot(normal, -light), 0.0), u.sharpness) * (u.opposite - fade), 0.0, 1.0);
  return clamp((lit + back) * mask, 0.0, 1.0) * u.rimOpacity;
}

static float4 readable(float4 color, float ceiling, float floor) {
  if (color.a <= 0.0) return color;
  float3 lin = pow(clamp(color.rgb / color.a, 0.0, 1.0), float3(2.2));
  float light = dot(lin, float3(0.2126, 0.7152, 0.0722));
  if (light > ceiling) {
    lin *= ceiling / max(light, 0.0001);
  } else if (light < floor) {
    lin += (1.0 - lin) * ((floor - light) / max(1.0 - light, 0.0001));
  }
  return float4(pow(lin, float3(1.0 / 2.2)) * color.a, color.a);
}

fragment float4 liquidGlassFragment(GlassVertexOut in [[stage_in]], constant GlassUniforms &u [[buffer(0)]], texture2d<float> source [[texture(0)]]) {
  constexpr sampler smooth(coord::normalized, address::clamp_to_edge, filter::linear);
  float2 p = in.position.xy / u.scale;
  float feather = 1.0 / u.scale;
  float edge = shapeDistance(p, u);
  float coverage = 1.0 - smoothstep(-0.5 * feather, 0.5 * feather, edge);
  if (coverage <= 0.0) return float4(0.0);
  float inward = max(-edge, 0.0);
  if (u.rimOnly > 0.5) return float4(u.rim > 0.5 ? rimLight(p, edge, inward, feather, u) : 0.0) * coverage;
  float4 color;
  if (u.live > 0.5) {
    float progress = clamp(inward / u.bezel, 0.0, 1.0);
    float rise = 1.0 - progress;
    float inside = max(1.0 - rise * rise * rise * rise, 0.0001);
    float slope = inward > u.bezel ? 0.0 : min(2.0 * rise * rise * rise / sqrt(inside), u.maxSlope);
    if (u.lens > 0.5 && slope > 0.0) {
      float height = u.depth + sqrt(inside) * u.bezel;
      float3 normal = normalize(float3(shapeNormal(p, u) * slope, 1.0));
      float4 green = backdrop(source, smooth, p + shiftBy(bend(normal, u.ior), height, u.maxShift), u);
      float red = backdrop(source, smooth, p + shiftBy(bend(normal, u.ior + u.dispersion), height, u.maxShift), u).r;
      float blue = backdrop(source, smooth, p + shiftBy(bend(normal, max(u.ior - u.dispersion, 1.0001)), height, u.maxShift), u).b;
      float cover = green.a;
      color = float4(min(red, cover), min(green.g, cover), min(blue, cover), cover);
    } else {
      color = backdrop(source, smooth, p, u);
    }
    color = over(float4(u.frostRed, u.frostGreen, u.frostBlue, u.frostAlpha), color);
  } else {
    color = float4(u.fillRed, u.fillGreen, u.fillBlue, u.fillAlpha);
  }
  float edgeMask = 1.0 - smoothstep(u.edgeWidth, u.edgeWidth + feather, inward);
  color = over(float4(u.edgeRed, u.edgeGreen, u.edgeBlue, u.edgeAlpha) * edgeMask, color);
  color = over(float4(u.tintRed, u.tintGreen, u.tintBlue, u.tintAlpha), color);
  if (u.live > 0.5) color = readable(color, u.ceiling, u.floor);
  return color * coverage;
}
"""
}
