import ArdiaDesign
import SwiftUI

struct TalkToMeSections: View {
  @State private var confirmsRemoval = false

  private var talk: TalkToMe { .shared }

  var body: some View {
    Section {
      Toggle(isOn: Binding(get: { talk.isOn }, set: { talk.isOn = $0 })) {
        Text("Talk to Me")
      }
      .toggleStyle(SettingsSwitchStyle())
      .accessibilityHint(Text("Reads Browse for Me answers aloud on this iPhone"))
      if talk.isOn {
        downloadRow
      }
    } footer: {
      Text(footer)
    }
    .onAppear { talk.refresh() }

    if talk.isOn, talk.isReady {
      Section {
        Picker("Speed", selection: Binding(get: { talk.speed }, set: { talk.speed = $0 })) {
          ForEach(TalkToMe.speeds, id: \.self) { speed in
            Text(Self.speedLabel(speed)).tag(speed)
          }
        }
        .tint(.secondary)
      }

      Section {
        ForEach(TalkToMe.voices) { voice in
          voiceRow(voice)
        }
      } header: {
        Text("Voice")
      } footer: {
        Text("Tap a voice to hear it.")
      }

      Section {
        if case .ready(let bytes?) = talk.download {
          LabeledContent("Voice Download", value: TalkToMe.size(bytes))
        }
        Button("Remove Voice Download", role: .destructive) { confirmsRemoval = true }
      }
      .confirmationDialog("Remove the Voice Download?", isPresented: $confirmsRemoval, titleVisibility: .visible) {
        Button("Remove", role: .destructive) { talk.removeDownload() }
      } message: {
        Text("Talk to Me turns off. You can download the voice again any time.")
      }
    }
  }

  private var footer: String {
    var parts = [String(localized: "When an answer is done, the bar at its end plays it out loud, or hold your iPhone to your ear to listen. Phonon, an on-device voice, speaks it on this iPhone, and nothing you hear leaves it.")]
    if case .absent(let bytes?) = talk.download, !talk.isOn {
      parts.append(String(localized: "Turning it on downloads the voice (\(TalkToMe.size(bytes)))."))
    } else if !talk.isOn {
      parts.append(String(localized: "Turning it on downloads the voice."))
    }
    parts.append(String(localized: "English only for now: answers in other languages aren’t read aloud."))
    return parts.joined(separator: " ")
  }

  @ViewBuilder
  private var downloadRow: some View {
    switch talk.download {
    case .checking:
      HStack(spacing: Spacing.small) {
        ProgressView()
        Text("Checking for the voice")
          .foregroundStyle(.secondary)
      }
      .accessibilityElement(children: .combine)
    case .absent(let bytes):
      Button(bytes.map { String(localized: "Download Voice (\(TalkToMe.size($0)))") } ?? String(localized: "Download Voice")) {
        talk.startDownload()
      }
    case .downloading(let fraction):
      VStack(alignment: .leading, spacing: Spacing.tight) {
        HStack {
          Text("Downloading Voice")
          Spacer()
          Text(fraction, format: .percent.precision(.fractionLength(0)))
            .monospacedDigit()
            .foregroundStyle(.secondary)
        }
        ProgressView(value: fraction)
      }
      .accessibilityElement(children: .combine)
      .accessibilityValue(Text(fraction, format: .percent.precision(.fractionLength(0))))
      Button("Cancel Download", role: .cancel) { talk.cancelDownload() }
    case .failed(let problem):
      VStack(alignment: .leading, spacing: Spacing.hairline) {
        Text(problem)
          .foregroundStyle(.red)
          .fixedSize(horizontal: false, vertical: true)
      }
      Button("Try Again") { talk.startDownload() }
    case .ready:
      EmptyView()
    }
  }

  private func voiceRow(_ voice: TalkToMe.Voice) -> some View {
    let chosen = talk.voice == voice.id
    return Button {
      talk.sample(voice.id)
    } label: {
      HStack(spacing: Spacing.small) {
        VStack(alignment: .leading, spacing: 2) {
          Text(verbatim: voice.id)
            .foregroundStyle(.primary)
          Text(voice.accent)
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        Spacer()
        if talk.sampling == voice.id {
          Image(systemName: "speaker.wave.2.fill")
            .symbolEffect(.variableColor.iterative)
            .foregroundStyle(.secondary)
            .accessibilityHidden(true)
        }
        if chosen {
          Image(systemName: "checkmark")
            .font(.body.weight(.semibold))
            .foregroundStyle(Palette.formAccent)
            .accessibilityHidden(true)
        }
      }
      .contentShape(.rect)
    }
    .tint(.primary)
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(chosen ? .isSelected : [])
    .accessibilityHint(Text("Chooses this voice and plays a sample"))
  }

  static func speedLabel(_ speed: Double) -> String {
    speed.formatted(.number.precision(.fractionLength(0...2))) + "×"
  }
}
