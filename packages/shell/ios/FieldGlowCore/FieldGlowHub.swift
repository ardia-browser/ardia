import Foundation

public protocol FieldGlowTarget: AnyObject {
  func run(_ moves: [FieldGlowMove], model: FieldGlowModel)
  func settle(at model: FieldGlowModel)
}

private final class WeakTarget {
  weak var target: FieldGlowTarget?
  init(_ target: FieldGlowTarget) { self.target = target }
}

public final class FieldGlowHub {
  private var models: [String: FieldGlowModel] = [:]
  private var targets: [String: WeakTarget] = [:]

  public init() {}

  public func model(_ id: String) -> FieldGlowModel? { models[id] }

  public var liveIds: [String] { models.keys.sorted() }

  public func attach(_ id: String, _ target: FieldGlowTarget) {
    targets[id] = WeakTarget(target)
    target.settle(at: models[id] ?? FieldGlowModel())
  }

  public func detach(_ id: String, _ target: FieldGlowTarget) {
    guard let held = targets[id], held.target == nil || held.target === target else { return }
    targets[id] = nil
    models[id] = nil
  }

  public func show(_ id: String, timings: FieldGlowTimings) {
    var model = models[id] ?? FieldGlowModel(timings: timings)
    model.timings = timings
    let moves = model.show()
    store(id, model, moves)
  }

  public func progress(_ id: String, to: Double, still: Bool) {
    guard var model = models[id] else { return }
    let moves = model.progress(to: to, still: still)
    store(id, model, moves)
  }

  public func finish(_ id: String, still: Bool) {
    guard var model = models[id] else { return }
    let moves = model.finish(still: still)
    store(id, model, moves)
  }

  public func pulse(_ id: String, _ pulse: FieldGlowPulse?) {
    guard var model = models[id], model.setPulse(pulse) else { return }
    models[id] = model
    target(id)?.run([], model: model)
  }

  public func finished(_ id: String, generation: Int) {
    guard var model = models[id], model.finished(generation: generation) else { return }
    models[id] = model
  }

  public func reset(_ id: String) {
    guard var model = models.removeValue(forKey: id) else { return }
    let moves = model.reset()
    target(id)?.run(moves, model: model)
  }

  private func target(_ id: String) -> FieldGlowTarget? {
    guard let held = targets[id] else { return nil }
    if held.target == nil { targets[id] = nil }
    return held.target
  }

  private func store(_ id: String, _ model: FieldGlowModel, _ moves: [FieldGlowMove]) {
    models[id] = model
    if !moves.isEmpty { target(id)?.run(moves, model: model) }
  }
}
