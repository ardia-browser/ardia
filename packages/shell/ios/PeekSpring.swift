import Foundation

struct PeekSpring {
  var value: Double
  var velocity = 0.0
  var target: Double
  var response: Double

  init(value: Double, response: Double) {
    self.value = value
    target = value
    self.response = response
  }

  mutating func aim(_ target: Double, response: Double? = nil) {
    self.target = target
    if let response { self.response = response }
  }

  mutating func jump(_ value: Double) {
    self.value = value
    target = value
    velocity = 0
  }

  mutating func step(_ dt: Double) {
    guard dt > 0, response > 0 else { return }
    let w = 2 * Double.pi / response
    let d0 = value - target
    let v0 = velocity
    let decay = exp(-w * dt)
    let d = (d0 + (v0 + w * d0) * dt) * decay
    velocity = (v0 - w * (v0 + w * d0) * dt) * decay
    value = target + d
  }

  func settled(within tolerance: Double) -> Bool {
    abs(value - target) <= tolerance && abs(velocity) <= tolerance * 20
  }

  static func remaining(_ t: Double, response: Double) -> Double {
    guard t > 0 else { return 1 }
    let w = 2 * Double.pi / response
    return (1 + w * t) * exp(-w * t)
  }
}
