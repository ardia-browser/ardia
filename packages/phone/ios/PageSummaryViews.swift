import ArdiaBrowser
import ArdiaDesign
import SwiftUI
import UIKit

struct PageSummaryBackdrop: View {
  let model: PageSummaryStageModel
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var turns = false

  private func bloom(_ colors: [Color]) -> some View {
    ZStack {
      ForEach(Array(colors.enumerated()), id: \.offset) { index, color in
        let angle = Double(index) / Double(max(colors.count, 1)) * 2 * .pi
        Ellipse()
          .fill(color)
          .frame(width: 240, height: 200)
          .offset(x: cos(angle) * 96, y: sin(angle) * 78)
      }
    }
    .frame(width: 420, height: 360)
    .blur(radius: 64)
    .padding(80)
    .drawingGroup()
    .scaleEffect(1.7)
  }

  var body: some View {
    let look = model.look
    ZStack(alignment: .top) {
      ProfileBackdrop(look: look.look, themeLook: look.themeLook, themed: true)
      ZStack {
        bloom(look.bloom)
          .rotationEffect(.degrees(turns ? 360 : 0))
          .animation(reduceMotion ? nil : .linear(duration: 5).repeatForever(autoreverses: false), value: turns)
        bloom(look.bloom.reversed())
          .rotationEffect(.degrees(turns ? -360 : 0))
          .animation(reduceMotion ? nil : .linear(duration: 8).repeatForever(autoreverses: false), value: turns)
          .offset(x: -140, y: -180)
          .opacity(0.3)
      }
      .frame(height: 500)
      .frame(maxWidth: .infinity)
      .opacity(model.isCalm ? 0 : (look.dark ? 0.8 : 0.9))
    }
    .environment(\.colorScheme, look.dark ? .dark : .light)
    .ignoresSafeArea()
    .accessibilityHidden(true)
    .onAppear { turns = true }
  }
}

private struct SummaryArrival: ViewModifier {
  @State private var arrived = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  func body(content: Content) -> some View {
    content
      .opacity(arrived ? 1 : 0)
      .blur(radius: arrived || reduceMotion ? 0 : 20)
      .offset(y: arrived || reduceMotion ? 0 : -14)
      .onAppear {
        withAnimation(.spring(response: 0.7, dampingFraction: 1)) { arrived = true }
      }
  }
}

struct PageSummaryText: View {
  let model: PageSummaryStageModel

  static let fallbackSymbol = "sparkle"

  static func symbol(_ name: String?) -> String {
    guard let name, UIImage(systemName: name) != nil else { return fallbackSymbol }
    return name
  }

  private var outline: PageSummaryOutline {
    guard let session = model.session else { return PageSummaryOutline() }
    switch session.phase {
    case .done, .interrupted: return session.outline(finished: true)
    case .writing: return session.outline(finished: false)
    case .reading, .failed: return PageSummaryOutline()
    }
  }

  var body: some View {
    let outline = outline
    VStack(alignment: .leading, spacing: 24) {
      if let session = model.session {
        if case .failed(let message) = session.phase {
          Text(message)
            .font(.body)
            .foregroundStyle(.primary.opacity(0.8))
            .modifier(SummaryArrival())
        } else if model.showsText {
          if let lead = outline.lead {
            Text(lead)
              .font(.body)
              .foregroundStyle(.primary.opacity(0.82))
              .modifier(SummaryArrival())
          }
          ForEach(outline.rows) { row in
            HStack(alignment: .top, spacing: 12) {
              Image(systemName: Self.symbol(row.symbol))
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(model.look.discInk)
                .frame(width: 24, height: 24)
                .background(model.look.look.swatchColor, in: .circle)
                .accessibilityHidden(true)
              VStack(alignment: .leading, spacing: 7) {
                if let label = row.label {
                  Text(label)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.primary.opacity(0.88))
                }
                Text(row.info)
                  .font(.body)
                  .foregroundStyle(.primary.opacity(0.72))
              }
            }
            .padding(.leading, 4)
            .accessibilityElement(children: .combine)
            .modifier(SummaryArrival())
          }
          if let note = session.note, session.phase == .interrupted {
            Label(note, systemImage: "exclamationmark.circle")
              .font(.footnote.weight(.medium))
              .foregroundStyle(.primary.opacity(0.78))
              .modifier(SummaryArrival())
          } else if let note = session.note, session.phase == .done {
            Text(note)
              .font(.footnote)
              .foregroundStyle(.secondary)
              .modifier(SummaryArrival())
          }
        }
      }
    }
    .frame(maxWidth: 560, alignment: .leading)
    .padding(.horizontal, 24)
    .frame(maxWidth: .infinity)
    .fixedSize(horizontal: false, vertical: true)
    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { model.textHeight = $0 }
    .frame(maxHeight: .infinity, alignment: .top)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(Text("Summary"))
    .onChange(of: session(\.phase)) { _, phase in
      switch phase {
      case .done: UIAccessibility.post(notification: .announcement, argument: String(localized: "Summary ready"))
      case .interrupted: UIAccessibility.post(notification: .announcement, argument: String(localized: "Summary incomplete. Apple Intelligence stopped before it finished."))
      default: break
      }
    }
  }
}

private extension PageSummaryText {
  func session<Value>(_ path: KeyPath<PageSummarySession, Value>) -> Value? { model.session?[keyPath: path] }
}

private struct SummaryBarPress: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.opacity(configuration.isPressed ? 0.35 : 1)
  }
}

struct PageSummaryFooter: View {
  let model: PageSummaryStageModel
  let onClose: @MainActor () -> Void
  let onShare: @MainActor () -> Void

  private var control: CGFloat { PageSummaryMotion.barControl }

  private func circle(_ symbol: String, size: CGFloat, label: LocalizedStringKey, enabled: Bool = true, action: @escaping @MainActor () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.system(size: size, weight: .medium))
        .foregroundStyle(.primary)
        .opacity(enabled ? 0.9 : 0.3)
        .frame(width: control, height: control)
        .contentShape(.circle)
    }
    .buttonStyle(SummaryBarPress())
    .disabled(!enabled)
    .glassEffect(.regular, in: .circle)
    .accessibilityLabel(Text(label))
  }

  var body: some View {
    let session = model.session
    let host = session?.host
    GlassEffectContainer(spacing: PageSummaryMotion.barGap) {
      HStack(spacing: PageSummaryMotion.barGap) {
        circle("square.and.arrow.up", size: 18, label: "Share Summary", enabled: session?.isShareable == true, action: onShare)
        Button(action: onClose) {
          HStack(spacing: 6) {
            Image(systemName: "sparkle")
              .font(.system(size: 13, weight: .semibold))
              .foregroundStyle(model.look.look.swatchColor)
            Text(host ?? String(localized: "Summary"))
              .font(.system(size: 15, weight: .medium))
              .foregroundStyle(.primary.opacity(0.9))
              .lineLimit(1)
              .truncationMode(.middle)
          }
          .padding(.horizontal, 16)
          .frame(maxWidth: .infinity)
          .frame(height: control)
          .contentShape(.capsule)
        }
        .buttonStyle(SummaryBarPress())
        .glassEffect(.regular, in: .capsule)
        .accessibilityLabel(host.map { Text("Back to \($0)") } ?? Text("Back to Page"))
        circle("xmark", size: 17, label: "Close Summary", action: onClose)
      }
    }
    .padding(.horizontal, PageSummaryMotion.barSideInset)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
    .padding(.bottom, PageSummaryMotion.barBottomGap)
    .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
  }
}
