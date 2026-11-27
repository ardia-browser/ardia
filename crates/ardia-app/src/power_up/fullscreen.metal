#include <metal_stdlib>
using namespace metal;

struct FullscreenOut {
  float4 position [[position]];
  float2 uv;
};

vertex FullscreenOut fullscreenVertex(uint vid [[vertex_id]]) {
  const float2 positions[4] = { float2(-1, -1), float2(1, -1), float2(-1, 1), float2(1, 1) };
  const float2 uvs[4] = { float2(0, 1), float2(1, 1), float2(0, 0), float2(1, 0) };
  FullscreenOut out;
  out.position = float4(positions[vid], 0, 1);
  out.uv = uvs[vid];
  return out;
}

