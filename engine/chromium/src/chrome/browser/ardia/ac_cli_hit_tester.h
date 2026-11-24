// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_HIT_TESTER_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_HIT_TESTER_H_

#include <map>
#include <string>

#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "chrome/browser/ardia/ac_cli_cdp.h"
#include "chrome/browser/ardia/ac_cli_page_model.h"
#include "ui/gfx/geometry/point_f.h"
#include "ui/gfx/geometry/vector2d_f.h"

namespace ardia {

class FrameHitTester {
 public:
  using HitDone = base::OnceCallback<void(int)>;

  FrameHitTester();
  FrameHitTester(const FrameHitTester&) = delete;
  FrameHitTester& operator=(const FrameHitTester&) = delete;
  ~FrameHitTester();

  void Use(CdpSession* probe, const PageModel* model);
  void ForgetScroll() { scrolls_.clear(); }
  void HitAt(gfx::PointF global, HitDone done);

 private:
  void HitIn(int frame, gfx::PointF global, int depth, HitDone done);
  void GotMetrics(int frame,
                  gfx::PointF global,
                  int depth,
                  HitDone done,
                  CdpResult result);
  void Locate(int frame,
              gfx::PointF global,
              int depth,
              gfx::Vector2dF scroll,
              HitDone done);
  void Located(int frame,
               gfx::PointF global,
               int depth,
               HitDone done,
               CdpResult result);

  raw_ptr<CdpSession> probe_ = nullptr;
  raw_ptr<const PageModel> model_ = nullptr;
  std::map<std::string, gfx::Vector2dF> scrolls_;
  base::WeakPtrFactory<FrameHitTester> weak_factory_{this};
};

}

#endif
