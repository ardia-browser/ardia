import Foundation

public enum BoundedFlush {
  public static let defaultTimeout: TimeInterval = 2

  public static func run(
    on queue: DispatchQueue,
    timeout: TimeInterval = defaultTimeout,
    work: @escaping (_ remaining: () -> Bool) -> Void
  ) -> Bool {
    let deadline = DispatchTime.now() + max(0, timeout)
    let done = DispatchSemaphore(value: 0)
    queue.async {
      work { DispatchTime.now() < deadline }
      done.signal()
    }
    return done.wait(timeout: deadline) == .success
  }
}
