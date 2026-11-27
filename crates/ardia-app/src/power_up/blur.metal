
fragment float4 blurFragment(FullscreenOut in            [[stage_in]],
                             texture2d<float> source     [[texture(0)]],
                             constant float2 &step       [[buffer(0)]],
                             constant float  &sigma      [[buffer(1)]])
{
    constexpr sampler linear(address::clamp_to_zero, filter::linear);
    int radius = int(ceil(sigma * 3.0f));
    float4 sum = float4(0.0f);
    float weights = 0.0f;
    for (int i = -radius; i <= radius; i++) {
        float w = exp(-0.5f * float(i * i) / (sigma * sigma));
        sum += source.sample(linear, in.uv + step * float(i)) * w;
        weights += w;
    }
    return sum / max(weights, 1e-6f);
}
