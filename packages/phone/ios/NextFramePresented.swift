import QuartzCore
import UIKit

@MainActor
final class NextFramePresented: NSObject {
  private var link: CADisplayLink?
  private var continuation: CheckedContinuation<Bool, Never>?
  private var finished = false

  static func wait() async -> Bool {
    let waiter = NextFramePresented()
    return await withTaskCancellationHandler {
      await waiter.run()
    } onCancel: {
      Task { @MainActor in waiter.finish(presented: false) }
    }
  }

  private func run() async -> Bool {
    await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
      guard !self.finished, !Task.isCancelled else {
        self.finished = true
        continuation.resume(returning: false)
        return
      }
      self.continuation = continuation
      let link = CADisplayLink(target: self, selector: #selector(self.presented))
      link.add(to: .main, forMode: .common)
      self.link = link
    }
  }

  @objc private func presented() {
    finish(presented: true)
  }

  func finish(presented: Bool) {
    link?.invalidate()
    link = nil
    finished = true
    guard let continuation else { return }
    self.continuation = nil
    continuation.resume(returning: presented)
  }
}
