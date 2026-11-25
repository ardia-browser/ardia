import CoreVideo
import Metal
import MetalPerformanceShaders
import QuartzCore

struct GlassBlurJob {
  let kernel: MPSImageGaussianBlur
  let source: MTLTexture
  let target: MTLTexture
  let holder: CVMetalTexture
}

struct GlassDrawJob {
  let layer: CAMetalLayer
  let uniforms: [Float]
  let texture: MTLTexture
  let done: @MainActor (Bool) -> Void
}

final class GlassRenderer: @unchecked Sendable {
  static let shared = GlassRenderer()

  private let queue = DispatchQueue(label: "ardia.glass.render", qos: .userInteractive)

  func run(blurs: [GlassBlurJob], draws: [GlassDrawJob], pipeline: MTLRenderPipelineState, commands: MTLCommandQueue, finished: @escaping @MainActor () -> Void) {
    queue.async {
      guard let buffer = commands.makeCommandBuffer() else {
        DispatchQueue.main.async {
          MainActor.assumeIsolated {
            for job in draws { job.done(false) }
            finished()
          }
        }
        return
      }
      for blur in blurs { blur.kernel.encode(commandBuffer: buffer, sourceTexture: blur.source, destinationTexture: blur.target) }
      var outcomes: [Bool] = []
      for job in draws {
        guard let drawable = job.layer.nextDrawable() else {
          outcomes.append(false)
          continue
        }
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = drawable.texture
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        pass.colorAttachments[0].storeAction = .store
        guard let encoder = buffer.makeRenderCommandEncoder(descriptor: pass) else {
          outcomes.append(false)
          continue
        }
        encoder.setRenderPipelineState(pipeline)
        job.uniforms.withUnsafeBytes { encoder.setFragmentBytes($0.baseAddress!, length: $0.count, index: 0) }
        encoder.setFragmentTexture(job.texture, index: 0)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        encoder.endEncoding()
        buffer.present(drawable)
        outcomes.append(true)
      }
      let held = blurs.map(\.holder)
      buffer.addCompletedHandler { _ in
        _ = held
        DispatchQueue.main.async {
          MainActor.assumeIsolated {
            for (job, drew) in zip(draws, outcomes) { job.done(drew) }
            finished()
          }
        }
      }
      buffer.commit()
    }
  }
}
