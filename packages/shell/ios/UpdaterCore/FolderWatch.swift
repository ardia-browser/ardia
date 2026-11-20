import Foundation

final class FolderWatch {
  enum Binding: Equatable {
    case watching
    case absent
    case failed(Int32)
  }

  let path: String
  private let queue: DispatchQueue
  private let changed: () -> Void
  private let openFolder: (String) -> Int32
  private let waitsForAbsentFolder: Bool
  private var source: DispatchSourceFileSystemObject?
  private var watched: (device: UInt64, inode: UInt64)?
  private var ancestor: FolderWatch?
  private(set) var binding = Binding.absent

  init(path: String, queue: DispatchQueue = .main, open openFolder: @escaping (String) -> Int32 = { open($0, O_EVTONLY | O_NONBLOCK | O_DIRECTORY | O_CLOEXEC) },
       waitsForAbsentFolder: Bool = false, changed: @escaping () -> Void) {
    self.path = path
    self.queue = queue
    self.openFolder = openFolder
    self.waitsForAbsentFolder = waitsForAbsentFolder
    self.changed = changed
  }

  var watchedAncestor: String? { ancestor?.path }

  deinit { source?.cancel() }

  func start() { bind() }

  func stop() {
    source?.cancel()
    source = nil
    watched = nil
    ancestor?.stop()
    ancestor = nil
  }

  func retry() {
    guard binding != .watching else { return }
    bind()
  }

  private func bind(tries: Int = 3) {
    stop()
    let descriptor = openFolder(path)
    guard descriptor >= 0 else {
      let failure = errno
      binding = failure == ENOENT || failure == ENOTDIR ? .absent : .failed(failure)
      if binding == .absent { followAncestor() }
      return queue.async { [weak self] in self?.changed() }
    }
    var info = stat()
    guard fstat(descriptor, &info) == 0 else {
      let failure = errno
      close(descriptor)
      if failure == ENOENT, tries > 1 { return bind(tries: tries - 1) }
      binding = .failed(failure)
      return queue.async { [weak self] in self?.changed() }
    }
    watched = (UInt64(info.st_dev), UInt64(info.st_ino))
    let source = DispatchSource.makeFileSystemObjectSource(
      fileDescriptor: descriptor, eventMask: [.write, .delete, .rename, .revoke, .link], queue: queue)
    source.setEventHandler { [weak self, weak source] in
      guard let self, let source, self.source === source else { return }
      self.handle(source.data)
    }
    source.setCancelHandler { close(descriptor) }
    source.setRegistrationHandler { [weak self, weak source] in
      guard let self, let source, self.source === source else { return }
      self.pathIsWatchedObject ? self.changed() : self.bind()
    }
    self.source = source
    binding = .watching
    source.resume()
  }

  private func handle(_ events: DispatchSource.FileSystemEvent) {
    guard events.isDisjoint(with: [.delete, .rename, .revoke]), pathIsWatchedObject else { return bind() }
    changed()
  }

  private func followAncestor() {
    guard waitsForAbsentFolder, let nearest = Self.nearestFolder(above: path) else { return }
    if ancestor?.path == nearest { return }
    ancestor?.stop()
    let watch = FolderWatch(path: nearest, queue: queue, open: openFolder) { [weak self] in self?.ancestorChanged() }
    ancestor = watch
    watch.start()
  }

  private func ancestorChanged() {
    guard source == nil, ancestor != nil else { return }
    if Self.isFolder(path) { return bind() }
    followAncestor()
  }

  private static func isFolder(_ path: String) -> Bool {
    var info = stat()
    return stat(path, &info) == 0 && (info.st_mode & S_IFMT) == S_IFDIR
  }

  private static func nearestFolder(above path: String) -> String? {
    var current = (path as NSString).standardizingPath
    while current != "/" {
      current = (current as NSString).deletingLastPathComponent
      if current.isEmpty { return nil }
      if isFolder(current) { return current }
    }
    return nil
  }

  private var pathIsWatchedObject: Bool {
    var info = stat()
    guard stat(path, &info) == 0, let watched else { return false }
    return UInt64(info.st_dev) == watched.device && UInt64(info.st_ino) == watched.inode
  }
}
