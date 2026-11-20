import Foundation

struct PageBinding: Hashable {
  let plugin: String
  let approved: String
  let run: Int
  let view: String
}

final class PluginPageOutbox {
  static let maxPending = 64
  static let maxBytes = 1 << 20
  static let maxInFlight = 4

  enum Posted: Equatable {
    case queued([PageBinding])
    case overloaded
  }

  private final class Box {
    var pending: [String] = []
    var bytes = 0
    var inFlight = 0
  }

  private var boxes: [PageBinding: Box] = [:]

  func bind(_ binding: PageBinding) {
    if boxes[binding] == nil { boxes[binding] = Box() }
  }

  func revoke(_ binding: PageBinding) {
    boxes.removeValue(forKey: binding)
  }

  func isBound(_ binding: PageBinding) -> Bool { boxes[binding] != nil }

  func post(plugin: String, approved: String, run: Int, view: String?, json: String) -> Posted {
    let targets = boxes.keys.filter { $0.plugin == plugin && $0.approved == approved && $0.run == run && (view == nil || $0.view == view) }.sorted { $0.view < $1.view }
    let size = json.utf8.count
    if targets.contains(where: { boxes[$0]!.pending.count >= Self.maxPending || boxes[$0]!.bytes + size > Self.maxBytes }) { return .overloaded }
    for target in targets {
      boxes[target]!.pending.append(json)
      boxes[target]!.bytes += size
    }
    return .queued(targets)
  }

  func take(_ binding: PageBinding) -> String? {
    guard let box = boxes[binding], box.inFlight < Self.maxInFlight, !box.pending.isEmpty else { return nil }
    let json = box.pending.removeFirst()
    box.bytes -= json.utf8.count
    box.inFlight += 1
    return json
  }

  func delivered(_ binding: PageBinding) {
    if let box = boxes[binding], box.inFlight > 0 { box.inFlight -= 1 }
  }
}
