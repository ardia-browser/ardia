export function folderChildren(parentOf: Map<string, string>, keys: string[], fallback: string): Map<string, string[]> {
  const rooted = new Set<string>();
  for (const key of keys) {
    const path = [key];
    const seen = new Set([key]);
    let looped = false;
    for (let at = parentOf.get(key)!; parentOf.has(at) && !rooted.has(at); at = parentOf.get(at)!) {
      if (seen.has(at)) {
        parentOf.set(key, fallback);
        looped = true;
        break;
      }
      seen.add(at);
      path.push(at);
    }
    if (looped) rooted.add(key);
    else for (const at of path) rooted.add(at);
  }
  const children = new Map<string, string[]>();
  for (const key of parentOf.keys()) {
    const list = children.get(parentOf.get(key)!);
    if (list) list.push(key);
    else children.set(parentOf.get(key)!, [key]);
  }
  return children;
}
