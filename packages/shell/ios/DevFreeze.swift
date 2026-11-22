import QuartzCore

#if DEBUG
enum DevFreeze {
  static func blockMain(ms: Double) -> Double {
    let span = max(0, min(ms, 60_000))
    DispatchQueue.main.async {
      let until = CACurrentMediaTime() + span / 1000
      while CACurrentMediaTime() < until {}
    }
    return span
  }
}
#endif
