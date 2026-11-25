#include "ardia/win/page_links.h"

#include <algorithm>
#include <string>

#include "ardia/win/host.h"
#include "ardia/win/page_links_internal.h"
#include "ardia/win/tab_state.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "url/origin.h"

namespace ardia_win {

using namespace links;

void PageLinks::PeekLink(const base::DictValue& data, int context, bool main) {
  const GURL url(Field(data, "url", kLongestUrl));
  const std::string key = Field(data, "key", 8);
  const bool other_site = key == kOtherSiteKey;
  const std::string action =
      other_site ? (PeeksOtherSites() ? "peek" : "") : LinkKeyAction(key);
  const std::string page = PageKey();
  MouseUp& up = LastUp();
  const base::TimeTicks now = base::TimeTicks::Now();
  std::string refused;
  if (action.empty()) {
    refused = "that key opens nothing now";
  } else if (other_site && !main) {
    refused = "only the page itself peeks links to other sites";
  } else if (page.empty() || !Host::Get()->Shows(page)) {
    refused = "page not shown";
  } else if (!Web(url)) {
    refused = "not http(s)";
  } else if (!up.at) {
    refused = "no left mouse-up yet";
  } else if (up.seq == up.used_seq) {
    refused = "that mouse-up already opened a peek";
  } else if (up.pressed_since) {
    refused = "the mouse was pressed again since that mouse-up";
  } else if (now - *up.at > kGestureLifetime) {
    refused = "the last mouse-up is too old";
  } else if (up.page != page) {
    refused = "the mouse-up wasn't over this page";
  } else if (up.keys != (other_site ? 0 : LinkKeyFlags(key))) {
    refused = "the mouse-up's keys aren't the page's key alone";
  }
  if (!refused.empty()) {
    LOG(WARNING) << "[ardia links] no peek: " << refused;
    FallBack(data, url, context, refused);
    return;
  }
  up.used_seq = up.seq;
  if (action == "split") {
    base::DictValue payload;
    payload.Set("url", url.spec());
    payload.Set("disposition", "split");
    payload.Set("userGesture", true);
    OpenWindow(std::move(payload));
    return;
  }
  gfx::PointF point = up.point;
  double x = 0;
  double y = 0;
  if (main && Finite(data, "x", &x) && Finite(data, "y", &y)) {
    content::RenderWidgetHostView* view =
        GetWebContents().GetRenderWidgetHostView();
    const float scale =
        view && view->GetDeviceScaleFactor() > 0 ? view->GetDeviceScaleFactor()
                                                 : 1;
    point = gfx::PointF(x / scale, y / scale);
  }
  base::DictValue payload;
  payload.Set("url", url.spec());
  payload.Set("disposition", "peek");
  payload.Set("userGesture", true);
  payload.Set("site", other_site);
  payload.Set("point", PointValue(ClampedToPage(point)));
  OpenWindow(std::move(payload));
}

void PageLinks::FallBack(const base::DictValue& data,
                         const GURL& url,
                         int context,
                         const std::string& reason) {
  const std::string key = Field(data, "key", 8);
  if (key == kOtherSiteKey) {
    base::DictValue refusal;
    refusal.Set("url", url.spec());
    refusal.Set("reason", reason);
    refusal.Set("follow", true);
    Refuse(context, std::move(refusal));
    return;
  }
  const int page_flag = LinkKeyFlags(key);
  const bool split = LinkKeyAction(key) == "split";
  MouseUp& up = LastUp();
  const bool fresh = up.at &&
                     base::TimeTicks::Now() - *up.at <= kFallbackLifetime &&
                     !up.pressed_since;
  const bool user_clicked = fresh && up.seq != up.used_seq &&
                            up.page == PageKey() && up.keys == page_flag;
  if (split && user_clicked) {
    up.used_seq = up.seq;
  }
  if (split || !page_flag || !Web(url) || !user_clicked) {
    return;
  }
  up.used_seq = up.seq;
  if (page_flag == kShift) {
    base::DictValue payload;
    payload.Set("url", url.spec());
    payload.Set("disposition", "window");
    payload.Set("userGesture", true);
    OpenWindow(std::move(payload));
    return;
  }
  const GURL origin(Field(data, "origin", 1024));
  if (origin.is_valid() &&
      url::Origin::Create(origin).IsSameOriginWith(url::Origin::Create(url))) {
    base::DictValue refusal;
    refusal.Set("url", url.spec());
    refusal.Set("reason", reason);
    refusal.Set("download", true);
    Refuse(context, std::move(refusal));
    return;
  }
  base::DictValue payload;
  payload.Set("url", url.spec());
  payload.Set("disposition", "background");
  payload.Set("userGesture", true);
  OpenWindow(std::move(payload));
}

void PageLinks::Refuse(int context, base::DictValue refusal) {
  Evaluate(context, "ardiaPeek.refused(" +
                        base::WriteJson(refusal).value_or("null") + ");");
}

void PageLinks::OpenWindow(base::DictValue payload) {
  if (TabState* state = TabState::FromWebContents(&GetWebContents())) {
    state->Send("openWindow", std::move(payload));
  }
}

gfx::PointF PageLinks::ClampedToPage(gfx::PointF point) {
  content::RenderWidgetHostView* view =
      GetWebContents().GetRenderWidgetHostView();
  if (!view) {
    return point;
  }
  const gfx::Size size = view->GetViewBounds().size();
  return gfx::PointF(
      std::clamp(point.x(), 0.0f, static_cast<float>(size.width())),
      std::clamp(point.y(), 0.0f, static_cast<float>(size.height())));
}

}
