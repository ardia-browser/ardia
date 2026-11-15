// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_HOST_INPUT_REGION_H_
#define ARDIA_LINUX_HOST_INPUT_REGION_H_

#include <map>
#include <string>
#include <vector>

#include "base/values.h"
#include "ui/gfx/geometry/point.h"
#include "ui/gfx/geometry/rect_f.h"

namespace ardia_linux {

struct RoundedArea {
  gfx::RectF rect;
  float radius = 0;

  bool Contains(const gfx::PointF& point) const;
};

class InputRegion {
 public:
  InputRegion();
  InputRegion(const InputRegion&) = delete;
  InputRegion& operator=(const InputRegion&) = delete;
  ~InputRegion();

  static std::vector<RoundedArea> HolesFrom(const base::ListValue* holes);

  void SetPage(const std::string& key,
               const RoundedArea& page,
               std::vector<RoundedArea> holes);
  void RemovePage(const std::string& key);
  void RaisePage(const std::string& key);
  bool Has(const std::string& key) const;

  std::string PageAt(const gfx::PointF& point) const;
  std::string PageAt(const gfx::Point& point) const {
    return PageAt(gfx::PointF(point));
  }

 private:
  struct Entry {
    RoundedArea page;
    std::vector<RoundedArea> holes;
    int order = 0;
  };

  std::map<std::string, Entry> pages_;
  int next_order_ = 0;
};

}

#endif
