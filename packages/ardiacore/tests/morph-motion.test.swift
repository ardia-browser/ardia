import Foundation
import Testing

@Suite struct MorphFrameCounterTests {
  @Test func `frames at the display's own interval are on time at 120 Hz`() {
    var counter = MorphFrameCounter()
    let interval = 1.0 / 120
    let kinds = (0..<5).map { counter.drawn(MorphFrame(target: 10 + Double($0) * interval, interval: interval)) }
    #expect(kinds == [.first, .onTime, .onTime, .onTime, .onTime])
  }

  @Test func `one dropped frame at 120 Hz counts as late`() {
    var counter = MorphFrameCounter()
    let interval = 1.0 / 120
    _ = counter.drawn(MorphFrame(target: 10, interval: interval))
    #expect(counter.drawn(MorphFrame(target: 10 + 2 * interval, interval: interval)) == .late)
  }

  @Test func `a gap after a skipped frame starts over instead of counting late`() {
    var counter = MorphFrameCounter()
    let interval = 1.0 / 60
    _ = counter.drawn(MorphFrame(target: 10, interval: interval))
    counter.skipped()
    #expect(counter.drawn(MorphFrame(target: 10 + 5 * interval, interval: interval)) == .first)
    #expect(counter.drawn(MorphFrame(target: 10 + 6 * interval, interval: interval)) == .onTime)
  }

  @Test func `the same frame delivered twice is not counted again`() {
    var counter = MorphFrameCounter()
    _ = counter.drawn(MorphFrame(target: 10, interval: 1.0 / 60))
    #expect(counter.drawn(MorphFrame(target: 10, interval: 1.0 / 60)) == .first)
  }
}

@Suite struct RoomSpringTests {
  @Test func `the room spring starts where it was and settles on its target`() {
    let spring = RoomSpring(from: 300, target: 420, velocity: 0, start: 5)
    #expect(spring.width(at: 5) == 300)
    #expect(!spring.settled(at: 5.05))
    #expect(spring.settled(at: 6))
    #expect(abs(spring.width(at: 6) - 420) < RoomSpring.rest)
  }

  @Test func `the spring is a function of time, so a late frame lands where an on-time one would`() {
    let spring = RoomSpring(from: 300, target: 420, velocity: 0, start: 0)
    var stepped = 0.0
    for frame in stride(from: 0.0, through: 0.1, by: 1.0 / 120) { stepped = spring.width(at: frame) }
    #expect(abs(stepped - spring.width(at: 0.1)) < 1e-9)
  }

  @Test(arguments: [60.0, 120.0])
  func `the spring never overshoots its target`(rate: Double) {
    let spring = RoomSpring(from: 300, target: 420, velocity: 0, start: 0)
    let widths = stride(from: 0.0, through: 1, by: 1 / rate).map { spring.width(at: $0) }
    #expect(widths.allSatisfy { $0 <= 420 + 1e-9 })
  }
}

@main
struct MorphMotionTestRunner {
  static func main() async {
    await Testing.__swiftPMEntryPoint() as Never
  }
}
