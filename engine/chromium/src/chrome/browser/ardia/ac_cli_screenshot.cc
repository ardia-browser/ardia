// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_screenshot.h"

#include <algorithm>
#include <cmath>
#include <utility>
#include <vector>

#include "base/base64.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/location.h"
#include "base/memory/weak_ptr.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "chrome/browser/ardia/ac_cli_ops.h"
#include "chrome/browser/ardia/ac_engine.h"
#include "components/viz/common/frame_sinks/copy_output_result.h"
#include "content/public/browser/host_zoom_map.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/visibility.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "third_party/blink/public/common/page/page_zoom.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/gfx/codec/jpeg_codec.h"
#include "ui/gfx/codec/png_codec.h"
#include "ui/gfx/geometry/rect_conversions.h"
#include "ui/gfx/geometry/size_conversions.h"

namespace ardia {
namespace {

constexpr base::TimeDelta kFrameWait = base::Milliseconds(1500);
constexpr base::TimeDelta kCopyDeadline = base::Seconds(4);
constexpr int kMaxSide = 8192;
constexpr int64_t kMaxPixels = 40'000'000;
constexpr size_t kMaxCliEncodedBytes = 960 * 1024;

const char* CopyErrorName(content::CopyFromSurfaceError error) {
  switch (error) {
    case content::CopyFromSurfaceError::kNotImplemented:
      return "not-implemented";
    case content::CopyFromSurfaceError::kFrameGone:
      return "frame-gone";
    case content::CopyFromSurfaceError::kTimeout:
      return "timeout";
    case content::CopyFromSurfaceError::kEmbeddingTokenChanged:
      return "embedding-changed";
    case content::CopyFromSurfaceError::kVizSentEmptyBitmap:
      return "empty-bitmap";
    case content::CopyFromSurfaceError::kUnknownVizError:
    case content::CopyFromSurfaceError::kUnknown:
      return "unknown";
  }
  return "unknown";
}

base::expected<std::string, std::string> Encode(SkBitmap bitmap,
                                                bool png,
                                                int quality,
                                                size_t max_encoded) {
  std::optional<std::vector<uint8_t>> bytes =
      png ? gfx::PNGCodec::FastEncodeBGRASkBitmap(bitmap, true)
          : gfx::JPEGCodec::Encode(bitmap, quality);
  if (!bytes) {
    return base::unexpected("the screenshot couldn't be encoded");
  }
  if ((bytes->size() + 2) / 3 * 4 > max_encoded) {
    return base::unexpected(kScreenshotTooBig);
  }
  return base::ok(base::Base64Encode(*bytes));
}

class ScreenshotJob : public content::WebContentsObserver {
 public:
  static void Start(content::WebContents* contents,
                    ScreenshotOptions options,
                    ScreenshotDone done) {
    (new ScreenshotJob(contents, std::move(options), std::move(done)))->Begin();
  }

  void WebContentsDestroyed() override { Fail("the tab closed"); }

  ~ScreenshotJob() override {
    if (op_id_) {
      FinishCliOp(op_id_);
    }
  }

 private:
  ScreenshotJob(content::WebContents* contents,
                ScreenshotOptions options,
                ScreenshotDone done)
      : content::WebContentsObserver(contents),
        options_(std::move(options)),
        done_(std::move(done)),
        runner_(base::SequencedTaskRunner::GetCurrentDefault()) {}

  void Begin() {
    ++CliCounts().screenshots;
    content::WebContents* contents = web_contents();
    content::RenderWidgetHostView* view =
        contents ? contents->GetRenderWidgetHostView() : nullptr;
    if (!view) {
      return Fail("the tab has no page view to capture");
    }
    if (std::optional<std::string> refused = Refusal()) {
      return Fail(*refused);
    }
    policy_ = std::make_unique<CliPolicyWatch>(
        contents, base::BindRepeating(&ScreenshotJob::PolicyChanged,
                                      weak_factory_.GetWeakPtr()));
    if (!options_.owner.empty()) {
      op_id_ = RegisterCliOp(
          options_.owner,
          base::BindOnce(&ScreenshotJob::Fail, weak_factory_.GetWeakPtr(),
                         std::string("cancelled")));
    }
    hidden_ = !TabDrawsOnScreen(contents);
    if (hidden_) {
      ++CliCounts().screenshots_hidden;
    }
    capture_ = contents->IncrementCapturerCount(gfx::Size(), true, false, false);
    RequestFrame();
  }

  void RequestFrame() {
    content::WebContents* contents = web_contents();
    if (!contents || contents->IsBeingDestroyed()) {
      return Fail("the tab closed");
    }
    waiting_frame_ = true;
    frame_timer_.Start(FROM_HERE, kFrameWait,
                       base::BindOnce(&ScreenshotJob::FrameReady,
                                      weak_factory_.GetWeakPtr(), false));
    contents->GetPrimaryMainFrame()->InsertVisualStateCallback(base::BindOnce(
        &ScreenshotJob::FrameReady, weak_factory_.GetWeakPtr()));
  }

  void FrameReady(bool committed) {
    if (!waiting_frame_) {
      return;
    }
    waiting_frame_ = false;
    frame_timer_.Stop();
    frame_committed_ = frame_committed_ || committed;
    Copy();
  }

  std::optional<std::string> Refusal() {
    if (std::optional<std::string> refused = CliTabRefusal(web_contents())) {
      return refused;
    }
    if (CliAnyFrameRefused(web_contents())) {
      return "a frame in this tab can't be captured";
    }
    return std::nullopt;
  }

  void Copy() {
    content::WebContents* contents = web_contents();
    content::RenderWidgetHostView* view =
        contents ? contents->GetRenderWidgetHostView() : nullptr;
    if (!view) {
      return Fail("the tab lost its page view");
    }
    if (std::optional<std::string> refused = Refusal()) {
      return Fail(*refused);
    }
    const gfx::Size view_size = view->GetViewBounds().size();
    if (view_size.IsEmpty()) {
      return Fail("the tab's page view has no size");
    }
    const double zoom = blink::ZoomLevelToZoomFactor(
        content::HostZoomMap::GetZoomLevel(contents));
    gfx::Rect source(view_size);
    if (options_.clip) {
      gfx::RectF dip = *options_.clip;
      if (!options_.clip_in_dips) {
        dip.Scale(static_cast<float>(zoom));
      }
      source = gfx::ToEnclosingRect(dip);
      source.Intersect(gfx::Rect(view_size));
      if (source.IsEmpty()) {
        return Fail("the clip is outside the visible page");
      }
    }
    const float scale = static_cast<float>(view->GetDeviceScaleFactor() *
                                           std::clamp(options_.scale, 0.1, 4.0));
    gfx::Size output =
        gfx::ToCeiledSize(gfx::ScaleSize(gfx::SizeF(source.size()), scale));
    if (output.width() > kMaxSide || output.height() > kMaxSide ||
        static_cast<int64_t>(output.width()) * output.height() > kMaxPixels) {
      const double shrink = std::min(
          {static_cast<double>(kMaxSide) / output.width(),
           static_cast<double>(kMaxSide) / output.height(),
           std::sqrt(static_cast<double>(kMaxPixels) /
                     (static_cast<double>(output.width()) * output.height()))});
      output = gfx::ToFlooredSize(gfx::ScaleSize(gfx::SizeF(output), shrink));
    }
    output.SetToMax(gfx::Size(1, 1));
    view->CopyFromSurface(
        source, output, kCopyDeadline,
        base::BindOnce(
            [](scoped_refptr<base::SequencedTaskRunner> runner,
               base::WeakPtr<ScreenshotJob> job,
               const content::CopyFromSurfaceResult& result) {
              std::optional<SkBitmap> bitmap;
              std::string error;
              if (result.has_value()) {
                bitmap = result->bitmap;
              } else {
                error = CopyErrorName(result.error());
              }
              runner->PostTask(FROM_HERE,
                               base::BindOnce(&ScreenshotJob::Copied, job,
                                              std::move(bitmap), error));
            },
            runner_, weak_factory_.GetWeakPtr()));
  }

  void PolicyChanged() {
    if (std::optional<std::string> refused = Refusal()) {
      Fail(*refused);
    }
  }

  void Copied(std::optional<SkBitmap> bitmap, std::string error) {
    if (!bitmap || bitmap->drawsNothing()) {
      if (!retried_) {
        retried_ = true;
        return RequestFrame();
      }
      return Fail("the page's surface couldn't be copied (" +
                  (error.empty() ? std::string("empty") : error) + ")");
    }
    width_ = bitmap->width();
    height_ = bitmap->height();
    capture_.RunAndReset();
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE,
        {base::TaskPriority::USER_VISIBLE,
         base::TaskShutdownBehavior::SKIP_ON_SHUTDOWN},
        base::BindOnce(&Encode, std::move(*bitmap), options_.png,
                       options_.quality, options_.max_encoded_bytes),
        base::BindOnce(&ScreenshotJob::Encoded, weak_factory_.GetWeakPtr()));
  }

  void Encoded(base::expected<std::string, std::string> data) {
    if (!data.has_value()) {
      return Fail(data.error());
    }
    if (std::optional<std::string> refused = Refusal()) {
      return Fail(*refused);
    }
    base::DictValue out;
    out.Set("data", std::move(*data));
    out.Set("format", options_.png ? "png" : "jpeg");
    out.Set("width", width_);
    out.Set("height", height_);
    out.Set("hidden", hidden_);
    out.Set("freshFrame", frame_committed_);
    Finish(std::move(out));
  }

  void Fail(const std::string& why) {
    ++CliCounts().screenshots_failed;
    Finish(base::unexpected(why));
  }

  void Finish(base::expected<base::DictValue, std::string> outcome) {
    if (!done_) {
      return;
    }
    frame_timer_.Stop();
    capture_.RunAndReset();
    Observe(nullptr);
    runner_->PostTask(FROM_HERE,
                      base::BindOnce(std::move(done_), std::move(outcome)));
    runner_->DeleteSoon(FROM_HERE, this);
  }

  ScreenshotOptions options_;
  ScreenshotDone done_;
  scoped_refptr<base::SequencedTaskRunner> runner_;
  base::ScopedClosureRunner capture_;
  base::OneShotTimer frame_timer_;
  bool waiting_frame_ = false;
  bool frame_committed_ = false;
  bool retried_ = false;
  bool hidden_ = false;
  int op_id_ = 0;
  std::unique_ptr<CliPolicyWatch> policy_;
  int width_ = 0;
  int height_ = 0;
  base::WeakPtrFactory<ScreenshotJob> weak_factory_{this};
};

std::optional<gfx::RectF> ClipFrom(const base::DictValue* clip) {
  if (!clip) {
    return std::nullopt;
  }
  const std::optional<double> x = clip->FindDouble("x");
  const std::optional<double> y = clip->FindDouble("y");
  const std::optional<double> width = clip->FindDouble("width");
  const std::optional<double> height = clip->FindDouble("height");
  if (!x || !y || !width || !height || !std::isfinite(*x) ||
      !std::isfinite(*y) || !std::isfinite(*width) || !std::isfinite(*height) ||
      *width <= 0 || *height <= 0 || *width > 1e5 || *height > 1e5 ||
      std::abs(*x) > 1e6 || std::abs(*y) > 1e6) {
    return std::nullopt;
  }
  return gfx::RectF(*x, *y, *width, *height);
}

}

bool TabDrawsOnScreen(content::WebContents* contents) {
  return contents && !contents->IsBeingDestroyed() &&
         contents->GetVisibility() == content::Visibility::VISIBLE;
}

std::optional<ScreenshotOptions> ScreenshotOptionsFromCdp(
    const base::DictValue& params) {
  ScreenshotOptions options;
  const std::string* format = params.FindString("format");
  if (format && *format != "png" && *format != "jpeg") {
    return std::nullopt;
  }
  if (params.FindBool("captureBeyondViewport").value_or(false) ||
      !params.FindBool("fromSurface").value_or(true)) {
    return std::nullopt;
  }
  options.png = !format || *format == "png";
  options.clip_in_dips = true;
  options.quality = std::clamp(params.FindInt("quality").value_or(80), 0, 100);
  if (const base::DictValue* clip = params.FindDict("clip")) {
    options.clip = ClipFrom(clip);
    if (!options.clip) {
      return std::nullopt;
    }
    const std::optional<double> scale = clip->FindDouble("scale");
    if (scale && (!std::isfinite(*scale) || *scale <= 0 || *scale > 4)) {
      return std::nullopt;
    }
    options.scale = scale.value_or(1.0);
  }
  return options;
}

std::optional<ScreenshotOptions> ScreenshotOptionsFromArgs(
    const base::DictValue& args,
    std::string* error) {
  ScreenshotOptions options;
  const std::string* format = args.FindString("format");
  if (format && *format != "png" && *format != "jpeg") {
    *error = "format must be png or jpeg";
    return std::nullopt;
  }
  options.png = format && *format == "png";
  const std::optional<int> quality = args.FindInt("quality");
  if (quality && (*quality < 1 || *quality > 100)) {
    *error = "quality must be 1 to 100";
    return std::nullopt;
  }
  options.quality = quality.value_or(80);
  if (const base::DictValue* clip = args.FindDict("clip")) {
    options.clip = ClipFrom(clip);
    if (!options.clip) {
      *error = "clip must be {x, y, width, height} in CSS pixels";
      return std::nullopt;
    }
  }
  const std::optional<double> scale = args.FindDouble("scale");
  if (scale && (!std::isfinite(*scale) || *scale < 0.1 || *scale > 4)) {
    *error = "scale must be 0.1 to 4";
    return std::nullopt;
  }
  options.scale = scale.value_or(1.0);
  options.owner = args.FindString("owner") ? *args.FindString("owner") : "";
  if (!options.owner.empty() && !ValidCliOwner(options.owner)) {
    *error = "bad owner";
    return std::nullopt;
  }
  options.max_encoded_bytes = kMaxCliEncodedBytes;
  return options;
}

void CaptureTabScreenshot(content::WebContents* contents,
                          ScreenshotOptions options,
                          ScreenshotDone done) {
  if (!contents || contents->IsBeingDestroyed()) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE,
        base::BindOnce(std::move(done), base::unexpected("the tab is gone")));
    return;
  }
  ScreenshotJob::Start(contents, std::move(options), std::move(done));
}

}

AC_ARGS_CALL(ac_cli_screenshot) {
  ardia::Reply out = call.TakeReply();
  std::optional<int> tab = call.args().FindInt("tab");
  content::WebContents* contents = tab ? ardia::TabWithId(*tab) : nullptr;
  if (std::optional<std::string> refused = ardia::CliTabRefusal(contents)) {
    return out.Error(*refused);
  }
  std::string error;
  std::optional<ardia::ScreenshotOptions> options =
      ardia::ScreenshotOptionsFromArgs(call.args(), &error);
  if (!options) {
    return out.Error(error);
  }
  ardia::CaptureTabScreenshot(
      contents, std::move(*options),
      base::BindOnce(
          [](ardia::Reply out,
             base::expected<base::DictValue, std::string> outcome) {
            if (!outcome.has_value()) {
              return out.Error(outcome.error());
            }
            out.Send(std::move(outcome.value()));
          },
          std::move(out)));
}
