#ifndef ARDIA_WIN_CONTENTS_BACKGROUND_H_
#define ARDIA_WIN_CONTENTS_BACKGROUND_H_

#include <optional>

#include "base/values.h"
#include "third_party/skia/include/core/SkColor.h"

namespace content {
class WebContents;
}

namespace ardia_win {

struct ContentsBackgroundArgument {
  bool given = false;
  bool malformed = false;
  std::optional<SkColor> color;
};

ContentsBackgroundArgument ReadContentsBackground(const base::DictValue& args);

void SetContentsBackground(content::WebContents* contents, SkColor color);

void RefreshContentsBackground(content::WebContents* contents);

void MarkAheadBlank(content::WebContents* contents);

void EndAheadBlank(content::WebContents* contents);

void InstallContentsBackground();

}

#endif
