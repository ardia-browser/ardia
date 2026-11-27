static inline float3 haloHash33(float3 p) {
    float3 p3 = fract(p * float3(0.1031f, 0.11369f, 0.13787f));
    p3 += dot(p3, p3.yxz + 19.19f);
    return -1.0f + 2.0f * fract((p3.xxy + p3.yzz) * p3.zyx);
}

static float haloNoise(float3 p) {
    const float F3 = 0.333333343f, G3 = 0.166666672f;
    float3 s = floor(p + (p.x + p.y + p.z) * F3);
    float3 x = p - s + (s.x + s.y + s.z) * G3;
    float3 e = select(float3(0.0f), float3(1.0f), x - x.yzx >= 0.0f);
    float3 i1 = e * (1.0f - e.zxy);
    float3 i2 = 1.0f - e.zxy * (1.0f - e);
    float3 x1 = x - i1 + G3;
    float3 x2 = x - i2 + 2.0f * G3;
    float3 x3 = x - 0.5f;
    float4 w = max(0.6f - float4(dot(x, x), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0f);
    w = pow(w, float4(4.0f));
    float4 d = float4(dot(x, haloHash33(s)), dot(x1, haloHash33(s + i1)),
                      dot(x2, haloHash33(s + i2)), dot(x3, haloHash33(s + 1.0f)));
    return dot(float4(31.316f), d * w);
}

fragment float4 haloFragment(FullscreenOut in                 [[stage_in]],
                             constant float2 &resolution      [[buffer(0)]],
                             constant int    &direction       [[buffer(1)]],
                             constant float4 *colors          [[buffer(2)]],
                             constant bool   &isDark          [[buffer(3)]],
                             constant float  &time            [[buffer(4)]],
                             constant float  &speed           [[buffer(5)]],
                             constant float  &delay           [[buffer(6)]],
                             constant float  &fadeOutStart    [[buffer(7)]],
                             constant float  &fadeOutDuration [[buffer(8)]],
                             constant float  &inset           [[buffer(9)]],
                             constant float  &cornerRadius    [[buffer(10)]])
{
    float aspect = resolution.x / resolution.y;
    float2 p = (in.uv - 0.5f) * 2.0f;
    p.x *= aspect;
    float inset2 = inset * 2.0f;
    float hx = 1.0f - inset2 / resolution.x;
    float hy = 1.0f - inset2 / resolution.y;
    float2 halfSize = aspect > 1.0f ? float2(hx * aspect, hy) : float2(hx, hy / aspect);
    float r = cornerRadius / min(resolution.x - inset2, resolution.y - inset2);
    float dist = abs(length(max(abs(p) - halfSize + r, 0.0f)) - r);

    float t = speed * 0.8f * time - delay;
    float sweep = (t == 1.0f) ? 1.25f : (1.0f - pow(2.0f, -10.0f * t)) * 1.25f;
    float2 n = p / halfSize;
    float angle = atan2(n.y, n.x);
    if (angle < 0.0f) angle += 6.28318548f;
    float offset = direction == 1 ? 1.57079637f : direction == 2 ? 3.14159274f : direction == 3 ? 4.71238899f : 0.0f;
    float around = fmod(1.25f - fmod(offset + angle, 6.28318548f) * 0.159154937f, 1.0f);
    if (around > 0.5f) around = 1.0f - around;
    around *= 2.0f;
    float arc = smoothstep(0.0f, 1.0f, clamp((abs(around - sweep) - 0.22f) * -4.54545450f, 0.0f, 1.0f));

    float line = smoothstep(0.0f, 1.0f, clamp((dist - 0.025f) * -40.0f, 0.0f, 1.0f)) * arc * (isDark ? 0.4f : 1.0f);

    float nz = haloNoise(float3(p * 0.5f, time)) + 0.5f;
    float glowWidth = mix(0.1f, 0.2f, nz);
    float shrink = (1.0f - t) * 0.95f;
    float g1 = shrink == 0.0f ? 0.0f : clamp((dist - shrink) / -shrink, 0.0f, 1.0f);
    float g2 = clamp((dist - glowWidth) / -glowWidth, 0.0f, 1.0f);
    float g = g1 * g2;
    float glow = g * g * (isDark ? 0.1f : 0.12f) * arc * (3.0f - 2.0f * g1) * (3.0f - 2.0f * g2);

    float alpha = mix(colors[0].a, colors[1].a, nz) * clamp(glow + line, 0.0f, 1.0f);
    if (t > fadeOutStart) {
        alpha *= 1.0f - clamp((t - fadeOutStart) / fadeOutDuration, 0.0f, 1.0f);
    }
    float3 rgb = clamp(mix(colors[0].rgb, colors[1].rgb, nz) + line, 0.0f, 1.0f);
    return float4(rgb * alpha, alpha);
}
