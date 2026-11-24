enum HoldReleaseKey {
  struct Candidate: Equatable {
    let visible: Bool
    let miniaturized: Bool
    let canBecomeKey: Bool
    let normalLevel: Bool
    let browser: Bool
    let onActiveSpace: Bool
  }

  static func pick(hasKey: Bool, frontToBack candidates: [Candidate]) -> Int? {
    guard !hasKey else { return nil }
    return candidates.firstIndex { $0.visible && !$0.miniaturized && $0.canBecomeKey && $0.normalLevel && $0.browser && $0.onActiveSpace }
  }
}
