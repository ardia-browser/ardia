import Foundation
import Testing

private let frame = 1.0 / 120

private struct Scenario: CustomTestStringConvertible, Sendable {
  let name: String
  let steps: [[String: JSONValue]]
  var testDescription: String { name }

  static let all: [Scenario] = {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("fixtures/pager-transitions.json")
    guard let data = try? Data(contentsOf: url), let list = try? JSONDecoder().decode([[String: JSONValue]].self, from: data) else { return [] }
    return list.compactMap { entry in
      guard case .string(let name)? = entry["name"], case .array(let steps)? = entry["steps"] else { return nil }
      return Scenario(name: name, steps: steps.compactMap { if case .object(let step) = $0 { step } else { nil } })
    }
  }()
}

private enum JSONValue: Decodable, Equatable, Sendable {
  case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])

  init(from decoder: Decoder) throws {
    let value = try decoder.singleValueContainer()
    if value.decodeNil() { self = .null }
    else if let bool = try? value.decode(Bool.self) { self = .bool(bool) }
    else if let number = try? value.decode(Double.self) { self = .number(number) }
    else if let string = try? value.decode(String.self) { self = .string(string) }
    else if let array = try? value.decode([JSONValue].self) { self = .array(array) }
    else { self = .object(try value.decode([String: JSONValue].self)) }
  }

  var int: Int? { if case .number(let n) = self { Int(n) } else { nil } }
  var double: Double? { if case .number(let n) = self { n } else { nil } }
  var bool: Bool? { if case .bool(let b) = self { b } else { nil } }
  var string: String? { if case .string(let s) = self { s } else { nil } }
  var strings: [String]? { if case .array(let a) = self { a.compactMap(\.string) } else { nil } }
  var object: [String: JSONValue]? { if case .object(let o) = self { o } else { nil } }
}

private final class Harness: PagerModelHost {
  var time = 0.0
  var reduced = false
  var framesWanted = false
  var motions = 0
  var counter = 0
  var states: [PagerModel.StateEvent] = []
  var shown: [(page: Double, lead: Double)] = []
  let model = PagerModel()

  init() { model.host = self }

  var now: TimeInterval { time }
  var reducesMotion: Bool { reduced }
  func nextSequence() -> Int {
    counter += 1
    return counter
  }
  func startFrames() {
    framesWanted = true
    motions += 1
  }
  func stopFrames() { framesWanted = false }
  func pagerMoved(page: Double, lead: Double) { shown.append((page, lead)) }
  func pagerState(_ event: PagerModel.StateEvent) { states.append(event) }
  func pagerEndedTracking() {}
  func pagerShifted(by shift: Int) {}

  func tick(_ gap: Double = frame) {
    time += gap
    if framesWanted { model.frame(at: time) }
  }
}

private func snapshotValue(_ snapshot: PagerModel.Snapshot, _ key: String) -> JSONValue {
  switch key {
  case "selected": .number(Double(snapshot.selected))
  case "position": .number(snapshot.position)
  case "phase": .string(snapshot.phase.rawValue)
  case "leading": .bool(snapshot.leading)
  case "lead": .number(snapshot.lead)
  case "profileId": snapshot.profileId.flatMap { $0 }.map(JSONValue.string) ?? .null
  default: .null
  }
}

private func debugValue(_ model: PagerModel, _ key: String) -> JSONValue {
  switch key {
  case "anchor": model.anchor.map { .number(Double($0)) } ?? .null
  case "home": .number(Double(model.home))
  default: .null
  }
}

private struct Marks {
  var states = 0
  var shown = 0
}

private func run(_ step: [String: JSONValue], on h: Harness, marks: inout Marks) {
  let model = h.model
  if let reduce = step["reduceMotion"]?.bool { return h.reduced = reduce }
  if let config = step["configure"]?.object {
    let ack = config["ackOffset"]?.int.map { model.selectionSequence + $0 } ?? 0
    return model.configure(
      selected: config["selected"]?.int ?? 0, count: config["count"]?.int ?? 1, ack: ack, order: config["order"]?.strings,
      leading: config["leading"]?.bool ?? false, library: config["library"]?.bool ?? false
    )
  }
  if let count = step["frames"]?.int {
    for _ in 0..<count { h.tick(step["gap"]?.double ?? frame) }
    return
  }
  if step["settle"] != nil {
    var ticks = 0
    while h.framesWanted, ticks < 2000 {
      h.tick()
      ticks += 1
    }
    #expect(!h.framesWanted, "the pages never came to rest")
    h.motions = 0
    return
  }
  if let expect = step["expect"]?.object { return check(expect, on: h, marks: &marks) }
  if let x = step["track"]?.double {
    if model.phase != .tracking { model.beginTracking {} }
    return model.track(to: x)
  }
  let returned: Bool
  if let index = step["switchTo"]?.int {
    returned = model.switchTo(index, order: step["order"]?.strings)
  } else if let delta = step["step"]?.int {
    returned = model.step(delta, wrap: step["wrap"]?.bool ?? false, order: step["order"]?.strings)
  } else if let open = step["lead"]?.bool {
    returned = model.lead(open, animated: step["animated"]?.bool ?? true)
  } else if let id = step["select"]?.string {
    returned = model.select(id, order: step["order"]?.strings ?? [])
  } else if step["cancelTracking"] != nil {
    returned = model.cancelTracking()
  } else {
    Issue.record("unknown step \(step)")
    return
  }
  if let wanted = step["returns"]?.bool { #expect(returned == wanted, "\(step)") }
}

private func check(_ expect: [String: JSONValue], on h: Harness, marks: inout Marks) {
  let states = h.states[marks.states...]
  let shown = Array(h.shown[max(0, marks.shown - 1)...])
  let moved = shown.map { $0.page - $0.lead }
  if case .array(let wanted)? = expect["states"] {
    let got: [JSONValue] = states.map {
      .array([.string($0.phase), .number(Double($0.selected)), .bool($0.leading), $0.profileId.flatMap { $0 }.map(JSONValue.string) ?? .null])
    }
    #expect(got == wanted)
  }
  for (key, value) in expect["snapshot"]?.object ?? [:] {
    let got = snapshotValue(h.model.snapshot, key)
    if let a = got.double, let b = value.double { #expect(abs(a - b) < 1e-9, "snapshot.\(key)") } else { #expect(got == value, "snapshot.\(key)") }
  }
  for (key, value) in expect["debug"]?.object ?? [:] { #expect(debugValue(h.model, key) == value, "debug.\(key)") }
  if let moving = expect["moving"]?.bool { #expect(h.framesWanted == moving, "moving") }
  if let motions = expect["motions"]?.int { #expect(h.motions == motions, "motions started") }
  if let smooth = expect["smooth"]?.double {
    for (a, b) in zip(moved, moved.dropFirst()) { #expect(abs(b - a) <= smooth, "jumped from \(a) to \(b)") }
  }
  if let still = expect["pagesStill"]?.double { #expect(shown.dropFirst().allSatisfy { $0.page == still }, "the pages moved") }
  if expect["monotonic"]?.bool == true {
    for (a, b) in zip(moved, moved.dropFirst()) { #expect(b >= a, "went back from \(a) to \(b)") }
  }
  marks.states = h.states.count
  marks.shown = h.shown.count
  h.motions = 0
}

@Suite("Pager transitions shared with the TypeScript pager")
struct PagerTransitionTests {
  @Test("the shared table loads")
  func tableLoads() {
    #expect(Scenario.all.count >= 20)
  }

  @Test(arguments: Scenario.all)
  fileprivate func scenario(_ scenario: Scenario) {
    let h = Harness()
    var marks = Marks()
    for step in scenario.steps { run(step, on: h, marks: &marks) }
  }
}

@Suite("A frame link that goes quiet")
struct FrameWatchTests {
  @Test("frames that keep coming keep the link")
  func steadyFrames() {
    var watch = FrameWatch()
    watch.started(at: 0)
    for tick in 1...30 { watch.framed(at: Double(tick) / 120) }
    guard case .waiting(let seconds) = watch.check(at: 30.0 / 120 + 0.05) else {
      Issue.record("a steady link was treated as quiet")
      return
    }
    #expect(abs(seconds - 0.05) < 1e-9)
  }

  @Test("a quiet link is restarted once, then the motion finishes")
  func quietLink() {
    var watch = FrameWatch()
    watch.started(at: 0)
    #expect(watch.check(at: 0.1) == .restart)
    watch.started(at: 0.1)
    #expect(watch.check(at: 0.2) == .finish)
  }

  @Test("a frame after a restart clears the miss, so one slow moment never ends the motion")
  func recovered() {
    var watch = FrameWatch()
    watch.started(at: 0)
    #expect(watch.check(at: 0.15) == .restart)
    watch.started(at: 0.15)
    watch.framed(at: 0.16)
    #expect(watch.check(at: 0.3) == .restart)
  }

  @Test("a new motion starts with no misses left from the last one")
  func forgotten() {
    var watch = FrameWatch()
    watch.started(at: 0)
    #expect(watch.check(at: 0.2) == .restart)
    watch.forget()
    watch.started(at: 1)
    #expect(watch.check(at: 1.2) == .restart)
  }
}

@main
struct PagerModelTestRunner {
  static func main() async {
    await Testing.__swiftPMEntryPoint() as Never
  }
}
