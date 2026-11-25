import ArdiaBrowser
import Observation
import SwiftUI
import UIKit

@MainActor
final class BrowseForMeHost {
  static let shared = BrowseForMeHost()
  static let writerKey = "ArdiaResearchWriter"

  let chatGPT = ChatGPTAccount()
  var sink: EventSink?
  private(set) var session: ResearchSession?
  private weak var presented: UIViewController?
  private var accountGeneration = 0

  private init() {
    watchAccount(generation: 0)
  }

  var isConnected: Bool { chatGPT.isConnected }

  func open(_ query: String) {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    TalkToMe.shared.close()
    if let current = session {
      session = nil
      current.cancel()
    }
    presented?.dismiss(animated: false)
    let forcesExcerpts = PhoneTestBuild.isOn && UserDefaults.standard.string(forKey: Self.writerKey) == "excerpts"
    let made = ResearchSession(query: trimmed, forcesExcerpts: forcesExcerpts, chatGPT: chatGPT, blocker: PhonePages.shared.engine.blocker)
    made.onSettled = { [weak self] settled in self?.report(settled) }
    session = made
    made.start()
    let controller = UIHostingController(rootView: ResearchView(session: made))
    controller.modalPresentationStyle = .fullScreen
    presented = controller
    PhonePages.present(controller)
  }

  func dismiss() {
    presented?.dismiss(animated: true)
  }

  func openSource(_ url: URL) {
    leave(["name": "openSource", "url": url.absoluteString])
  }

  func searchWeb(_ query: String) {
    leave(["name": "searchWeb", "query": query])
  }

  func openLink(_ url: URL) {
    send(["name": "openLink", "url": url.absoluteString])
  }

  func closed(_ ended: ResearchSession) {
    TalkToMe.shared.close(ended)
    ended.cancel()
    guard session === ended else { return }
    session = nil
    send(["name": "closed"])
  }

  func countTalkToMe(_ count: String) {
    send(["name": "talkToMe", "count": count])
  }

  private func leave(_ event: [String: Any?]) {
    TalkToMe.shared.close()
    session?.cancel()
    send(event)
    dismiss()
  }

  private func report(_ settled: ResearchSession) {
    guard settled === session else { return }
    send(["name": "settled", "outcome": Self.outcome(of: settled), "chatGPTFellBack": settled.chatGPTFellBack])
  }

  static func outcome(of session: ResearchSession) -> String {
    if case .failed = session.phase { return "failed" }
    switch session.writer {
    case .chatGPT: return "chatgpt"
    case .onDevice: return "on_device"
    case .excerpts: return "excerpts"
    case nil: return "failed"
    }
  }

  private func send(_ event: [String: Any?]) {
    sink?(event)
  }

  private func watchAccount(generation: Int) {
    let connected = withObservationTracking {
      chatGPT.isConnected
    } onChange: { [weak self] in
      Task { @MainActor [weak self] in
        guard let self, self.accountGeneration == generation else { return }
        self.accountGeneration += 1
        self.watchAccount(generation: self.accountGeneration)
      }
    }
    if generation > 0 { send(["name": "account", "connected": connected]) }
  }
}
