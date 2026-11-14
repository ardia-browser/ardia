import ArdiaBrowser
import ArdiaDesign
import AuthenticationServices
import AVFoundation
import SwiftUI

struct ContinueWithChatGPTButton: View {
  var onConnected: () -> Void = {}

  @Environment(AppModel.self) private var app
  @Environment(\.webAuthenticationSession) private var webAuthenticationSession
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    let account = app.chatGPT
    Button {
      Task {
        if await account.signIn(using: webAuthenticationSession) { onConnected() }
      }
    } label: {
      HStack(spacing: Spacing.tight) {
        if account.isSigningIn {
          ProgressView()
            .tint(colorScheme == .dark ? .black : .white)
        }
        Text("Continue with ChatGPT")
          .font(.body.weight(.semibold))
      }
      .frame(maxWidth: .infinity, minHeight: 48)
      .foregroundStyle(colorScheme == .dark ? Color.black : Color.white)
      .background(colorScheme == .dark ? Color.white : Color.black, in: .capsule)
      .contentShape(.capsule)
    }
    .buttonStyle(PressableStyle())
    .disabled(account.isSigningIn)
    .accessibilityHint(Text("Signs in with your ChatGPT account so Browse for Me can use your plan"))
  }
}

struct BrowseForMePage: View {
  @Environment(AppModel.self) private var app
  @State private var confirmsDisconnect = false

  private var account: ChatGPTAccount { app.chatGPT }

  var body: some View {
    Form {
      SettingsHero(
        "Browse for Me",
        subtitle: account.isConnected
          ? Text("Answers come from your ChatGPT plan. When it can’t answer, Apple Intelligence writes them on this iPhone.")
          : Text("Answers are written on this iPhone by Apple Intelligence. Connect ChatGPT Plus or Pro for better answers from your own plan."),
        systemImage: "sparkle.magnifyingglass",
        tint: SettingsTint.nightShade
      )

      if let label = account.accountLabel {
        Section {
          LabeledContent("ChatGPT", value: label)
          if account.models.count > 1, let model = account.model {
            Picker("Model", selection: Binding(get: { model }, set: { account.choose($0) })) {
              ForEach(account.models) { model in
                Text(model.displayName).tag(model)
              }
            }
            .tint(.secondary)
          } else if let model = account.model {
            LabeledContent("Model", value: model.displayName)
          }
          Button("Check Usage") {
            app.sheet = nil
            app.openPage(ChatGPTAccount.usageURL, origin: .typed)
          }
          Button("Disconnect ChatGPT", role: .destructive) { confirmsDisconnect = true }
        } footer: {
          Text("Your search and the text of the pages it read go straight from this iPhone to OpenAI on your plan, never through a server of ours. Usage counts toward your ChatGPT limits.")
        }
      } else {
        Section {
          ContinueWithChatGPTButton()
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
        } footer: {
          VStack(alignment: .leading, spacing: Spacing.hairline) {
            if let problem = account.problem {
              Text(problem)
                .foregroundStyle(.red)
            }
            Text("Needs ChatGPT Plus or Pro. Your search and the text of the pages it read go straight from this iPhone to OpenAI, never through a server of ours.")
          }
          .padding(.top, Spacing.tight)
        }
      }

      Section {
        LabeledContent("Voice", value: VoiceChoice.current.name)
      } header: {
        Text("Reading Aloud")
      } footer: {
        if !VoiceChoice.current.isNatural {
          Text(VoiceChoice.downloadTip)
        }
      }
    }
    .navigationTitle("Browse for Me")
    .navigationBarTitleDisplayMode(.inline)
    .onDisappear { account.clearProblem() }
    .confirmationDialog("Disconnect ChatGPT?", isPresented: $confirmsDisconnect, titleVisibility: .visible) {
      Button("Disconnect", role: .destructive) { Task { await account.disconnect() } }
    } message: {
      Text("Browse for Me goes back to answering on this iPhone.")
    }
  }
}

struct VoiceChoice {
  var name: String
  var isNatural: Bool

  static let downloadTip = String(localized: "For a more natural voice, download an Enhanced or Premium voice in Settings › Accessibility › Read & Speak › Voices. Ardia uses the best one you have.")

  static var current: VoiceChoice {
    guard let voice = ReadAloud.bestVoice() else { return VoiceChoice(name: String(localized: "System"), isNatural: false) }
    return VoiceChoice(name: voice.name, isNatural: voice.quality != .default)
  }
}
