public enum PageLoadCommit {
  public static func after(loading: Bool, wasLoading: Bool, committed: Bool) -> Bool {
    if loading { return wasLoading ? committed : false }
    return true
  }

  public static func sameDocument(loading: Bool, hadURL: Bool) -> Bool {
    !loading && hadURL
  }
}
