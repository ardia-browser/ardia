import Foundation
@testable import ArdiaSyncCore

extension SharedFolderDirectory {
  init(root: URL, coordination: SyncCoordination? = SharedFolderDirectory.coordination) {
    self.init(root: root, identity: SharedFolderDirectory.identity(of: root.path) ?? ["device": -1, "inode": -1], coordination: coordination)
  }
}
