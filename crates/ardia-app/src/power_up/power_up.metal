static inline float easeOutExpo(float t) {
    return (t == 1.0f) ? 1.0f : 1.0f - pow(2.0f, -10.0f * t);
}

static inline float easeInOutQuart(float t) {
    return (t < 0.5f) ? 8.0f * t * t * t * t
                      : 1.0f - pow(-2.0f * t + 2.0f, 4.0f) * 0.5f;
}

static inline float shiftCenter(float v, float o) {
    float mid = 1.0f - o;
    return (v <= 0.5f) ? v * 2.0f * mid
                       : mid + o * 2.0f * (v - 0.5f);
}

static inline float3 oklabToLinearSRGB(float3 lab) {
    float3 lms = float3(dot(lab, float3(1.0f,  0.396337777f,   0.215803757f)),
                        dot(lab, float3(1.0f, -0.105561346f,  -0.0638541728f)),
                        dot(lab, float3(1.0f, -0.0894841775f, -1.29148555f)));
    lms = pow(lms, float3(3.0f));
    return float3(dot(lms, float3( 4.0767417f,     -3.3077116f,    0.230969936f)),
                  dot(lms, float3(-1.26843798f,     2.60975742f,  -0.341319382f)),
                  dot(lms, float3(-0.00419608643f, -0.703418612f,  1.70761466f)));
}

static inline float linearToSRGB(float c) {
    float ac = abs(c);
    if (ac <= 0.00313080009f) {
        return c * 12.9200001f;
    }
    return sign(c) * (pow(ac, 0.416666657f) * 1.05499995f - 0.0549999997f);
}

static inline float4 samplePalette(constant float4 *colors, int n1, float v) {
    float f  = float(n1) * v;
    int   i  = int(floor(f));
    float4 a = colors[i];
    float4 b = colors[min(i + 1, n1)];
    return mix(a, b, smoothstep(0.0f, 1.0f, f - float(i)));
}

float mask(float2 uv, float width, float start, float end, float skew, int direction) {
    float left, right, top, bottom;
    if (direction == 0 || direction == 2) {
        float k = (uv.y - 0.5f) * skew;
        left  = smoothstep(0.0f, width, uv.x + k);
        right = 1.0f - smoothstep(1.0f - width, 1.0f, uv.x - k);
        if (direction == 0) {
            top    = smoothstep(0.0f, start, uv.y);
            bottom = 1.0f - smoothstep(1.0f - end, 1.0f, uv.y);
        } else {
            top    = 1.0f - smoothstep(1.0f - end, 1.0f, 1.0f - uv.y);
            bottom = smoothstep(0.0f, start, 1.0f - uv.y);
        }
    } else {
        float k = (uv.x - 0.5f) * skew;
        top    = smoothstep(0.0f, width, uv.y + k);
        bottom = 1.0f - smoothstep(1.0f - width, 1.0f, uv.y - k);
        if (direction == 1) {
            left  = 1.0f - smoothstep(1.0f - end, 1.0f, 1.0f - uv.x);
            right = smoothstep(0.0f, start, 1.0f - uv.x);
        } else {
            left  = smoothstep(0.0f, start, uv.x);
            right = 1.0f - smoothstep(1.0f - end, 1.0f, uv.x);
        }
    }
    return left * right * top * bottom;
}

float4 gradient(float2 uv, constant float4 *colors, int numberOfColors,
                float progress, int direction)
{
    float c = (direction == 0 || direction == 2) ? uv.x : uv.y;
    float p;
    if (c >= 0.200000003f && c < 0.400000006f) {
        p = progress - 0.0250000004f;
    } else if (c >= 0.400000006f && c < 0.600000024f) {
        p = progress - 0.0500000007f;
    } else {
        p = (c >= 0.600000024f && c < 0.800000012f) ? progress - 0.0250000004f : progress;
    }
    p = clamp(p, 0.0f, 1.0f);

    float head = 1.0f - easeInOutQuart(p) * 0.949999988f;

    float crossPos, alongPos;
    switch (direction) {
        case 0:  crossPos = uv.x; alongPos = uv.y;        break;
        case 2:  crossPos = uv.x; alongPos = 1.0f - uv.y; break;
        case 1:  crossPos = uv.y; alongPos = 1.0f - uv.x; break;
        default: crossPos = uv.y; alongPos = uv.x;        break;
    }
    float along = alongPos * 0.400000006f;
    float bend  = (1.0f - pow(abs(crossPos - 0.5f) + 0.5f, 5.0f)) * -0.0500000007f;

    int   n1    = numberOfColors - 1;
    bool  past  = along > head;
    float v     = past ? 1.0f : max(bend + along / head, 0.0f);
    float4 col  = samplePalette(colors, n1, v);
    col.a *= p * 0.5f + 0.5f;

    if (past) {
        float4 trail = samplePalette(colors, n1, max(bend + along, 0.0f));
        trail.a *= p * 0.5f;
        float edge = easeOutExpo(1.0f - p) * 0.0500000007f;
        col = mix(col, trail, clamp((along - head) / edge, 0.0f, 1.0f));
    }

    float3 lin = oklabToLinearSRGB(col.rgb);
    return float4(linearToSRGB(lin.r), linearToSRGB(lin.g), linearToSRGB(lin.b),
                  col.a * 0.100000001f);
}

fragment float4 powerUpFragment(FullscreenOut in                 [[stage_in]],
                                constant int    &direction       [[buffer(0)]],
                                constant int    &numberOfColors  [[buffer(1)]],
                                constant float4 *colors          [[buffer(2)]],
                                constant float  &time            [[buffer(3)]],
                                constant float  &speed           [[buffer(4)]],
                                constant float  &delay           [[buffer(5)]],
                                constant float  &fadeOutStart    [[buffer(6)]],
                                constant float  &fadeOutDuration [[buffer(7)]],
                                constant float  &origin          [[buffer(8)]])
{
    if ((uint)direction >= 4u) {
        return float4(0.0f);
    }

    float o = mix(origin, 0.5f, clamp(time * 1.5f, 0.0f, 1.0f));

    float2 uv;
    switch (direction) {
        case 0:
            uv = float2(shiftCenter(in.uv.x, o),
                        clamp((in.uv.y - 0.200000003f) * 1.25f, 0.0f, 1.0f));
            break;
        case 2:
            uv = float2(shiftCenter(in.uv.x, o),
                        1.0f - clamp((0.800000012f - in.uv.y) * 1.25f, 0.0f, 1.0f));
            break;
        case 1:
            uv = float2(clamp((0.800000012f - in.uv.x) * 1.25f, 0.0f, 1.0f),
                        shiftCenter(in.uv.y, o));
            break;
        default:
            uv = float2(1.0f - clamp((in.uv.x - 0.200000003f) * 1.25f, 0.0f, 1.0f),
                        shiftCenter(in.uv.y, o));
            break;
    }

    float t = time * 0.75f * speed + 0.449999988f - delay;

    float4 col = gradient(uv, colors, numberOfColors, t, direction);
    float  m   = mask(uv, 0.449999988f, 0.200000003f, 0.150000006f, 0.25f, direction);
    col.a = col.a * m * clamp(time * 10.0f, 0.0f, 1.0f);

    if (t > fadeOutStart) {
        col.a *= 1.0f - clamp((t - fadeOutStart) / fadeOutDuration, 0.0f, 1.0f);
    }
    return float4(col.rgb * col.a, col.a);
}
