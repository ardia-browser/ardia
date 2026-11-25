// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_PAGE_MODEL_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_PAGE_MODEL_H_

#include <cstddef>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/values.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents_user_data.h"
#include "ui/gfx/geometry/point_f.h"
#include "ui/gfx/geometry/rect_f.h"
#include "ui/gfx/geometry/size_f.h"
#include "ui/gfx/geometry/vector2d_f.h"

namespace ardia {

struct AxItem {
  int parent = -1;
  int depth = 0;
  int frame = 0;
  int dom = 0;
  std::string role;
  std::string name;
  std::string value;
  gfx::RectF box;
  gfx::RectF visible;
  bool offscreen = false;
  bool hidden = false;
  bool interactive = false;
  bool structural = false;
  bool text = false;
  bool frame_host = false;
  bool disabled = false;
  bool focused = false;
  int checked = -1;
  int expanded = -1;
  bool modal = false;
  bool redacted = false;
  std::vector<int> children;
};

struct AxFrame {
  int root = 0;
  int host = -1;
  int parent = -1;
  std::string token;
  std::string local_root;
  std::string session;
  bool reachable = false;
  gfx::Vector2dF origin;
  float zoom = 1.0f;
};

struct PageModel {
  std::vector<AxItem> items;
  std::vector<AxFrame> frames;
  double scale = 1.0;
  gfx::SizeF viewport;
  int focus = -1;
  int modal = -1;
  bool frames_truncated = false;
  bool items_truncated = false;

  bool IsAncestor(int ancestor, int item) const;
  int Find(int frame, int dom) const;
  int FrameWithToken(const std::string& token) const;
  int ChildFrameOfHost(int host) const;
  bool InViewport(int item) const;
  gfx::PointF ClickPoint(int item) const;

  std::map<std::pair<int, int>, int> by_dom;
};

struct FrameRead {
  std::string token;
  int parent = -1;
  int owner_dom = 0;
  base::ListValue ax_nodes;
};

struct DocRead {
  bool classified = false;
  std::string url;
  gfx::SizeF frame_size;
  gfx::Vector2dF scroll;
  std::map<int, gfx::RectF> rects;
  std::map<int, gfx::RectF> client;
  std::set<int> clickable;
  std::set<int> sensitive;
};

bool SensitiveAutocomplete(std::string_view value);

std::optional<PageModel> BuildPageModel(const std::vector<FrameRead>& frames,
                                        const std::map<std::string, DocRead>& docs,
                                        double scale,
                                        gfx::SizeF viewport,
                                        std::string* error);

std::string Fingerprint(const AxItem& item);

int BlockerOf(const PageModel& model, int hit, int target);

struct DismissChoice {
  int item = -1;
  std::string kind;
  int score = 0;
};

std::vector<DismissChoice> DismissChoices(const PageModel& model,
                                          int layer,
                                          size_t limit);

base::ListValue BoxValue(const gfx::RectF& box);

class RefStore : public content::WebContentsUserData<RefStore>,
                 public content::WebContentsObserver {
 public:
  struct Entry {
    std::string frame;
    int dom = 0;
    std::string role;
    std::string name;
    gfx::RectF box;
    uint64_t used = 0;
  };

  struct Resolved {
    int item = -1;
    bool rebound = false;
    bool changed = false;
    std::string error;
  };

  ~RefStore() override;

  std::string RefFor(const PageModel& model, int item);
  Resolved Resolve(const std::string& ref, const PageModel& model);
  int generation() const { return generation_; }

  void DidFinishNavigation(content::NavigationHandle* navigation) override;

 private:
  friend class content::WebContentsUserData<RefStore>;
  explicit RefStore(content::WebContents* contents);

  std::string KeyFrame(const PageModel& model, int frame) const;
  void Trim();

  std::map<std::string, Entry> entries_;
  std::map<std::pair<std::string, int>, std::string> keys_;
  int next_ = 1;
  int generation_ = 1;
  uint64_t clock_ = 0;

  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

std::string ClippedUtf8(const std::string& text, size_t bytes);

}

#endif
