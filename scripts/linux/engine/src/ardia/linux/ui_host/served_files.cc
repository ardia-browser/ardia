// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/ui_host/served_files.h"

#include <map>

#include "base/no_destructor.h"
#include "base/synchronization/lock.h"

namespace ardia_linux {

namespace {

constexpr size_t kMostServedImages = 1024;

struct ServedImages {
  base::Lock lock;
  std::map<base::FilePath, base::FilePath> files GUARDED_BY(lock);
};

ServedImages& Images() {
  static base::NoDestructor<ServedImages> images;
  return *images;
}

}

void ServeImportImage(const base::FilePath& shown_as,
                      const base::FilePath& file) {
  ServedImages& images = Images();
  base::AutoLock hold(images.lock);
  if (images.files.size() >= kMostServedImages &&
      !images.files.contains(shown_as)) {
    return;
  }
  images.files[shown_as] = file;
}

std::optional<base::FilePath> ServedImportImage(
    const base::FilePath& shown_as) {
  ServedImages& images = Images();
  base::AutoLock hold(images.lock);
  auto found = images.files.find(shown_as);
  if (found == images.files.end()) {
    return std::nullopt;
  }
  return found->second;
}

}
