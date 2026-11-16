import ArdiaDesign
import ArdiaSync
import SwiftUI

struct NextcloudConnectPage: View {
  var onSignedIn: (NextcloudAccount, String?) -> Void

  private enum SignIn: Equatable {
    case idle
    case waiting
    case signedIn(NextcloudAccount)
    case failed(String)
  }

  @Environment(\.dismiss) private var dismiss
  @State private var address = ""
  @State private var folder = ""
  @State private var signIn = SignIn.idle
  @State private var attempt: Task<Void, Never>?
  @State private var web = NextcloudWebLogin()
  @State private var handedToOwner = false
  @State private var signIns = 0
  @State private var failures = 0

  private var account: NextcloudAccount? {
    if case .signedIn(let account) = signIn { return account }
    return nil
  }

  private var isWaiting: Bool { signIn == .waiting }

  var body: some View {
    Form {
      SettingsHero("Use Nextcloud", subtitle: Text("Sync with your Mac through your own Nextcloud server."), icon: OtherSyncServiceTile(service: .nextcloud, baseSide: 64))

      Section {
        TextField("cloud.example.com", text: $address)
          .keyboardType(.URL)
          .textContentType(.URL)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .submitLabel(.go)
          .onSubmit(startSignIn)
          .disabled(isWaiting || account != nil)
      } header: {
        Text("Server")
      } footer: {
        Text("The address you open Nextcloud at in a browser.")
      }

      Section {
        switch signIn {
        case .signedIn(let account):
          HStack(spacing: Spacing.tight) {
            Label {
              Text(verbatim: account.description)
            } icon: {
              Image(systemName: "checkmark.circle.fill")
            }
            .foregroundStyle(.ink(.green))
            Spacer()
            Button("Change") { signOut() }
          }
        case .waiting:
          HStack(spacing: Spacing.tight) {
            ProgressView()
            Text("Waiting for you to sign in…").foregroundStyle(.secondary)
            Spacer()
            Button("Cancel") { cancelSignIn() }
          }
        case .idle, .failed:
          Button("Sign In with Nextcloud", action: startSignIn)
            .disabled(address.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        if case .failed(let message) = signIn {
          Text(message)
            .font(.subheadline)
            .foregroundStyle(.ink(.red))
            .fixedSize(horizontal: false, vertical: true)
        }
      } header: {
        Text("Account")
      } footer: {
        Text("Ardia gets an app password of its own and keeps it in this iPhone’s Keychain. Your Nextcloud password never reaches Ardia. If an “Ardia” app password is left over, remove it in Nextcloud › Settings › Security › Devices & sessions.")
      }

      Section {
        TextField("Found automatically", text: $folder)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .submitLabel(.done)
      } header: {
        Text("Folder (Optional)")
      } footer: {
        Text("Leave this empty and Ardia finds the folder your Mac syncs to. Otherwise type its path, like Ardia Sync.")
      }

      if let account {
        Section {
          Button("Continue") {
            handedToOwner = true
            let path = folder.trimmingCharacters(in: .whitespacesAndNewlines)
            onSignedIn(account, path.isEmpty ? nil : path)
            dismiss()
          }
          .frame(maxWidth: .infinity)
        }
      }
    }
    .settingsPage("Use Nextcloud")
    .animation(Motion.snappy, value: signIn)
    .sensoryFeedback(.success, trigger: signIns)
    .sensoryFeedback(.error, trigger: failures)
    .onDisappear {
      attempt?.cancel()
      web.close()
      if !handedToOwner, let account { revoke(account) }
    }
  }

  private func startSignIn() {
    guard !isWaiting, account == nil else { return }
    let server: URL
    do {
      server = try NextcloudLogin.serverURL(from: address)
    } catch {
      fail(error)
      return
    }
    signIn = .waiting
    attempt = Task {
      let login = NextcloudLogin()
      do {
        let start = try await login.begin(server: server)
        guard web.open(start.loginURL, onClose: { if signIn == .waiting { cancelSignIn() } }) else {
          fail(NextcloudProblem.unreachable)
          return
        }
        let account = try await login.waitForAccount(start)
        web.close()
        guard !Task.isCancelled else {
          revoke(account)
          return
        }
        signIn = .signedIn(account)
        signIns += 1
      } catch is CancellationError {
        web.close()
      } catch {
        web.close()
        fail(error)
      }
    }
  }

  private func cancelSignIn() {
    attempt?.cancel()
    attempt = nil
    web.close()
    signIn = .idle
  }

  private func signOut() {
    if let account { revoke(account) }
    signIn = .idle
  }

  private func fail(_ error: Error) {
    signIn = .failed((error as? NextcloudProblem ?? .unreachable).message)
    failures += 1
  }

  private func revoke(_ account: NextcloudAccount) {
    Task { await NextcloudLogin().revoke(account) }
  }
}

#Preview("Nextcloud") {
  NavigationStack {
    NextcloudConnectPage { _, _ in }
  }
}
