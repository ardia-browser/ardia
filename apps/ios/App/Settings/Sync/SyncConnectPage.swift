import ArdiaDesign
import ArdiaSync
import SwiftUI

struct SyncConnectPage: View {
  var onConnected: (() -> Void)?

  @Environment(AppModel.self) private var app
  @Environment(\.dismiss) private var dismiss
  @State private var flow = SyncConnectFlow()
  @State private var isScanning = false
  @State private var isEnteringWords = false
  @State private var isChoosingFolder = false
  @State private var isChoosingService = false
  @State private var isUsingNextcloud = false
  @State private var scans = 0
  @State private var connections = 0
  @State private var connectFailures = 0

  private var isConnecting: Bool { flow.isConnecting }
  private var failure: String? { flow.failure }
  private var pickedFolder: URL? { flow.folder }
  private var pickedNextcloud: NextcloudAccount? { flow.nextcloud }

  private var phrase: Binding<String> {
    Binding(get: { flow.phrase }, set: { start(flow.enterPhrase($0)) })
  }

  var body: some View {
    let hasPhrase = flow.hasPhrase
    Form {
      SettingsHero("Connect to Your Mac", subtitle: Text("Two steps, and your Mac’s tabs are here."), systemImage: "macbook.and.iphone", tint: SettingsTint.sync)

      Section {
        SetupStepRow(
          1,
          title: Text("Show the code on your Mac"),
          detail: Text("On your Mac: Settings › Sync › Connect Another Device."),
          progress: .step(done: hasPhrase, after: true)
        ) {
          if hasPhrase {
            HStack(spacing: Spacing.tight) {
              Label("Recovery phrase added", systemImage: "checkmark.circle.fill")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.ink(.green))
              Spacer()
              Button("Change") { isEnteringWords = true }
                .font(.subheadline)
            }
          } else {
            ViewThatFits(in: .horizontal) {
              HStack(spacing: Spacing.tight) { phraseButtons }
              VStack(alignment: .leading, spacing: Spacing.tight) { phraseButtons }
            }
          }
        }

        SetupStepRow(
          2,
          title: Text("Choose where your Mac syncs"),
          detail: Text("The Ardia Sync folder in iCloud Drive, or another sync service."),
          progress: .step(done: false, after: hasPhrase)
        ) {
          VStack(alignment: .leading, spacing: Spacing.tight) {
            if let pickedFolder, !isConnecting {
              Label {
                Text(verbatim: pickedFolder.lastPathComponent)
              } icon: {
                Image(systemName: "folder.fill")
              }
              .font(.subheadline.weight(.medium))
              .foregroundStyle(.secondary)
            }
            if let pickedNextcloud, !isConnecting {
              Label {
                Text("Nextcloud · \(pickedNextcloud.host)")
              } icon: {
                Image(systemName: "cloud.fill")
              }
              .font(.subheadline.weight(.medium))
              .foregroundStyle(.secondary)
            }
            if isConnecting {
              HStack(spacing: Spacing.tight) {
                ProgressView()
                Text("Connecting…").foregroundStyle(.secondary)
              }
              .font(.subheadline)
            } else {
              ViewThatFits(in: .horizontal) {
                HStack(spacing: Spacing.tight) { locationButtons }
                VStack(alignment: .leading, spacing: Spacing.tight) { locationButtons }
              }
            }
            if let failure {
              Text(failure)
                .font(.subheadline)
                .foregroundStyle(.ink(.red))
                .fixedSize(horizontal: false, vertical: true)
                .transition(.opacity)
            }
          }
        }
      } header: {
        Text("Two Steps")
      } footer: {
        Text("Your recovery phrase stays in this iPhone’s Keychain.")
      }
    }
    .settingsPage("Connect to Your Mac")
    .animation(Motion.snappy, value: hasPhrase)
    .animation(Motion.snappy, value: isConnecting)
    .animation(Motion.snappy, value: failure)
    .fullScreenCover(isPresented: $isScanning) {
      SyncCodeScannerSheet(
        isValid: { app.sync.check(phrase: $0).isValid },
        onScan: { code in
          if pickedFolder == nil { scans += 1 }
          start(flow.enterPhrase(code))
        },
        onEnterWords: { isEnteringWords = true }
      )
    }
    .navigationDestination(isPresented: $isEnteringWords) {
      RecoveryPhraseEntryPage(phrase: phrase)
    }
    .folderPicker(isPresented: $isChoosingFolder) { folder in
      start(flow.chooseFolder(folder))
      releaseReplacedAccounts()
    }
    .otherSyncServices(isPresented: $isChoosingService) { service in
      switch service {
      case .nextcloud: isUsingNextcloud = true
      }
    }
    .navigationDestination(isPresented: $isUsingNextcloud) {
      NextcloudConnectPage { account, path in
        start(flow.choose(.nextcloud(account, path: path)))
        releaseReplacedAccounts()
      }
    }
    .onDisappear {
      guard !isChoosingService, !isUsingNextcloud, !isEnteringWords, !isScanning, !isChoosingFolder else { return }
      for account in flow.abandon() { app.sync.release(account) }
    }
    .sensoryFeedback(.success, trigger: scans)
    .sensoryFeedback(.success, trigger: connections)
    .sensoryFeedback(.error, trigger: connectFailures)
    .interactiveDismissDisabled(isConnecting)
    .navigationBarBackButtonHidden(isConnecting)
  }

  private var phraseButtons: some View {
    Group {
      Button("Scan Code", systemImage: "qrcode.viewfinder") { isScanning = true }
        .buttonStyle(.borderedProminent)
        .primaryActionColors()
      Button("Enter Words", systemImage: "character.cursor.ibeam") { isEnteringWords = true }
        .buttonStyle(.bordered)
    }
    .labelStyle(.titleAndIcon)
    .buttonBorderShape(.capsule)
    .lineLimit(1)
    .fixedSize(horizontal: true, vertical: false)
  }

  private var locationButtons: some View {
    Group {
      Button(pickedFolder == nil ? "Choose Folder…" : "Choose Another Folder…") { isChoosingFolder = true }
      Button("Other…") { isChoosingService = true }
    }
    .buttonStyle(.bordered)
    .buttonBorderShape(.capsule)
    .lineLimit(1)
    .fixedSize(horizontal: true, vertical: false)
  }

  private func releaseReplacedAccounts() {
    for account in flow.takeReleased() { app.sync.release(account) }
  }

  private func start(_ attempt: SyncConnectFlow.Attempt?) {
    guard let attempt else { return }
    Task {
      let result = await app.sync.connect(phrase: attempt.phrase, to: attempt.destination)
      let retry = flow.finish(result)
      if let retry {
        start(retry)
        return
      }
      if result.message != nil {
        connectFailures += 1
        return
      }
      connections += 1
      app.toasts.show(.syncConnected)
      if let onConnected {
        onConnected()
      } else {
        dismiss()
      }
    }
  }
}

#Preview("Connect") {
  NavigationStack {
    SyncConnectPage()
  }
  .environment(AppModel(isDemo: true))
}
