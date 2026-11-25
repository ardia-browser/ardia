import Foundation

final class PluginLifecycle {
  enum Kind {
    case start, stop, stopRun, remove
  }

  private struct Operation {
    let kind: Kind
    let work: (@escaping () -> Void) -> Void
    let cancelled: () -> Void
  }

  private var waiting: [String: [Operation]] = [:]
  private var busy: Set<String> = []

  func enqueue(_ name: String, _ kind: Kind, cancelled: @escaping () -> Void = {}, work: @escaping (@escaping () -> Void) -> Void) {
    if kind == .stop || kind == .remove {
      let queued = waiting[name] ?? []
      queued.filter { $0.kind == .start }.forEach { $0.cancelled() }
      waiting[name] = queued.filter { $0.kind != .start }
    }
    waiting[name, default: []].append(Operation(kind: kind, work: work, cancelled: cancelled))
    next(name)
  }

  private func next(_ name: String) {
    guard !busy.contains(name), var queued = waiting[name], !queued.isEmpty else { return }
    let operation = queued.removeFirst()
    waiting[name] = queued.isEmpty ? nil : queued
    busy.insert(name)
    operation.work { [weak self] in
      self?.busy.remove(name)
      self?.next(name)
    }
  }
}
