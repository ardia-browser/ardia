import ArdiaBrowser
import ArdiaDesign
import SwiftUI
import UIKit

struct ResearchView: View {
  let session: ResearchSession

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var copiedAnswer = 0
  @State private var showsCopied = false
  private var host: BrowseForMeHost { .shared }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: Spacing.large) {
          Text(session.query)
            .font(.title.weight(.bold))
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
          if !session.isFinished {
            status
          }
          if !chips.isEmpty {
            sourcesStrip
          }
          content
        }
        .padding(.horizontal, Spacing.medium)
        .padding(.top, Spacing.tight)
        .padding(.bottom, Spacing.section)
        .frame(maxWidth: 680, alignment: .leading)
        .frame(maxWidth: .infinity)
      }
      .scrollBounceBehavior(.basedOnSize)
      .animation(reduceMotion ? nil : Motion.smooth, value: session.phase)
      .background(Color(.systemBackground))
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { moreMenu }
        ToolbarItem(placement: .confirmationAction) {
          Button("Done", role: .close) { host.dismiss() }
        }
      }
    }
    .overlay(alignment: .bottom) { copiedToast }
    .task(id: copiedAnswer) {
      guard copiedAnswer > 0 else { return }
      withAnimation(reduceMotion ? nil : Motion.smooth) { showsCopied = true }
      try? await Task.sleep(for: .seconds(1.5))
      withAnimation(reduceMotion ? nil : Motion.smooth) { showsCopied = false }
    }
    .onDisappear { host.closed(session) }
  }

  private var moreMenu: some View {
    Menu {
      Button("Search the Web", systemImage: "magnifyingglass") { host.searchWeb(session.query) }
      if session.phase == .done {
        Button("Copy Answer", systemImage: "doc.on.doc") {
          UIPasteboard.general.string = ResearchAnswer.spoken(session.answer)
          copiedAnswer += 1
        }
      }
      if session.isFinished {
        Button("Browse Again", systemImage: "arrow.clockwise") { session.retry() }
      }
    } label: {
      Label("More", systemImage: "ellipsis")
    }
  }

  @ViewBuilder
  private var status: some View {
    HStack(spacing: Spacing.small) {
      ProgressView()
      Text(statusText)
        .font(.subheadline.weight(.medium))
        .foregroundStyle(.secondary)
        .contentTransition(.numericText())
    }
    .accessibilityElement(children: .combine)
  }

  private var statusText: String {
    switch session.phase {
    case .searching: String(localized: "Searching the web")
    case .reading(let done, let total): String(localized: "Reading \(min(done + 1, total)) of \(total) pages")
    case .writing: String(localized: "Writing your answer")
    case .done, .failed: ""
    }
  }

  private struct Chip: Identifiable {
    var id: String
    var number: Int?
    var url: URL
    var site: String
    var title: String
  }

  private var chips: [Chip] {
    if !session.sources.isEmpty {
      return session.sources.map { Chip(id: $0.url.absoluteString, number: $0.id, url: $0.url, site: $0.siteName, title: $0.title) }
    }
    return session.links.prefix(ResearchSearch.resultLimit).map { link in
      Chip(id: link.url.absoluteString, number: nil, url: link.url, site: link.url.host()?.replacingOccurrences(of: "www.", with: "") ?? "", title: link.title)
    }
  }

  private var sourcesStrip: some View {
    ScrollView(.horizontal) {
      HStack(spacing: Spacing.tight) {
        ForEach(chips) { chip in
          Button {
            host.openSource(chip.url)
          } label: {
            chipLabel(chip)
          }
          .buttonStyle(.plain)
          .accessibilityLabel(Text("\(chip.site), \(chip.title)"))
        }
      }
      .scrollTargetLayout()
    }
    .scrollIndicators(.hidden)
    .scrollClipDisabled()
    .opacity(session.sources.isEmpty ? 0.6 : 1)
  }

  private func chipLabel(_ chip: Chip) -> some View {
    VStack(alignment: .leading, spacing: Spacing.hairline) {
      HStack(spacing: 6) {
        FaviconImage(iconURL: nil, pageURL: chip.url.absoluteString, size: 16)
        Text(chip.site)
          .font(.caption.weight(.semibold))
          .lineLimit(1)
        Spacer(minLength: 0)
        if let number = chip.number {
          Text("\(number)")
            .font(.caption2.weight(.bold).monospacedDigit())
            .foregroundStyle(.secondary)
        }
      }
      Text(chip.title)
        .font(.footnote)
        .foregroundStyle(.secondary)
        .lineLimit(2, reservesSpace: true)
        .multilineTextAlignment(.leading)
    }
    .padding(Spacing.small)
    .frame(width: 176, alignment: .leading)
    .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 14, style: .continuous))
  }

  @ViewBuilder
  private var content: some View {
    switch session.phase {
    case .failed(let message):
      VStack(alignment: .leading, spacing: Spacing.small) {
        Text(message)
          .font(.body)
          .foregroundStyle(.secondary)
        HStack(spacing: Spacing.tight) {
          Button("Try Again") { session.retry() }
            .buttonStyle(.glassProminent)
          Button("Search the Web") { host.searchWeb(session.query) }
            .buttonStyle(.glass)
        }
      }
    default:
      VStack(alignment: .leading, spacing: Spacing.small) {
        ForEach(Array(ResearchAnswer.blocks(session.answer).enumerated()), id: \.offset) { _, block in
          blockView(block)
        }
        if session.phase == .done, let writer = session.writer {
          writerNote(writer)
        }
      }
      .textSelection(.enabled)
    }
  }

  @ViewBuilder
  private func blockView(_ block: ResearchAnswer.Block) -> some View {
    switch block {
    case .heading(let text):
      Text(cited(text))
        .font(.title3.weight(.semibold))
        .padding(.top, Spacing.tight)
        .accessibilityAddTraits(.isHeader)
    case .bullet(let text):
      HStack(alignment: .firstTextBaseline, spacing: Spacing.tight) {
        Text(verbatim: "•")
          .foregroundStyle(.secondary)
        Text(cited(text))
          .fixedSize(horizontal: false, vertical: true)
      }
      .font(.body)
    case .paragraph(let text):
      Text(cited(text))
        .font(.body)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private func cited(_ text: String) -> AttributedString {
    var result = AttributedString()
    var cursor = text.startIndex
    for run in ResearchAnswer.citationRuns(in: text) {
      result += AttributedString(String(text[cursor..<run.range.lowerBound]))
      var numbers = AttributedString("\u{2009}" + run.numbers.map(String.init).joined(separator: ","))
      numbers.font = .caption.weight(.semibold).monospacedDigit()
      numbers.foregroundColor = .secondary
      numbers.baselineOffset = 4
      result += numbers
      cursor = run.range.upperBound
    }
    result += AttributedString(String(text[cursor...]))
    return result
  }

  @ViewBuilder
  private func writerNote(_ writer: ResearchSession.Writer) -> some View {
    let note: String = switch writer {
    case .chatGPT(let model): String(localized: "Written by ChatGPT (\(model)) on your plan from the pages above. Check them for anything important.")
    case .onDevice(nil): String(localized: "Written on this iPhone by Apple Intelligence from the pages above. Check them for anything important.")
    case .onDevice(let fallback?): String(localized: "\(fallback) Apple Intelligence wrote this on your iPhone instead.")
    case .excerpts(let reason): reason
    }
    let symbol = switch writer {
    case .chatGPT: "sparkles"
    case .onDevice: "apple.intelligence"
    case .excerpts: "text.quote"
    }
    VStack(alignment: .leading, spacing: Spacing.medium) {
      Label(note, systemImage: symbol)
        .font(.footnote)
        .foregroundStyle(.secondary)
      if !host.chatGPT.isConnected, !session.forcesExcerpts {
        VStack(alignment: .leading, spacing: Spacing.tight) {
          ContinueWithChatGPTButton { session.rewrite() }
          Text(host.chatGPT.problem ?? String(localized: "Better answers from your ChatGPT Plus or Pro plan. Nothing goes through a server of ours."))
            .font(.footnote)
            .foregroundStyle(host.chatGPT.problem == nil ? Color.secondary : Color.red)
        }
      }
    }
    .padding(.top, Spacing.small)
  }

  @ViewBuilder
  private var copiedToast: some View {
    if showsCopied {
      Label("Copied Answer", systemImage: "doc.on.doc")
        .font(.subheadline.weight(.semibold))
        .padding(.horizontal, Spacing.medium)
        .padding(.vertical, Spacing.small)
        .glassEffect(.regular, in: .capsule)
        .padding(.bottom, Spacing.section * 3)
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .accessibilityAddTraits(.updatesFrequently)
    }
  }
}
