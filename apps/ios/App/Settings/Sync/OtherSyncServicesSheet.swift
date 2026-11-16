import ArdiaDesign
import SwiftUI

enum OtherSyncService: CaseIterable, Identifiable {
  case nextcloud

  var id: Self { self }

  var title: LocalizedStringKey {
    switch self {
    case .nextcloud: "Nextcloud"
    }
  }

  var subtitle: LocalizedStringKey {
    switch self {
    case .nextcloud: "Your own server"
    }
  }

  var logo: String {
    switch self {
    case .nextcloud: "NextcloudLogo"
    }
  }

  var brandColor: Color {
    switch self {
    case .nextcloud: Color(hex: 0x0082C9)
    }
  }
}

struct OtherSyncServicesSheet: View {
  var onChoose: (OtherSyncService) -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var height: CGFloat = 260

  var body: some View {
    NavigationStack {
      Form {
        Section {
          ForEach(OtherSyncService.allCases) { service in
            Button {
              onChoose(service)
              dismiss()
            } label: {
              HStack(spacing: Spacing.tight) {
                Label {
                  VStack(alignment: .leading, spacing: 2) {
                    Text(service.title)
                    Text(service.subtitle)
                      .font(.footnote)
                      .foregroundStyle(.secondary)
                  }
                } icon: {
                  OtherSyncServiceTile(service: service)
                }
                Spacer()
                Image(systemName: "chevron.right")
                  .font(.footnote.weight(.semibold))
                  .foregroundStyle(.tertiary)
              }
              .contentShape(.rect)
            }
            .foregroundStyle(.primary)
          }
        } footer: {
          Text("For a Mac that syncs through a service the folder picker can’t open.")
        }
      }
      .contentMargins(.top, Spacing.tight, for: .scrollContent)
      .onScrollGeometryChange(for: CGFloat.self) { geometry in
        geometry.contentSize.height + geometry.contentInsets.top + geometry.contentInsets.bottom
      } action: { _, fitted in
        height = fitted
      }
      .navigationTitle("Other Sync Services")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", role: .cancel) { dismiss() }
        }
      }
    }
    .tint(Color.ardiaAccentText)
    .presentationDetents([.height(height)])
    .presentationBackground(Color(.systemGroupedBackground))
  }
}

private struct OtherSyncServiceTile: View {
  var service: OtherSyncService

  @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

  private var side: CGFloat { SettingsTile.side * min(scale, 1.6) }

  var body: some View {
    Image(service.logo)
      .resizable()
      .renderingMode(.template)
      .scaledToFit()
      .foregroundStyle(.white)
      .padding(side * 0.1)
      .frame(width: side, height: side)
      .background(service.brandColor, in: .rect(cornerRadius: side * 0.26, style: .continuous))
      .accessibilityHidden(true)
  }
}

extension View {
  func otherSyncServices(isPresented: Binding<Bool>, onChoose: @escaping (OtherSyncService) -> Void) -> some View {
    modifier(OtherSyncServicesPresenter(isPresented: isPresented, onChoose: onChoose))
  }
}

private struct OtherSyncServicesPresenter: ViewModifier {
  @Binding var isPresented: Bool
  var onChoose: (OtherSyncService) -> Void
  @State private var chosen: OtherSyncService?

  func body(content: Content) -> some View {
    content.sheet(isPresented: $isPresented, onDismiss: openChosen) {
      OtherSyncServicesSheet { chosen = $0 }
    }
  }

  private func openChosen() {
    guard let service = chosen else { return }
    chosen = nil
    onChoose(service)
  }
}

#Preview {
  Color.clear.sheet(isPresented: .constant(true)) {
    OtherSyncServicesSheet { _ in }
  }
}
