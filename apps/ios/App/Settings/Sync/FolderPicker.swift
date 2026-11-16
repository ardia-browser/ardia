import SwiftUI
import UniformTypeIdentifiers

extension View {
  func folderPicker(isPresented: Binding<Bool>, onPick: @escaping (URL) -> Void) -> some View {
    fileImporter(isPresented: isPresented, allowedContentTypes: [.folder], allowsMultipleSelection: false) { result in
      guard case .success(let urls) = result, let url = urls.first else { return }
      onPick(url)
    }
    .fileDialogMessage(Text("Choose the Ardia Sync folder your Mac syncs to, like the one in iCloud Drive."))
    .fileDialogConfirmationLabel(Text("Use Folder"))
  }
}
