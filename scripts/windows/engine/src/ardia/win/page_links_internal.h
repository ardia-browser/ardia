#ifndef ARDIA_WIN_PAGE_LINKS_INTERNAL_H_
#define ARDIA_WIN_PAGE_LINKS_INTERNAL_H_

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

#include "base/time/time.h"
#include "base/values.h"
#include "ui/gfx/geometry/point_f.h"
#include "url/gurl.h"

namespace content {
class RenderFrameHost;
}

namespace ardia_win::links {

inline constexpr char kWorld[] = "ardia-links";
inline constexpr char kBinding[] = "ardiaPeekSend";
inline constexpr char kOtherSiteKey[] = "site";
inline constexpr int kAlt = 1;
inline constexpr int kShift = 2;
inline constexpr int kControl = 4;
inline constexpr int kMeta = 8;
inline constexpr base::TimeDelta kGestureLifetime = base::Seconds(10);
inline constexpr base::TimeDelta kFallbackLifetime = base::Seconds(60);
inline constexpr size_t kLongestUrl = 8192;

struct MouseUp {
  int keys = 0;
  std::optional<base::TimeTicks> at;
  std::string page;
  gfx::PointF point;
  uint64_t seq = 0;
  uint64_t used_seq = 0;
  bool pressed_since = false;
};

MouseUp& LastUp();
int& ConfigGeneration();
int LinkKeyFlags(const std::string& key);
std::string LinkKeyAction(const std::string& key);
std::string Field(const base::DictValue& dict,
                  std::string_view key,
                  size_t longest);
bool Finite(const base::DictValue& dict, std::string_view key, double* out);
bool Web(const GURL& url);
bool ScriptableDocument(content::RenderFrameHost* frame);
base::DictValue PointValue(gfx::PointF point);

}

#endif
