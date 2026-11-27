#ifndef ARDIA_DESKTOP_AC_DESKTOP_PATHS_H_
#define ARDIA_DESKTOP_AC_DESKTOP_PATHS_H_

#include <string>
#include <string_view>
#include <type_traits>
#include <utility>

namespace ardia::desktop_paths {

template <typename Path>
inline constexpr bool kNarrowPaths =
    std::is_same_v<std::remove_cvref_t<decltype(std::declval<const Path&>().value())>, std::string>;

template <typename Path>
std::string Text(const Path& path) {
  if constexpr (kNarrowPaths<Path>) {
    return path.value();
  } else {
    return path.AsUTF8Unsafe();
  }
}

template <typename Path>
Path FromText(std::string_view text) {
  if constexpr (kNarrowPaths<Path>) {
    return Path(text);
  } else {
    return Path::FromUTF8Unsafe(text);
  }
}

}

#endif
