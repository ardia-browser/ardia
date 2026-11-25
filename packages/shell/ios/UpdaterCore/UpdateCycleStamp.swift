public struct UpdateCycleStamp<Stamp> {
  public private(set) var current: Stamp?

  public init() {}

  public mutating func stamp(_ make: () -> Stamp) -> Stamp {
    if let current { return current }
    let made = make()
    current = made
    return made
  }

  public mutating func end() {
    current = nil
  }
}
