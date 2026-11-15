// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/recording.h"

#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "ardia/core/ac_launch_switches.h"
#include "ardia/linux/host/host.h"
#include "ardia/linux/log.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/modules/args.h"
#include "ardia/linux/modules/report.h"
#include "ardia/linux/windows/app_window.h"
#include "ardia/linux/windows/app_windows.h"
#include "base/base64.h"
#include "base/files/file.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/scoped_observation.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "base/token.h"
#include "cc/paint/paint_flags.h"
#include "components/input/native_web_keyboard_event.h"
#include "content/public/browser/desktop_media_id.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "third_party/blink/public/common/input/web_input_event.h"
#include "third_party/blink/public/common/mediastream/media_stream_request.h"
#include "third_party/blink/public/mojom/mediastream/media_stream.mojom.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/base/metadata/metadata_header_macros.h"
#include "ui/base/metadata/metadata_impl_macros.h"
#include "ui/compositor/compositor.h"
#include "ui/events/keycodes/keyboard_codes.h"
#include "ui/gfx/canvas.h"
#include "ui/gfx/font_list.h"
#include "ui/views/background.h"
#include "ui/views/controls/button/label_button.h"
#include "ui/views/controls/label.h"
#include "ui/views/view.h"
#include "ui/views/widget/widget.h"
#include "ui/views/widget/widget_observer.h"

namespace ardia_linux {

namespace {

constexpr char kModule[] = "ArdiaReport";
constexpr base::TimeDelta kSourceLifetime = base::Seconds(10);
constexpr base::TimeDelta kCaptureRedraws[] = {
    base::Milliseconds(100), base::Milliseconds(300), base::Milliseconds(600),
    base::Milliseconds(1000), base::Milliseconds(2000)};
constexpr gfx::Size kPillSize(236, 48);
constexpr int kPillTopInset = 10;
constexpr int kPillMargin = 8;
constexpr int kPillRadius = 16;

struct CaptureSource {
  std::string token;
  std::string media_id;
  std::string window;
  base::TimeTicks issued;
};

std::optional<CaptureSource>& PendingSource() {
  static base::NoDestructor<std::optional<CaptureSource>> source;
  return *source;
}

scoped_refptr<base::SequencedTaskRunner> RecordingFiles() {
  static base::NoDestructor<scoped_refptr<base::SequencedTaskRunner>> runner(
      base::ThreadPool::CreateSequencedTaskRunner(
          {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
           base::TaskShutdownBehavior::BLOCK_SHUTDOWN}));
  return *runner;
}

std::string SecondsText(int seconds) {
  const int minutes = seconds / 60;
  const int rest = seconds % 60;
  return base::NumberToString(minutes) + ":" + (rest < 10 ? "0" : "") +
         base::NumberToString(rest);
}

void EmitPillStop() {
  if (ModuleRegistry::Exists()) {
    ModuleRegistry::Get().Emit(kModule, "recordingPill",
                               base::Value(base::DictValue().Set("action",
                                                                 "stop")));
  }
}

class PillDot : public views::View {
  METADATA_HEADER(PillDot, views::View)

 public:
  PillDot() = default;
  PillDot(const PillDot&) = delete;
  PillDot& operator=(const PillDot&) = delete;
  ~PillDot() override = default;

  void OnPaint(gfx::Canvas* canvas) override {
    cc::PaintFlags flags;
    flags.setAntiAlias(true);
    flags.setColor(SkColorSetRGB(0xff, 0x3b, 0x30));
    canvas->DrawCircle(gfx::PointF(width() / 2.0f, height() / 2.0f),
                       std::min(width(), height()) / 2.0f, flags);
  }
};

BEGIN_METADATA(PillDot)
END_METADATA

class PillView : public views::View {
  METADATA_HEADER(PillView, views::View)

 public:
  PillView() {
    SetBackground(views::CreateRoundedRectBackground(
        SkColorSetARGB(0xd1, 0, 0, 0), kPillRadius));
    dot_ = AddChildView(std::make_unique<PillDot>());
    label_ = AddChildView(std::make_unique<views::Label>(u"Recording 0:00"));
    label_->SetEnabledColor(SK_ColorWHITE);
    label_->SetAutoColorReadabilityEnabled(false);
    label_->SetHorizontalAlignment(gfx::ALIGN_LEFT);
    stop_ = AddChildView(std::make_unique<views::LabelButton>(
        base::BindRepeating(&EmitPillStop), u"Stop"));
    stop_->SetEnabledTextColors(SK_ColorWHITE);
    stop_->SetBackground(views::CreateRoundedRectBackground(
        SkColorSetARGB(0x29, 0xff, 0xff, 0xff), 12));
    stop_->SetHorizontalAlignment(gfx::ALIGN_CENTER);
    stop_->SetAccessibleName(u"Stop recording");
  }
  PillView(const PillView&) = delete;
  PillView& operator=(const PillView&) = delete;
  ~PillView() override = default;

  void SetSeconds(int seconds) {
    label_->SetText(base::UTF8ToUTF16("Recording " + SecondsText(seconds)));
  }

  std::u16string text() const { return std::u16string(label_->GetText()); }
  gfx::Rect stop_bounds_in_screen() const {
    return stop_->GetBoundsInScreen();
  }

  void Layout(PassKey) override {
    const int middle = height() / 2;
    dot_->SetBounds(14, middle - 4, 8, 8);
    const int stop_width = 64;
    stop_->SetBounds(width() - 4 - stop_width, middle - 12, stop_width, 24);
    label_->SetBounds(32, 0, std::max(stop_->x() - 32 - 8, 0), height());
  }

 private:
  raw_ptr<PillDot> dot_ = nullptr;
  raw_ptr<views::Label> label_ = nullptr;
  raw_ptr<views::LabelButton> stop_ = nullptr;
};

BEGIN_METADATA(PillView)
END_METADATA

class RecordingPill : public views::WidgetObserver {
 public:
  static std::unique_ptr<RecordingPill>& Current() {
    static base::NoDestructor<std::unique_ptr<RecordingPill>> pill;
    return *pill;
  }

  explicit RecordingPill(AppWindow* over) : window_(over->id()) {
    widget_ = std::make_unique<views::Widget>();
    views::Widget::InitParams params(
        views::Widget::InitParams::CLIENT_OWNS_WIDGET,
        views::Widget::InitParams::TYPE_POPUP);
    params.parent = over->widget()->GetNativeView();
    params.opacity = views::Widget::InitParams::WindowOpacity::kTranslucent;
    params.shadow_type = views::Widget::InitParams::ShadowType::kNone;
    params.activatable = views::Widget::InitParams::Activatable::kNo;
    params.z_order = ui::ZOrderLevel::kFloatingWindow;
    params.name = "ArdiaRecordingPill";
    params.wm_class_name = "ardia";
    params.wm_class_class = "Ardia";
    widget_->Init(std::move(params));
    auto contents = std::make_unique<views::View>();
    view_ = contents->AddChildView(std::make_unique<PillView>());
    widget_->SetContentsView(std::move(contents));
    observation_.Observe(over->widget());
    Place();
    widget_->ShowInactive();
  }
  RecordingPill(const RecordingPill&) = delete;
  RecordingPill& operator=(const RecordingPill&) = delete;
  ~RecordingPill() override {
    observation_.Reset();
    widget_.reset();
  }

  void SetSeconds(int seconds) { view_->SetSeconds(seconds); }

  base::DictValue DebugState() const {
    base::DictValue state;
    const gfx::Rect bounds = widget_->GetWindowBoundsInScreen();
    state.Set("x", bounds.x());
    state.Set("y", bounds.y());
    state.Set("width", bounds.width());
    state.Set("height", bounds.height());
    state.Set("text", base::UTF16ToUTF8(view_->text()));
    const gfx::Point stop = view_->stop_bounds_in_screen().CenterPoint();
    state.Set("stopX", stop.x());
    state.Set("stopY", stop.y());
    state.Set("visible", widget_->IsVisible());
    return state;
  }

  void OnWidgetBoundsChanged(views::Widget* widget,
                             const gfx::Rect& new_bounds) override {
    Place();
  }

  void OnWidgetDestroying(views::Widget* widget) override {
    observation_.Reset();
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&EmitPillStop));
  }

 private:
  void Place() {
    AppWindow* over = AppWindows::Get().Find(window_);
    if (!over || !over->widget()) {
      return;
    }
    const gfx::Rect window = over->widget()->GetWindowBoundsInScreen();
    widget_->SetBounds(
        gfx::Rect(window.x() + (window.width() - kPillSize.width()) / 2,
                  window.y() + kPillTopInset, kPillSize.width(),
                  kPillSize.height()));
    view_->SetBounds(kPillMargin, kPillMargin,
                     kPillSize.width() - 2 * kPillMargin,
                     kPillSize.height() - 2 * kPillMargin);
  }

  std::string window_;
  std::unique_ptr<views::Widget> widget_;
  raw_ptr<PillView> view_ = nullptr;
  base::ScopedObservation<views::Widget, views::WidgetObserver> observation_{
      this};
};

void RedrawForCapture(std::string window_id) {
  AppWindow* window = AppWindows::Get().Find(window_id);
  ui::Compositor* compositor =
      window && window->widget() ? window->widget()->GetCompositor() : nullptr;
  if (compositor) {
    compositor->ScheduleFullRedraw();
  }
}

ModuleResult IssueSource(const std::string& window_id) {
  AppWindow* window = AppWindows::Get().Find(window_id);
  if (!window || !window->widget() || !window->widget()->IsVisible()) {
    return ModuleFailure("the window isn't open");
  }
  const content::DesktopMediaID media_id =
      content::DesktopMediaID::RegisterNativeWindow(
          content::DesktopMediaID::TYPE_WINDOW,
          window->widget()->GetNativeWindow());
  if (media_id.is_null()) {
    return ModuleFailure("the window can't be captured");
  }
  CaptureSource source;
  source.token = base::Token::CreateRandom().ToString();
  source.media_id = media_id.ToString();
  source.window = window_id;
  source.issued = base::TimeTicks::Now();
  std::string token = source.token;
  PendingSource() = std::move(source);
  for (const base::TimeDelta delay : kCaptureRedraws) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE, base::BindOnce(&RedrawForCapture, window_id), delay);
  }
  return ModuleResult(base::Value(std::move(token)));
}

ModuleResult PageRects(const std::string& window_id) {
  AppWindow* window = AppWindows::Get().Find(window_id);
  if (!window || !window->widget()) {
    return ModuleResult(base::Value());
  }
  const gfx::Size size = window->widget()->GetWindowBoundsInScreen().size();
  base::ListValue rects;
  for (const gfx::Rect& place : Host::Get()->PagePlacesIn(window_id)) {
    rects.Append(base::DictValue()
                     .Set("x", place.x())
                     .Set("y", place.y())
                     .Set("width", place.width())
                     .Set("height", place.height()));
  }
  return ModuleResult(base::Value(base::DictValue()
                                      .Set("width", size.width())
                                      .Set("height", size.height())
                                      .Set("rects", std::move(rects))));
}

int64_t AppendBytes(base::FilePath path,
                    std::vector<uint8_t> bytes,
                    bool truncate) {
  if (!base::CreateDirectory(path.DirName())) {
    return -1;
  }
  base::File file(path, base::File::FLAG_OPEN_ALWAYS | base::File::FLAG_APPEND);
  if (!file.IsValid() || (truncate && !file.SetLength(0))) {
    return -1;
  }
  if (!bytes.empty() && !file.WriteAtCurrentPosAndCheck(bytes)) {
    return -1;
  }
  return file.GetLength();
}

void WriteChunk(base::ListValue args, ModuleReply reply, bool truncate) {
  std::optional<base::FilePath> path =
      ReportPathInside(ReportsFolder(), StringArg(args, 0));
  std::optional<std::vector<uint8_t>> bytes =
      base::Base64Decode(StringArg(args, 1));
  if (!path || !bytes) {
    std::move(reply).Run(ModuleFailure("the recording can't be written there"));
    return;
  }
  const std::string value = path->value();
  RecordingFiles()->PostTaskAndReplyWithResult(
      FROM_HERE,
      base::BindOnce(&AppendBytes, *path, std::move(*bytes), truncate),
      base::BindOnce(
          [](std::string value, ModuleReply reply, int64_t size) {
            if (size < 0) {
              std::move(reply).Run(
                  ModuleFailure("the recording couldn't be written"));
              return;
            }
            NoteReportFileSize(value, size);
            std::move(reply).Run(base::Value(static_cast<double>(size)));
          },
          value, std::move(reply)));
}

int64_t CopyFile(base::FilePath from, base::FilePath to) {
  if (!base::PathExists(from) || !base::CreateDirectory(to.DirName()) ||
      !base::CopyFile(from, to)) {
    return -1;
  }
  return base::GetFileSize(to).value_or(-1);
}

void CopyThumbnail(base::ListValue args, ModuleReply reply) {
  std::optional<base::FilePath> recording =
      ReportPathInside(ReportsFolder(), StringArg(args, 0));
  std::optional<base::FilePath> out =
      ReportPathInside(ReportsFolder(), StringArg(args, 1));
  if (!recording || !out) {
    std::move(reply).Run(base::Value(false));
    return;
  }
  const base::FilePath made(recording->value() + ".thumbnail.png");
  RecordingFiles()->PostTaskAndReplyWithResult(
      FROM_HERE, base::BindOnce(&CopyFile, made, *out),
      base::BindOnce(
          [](std::string value, ModuleReply reply, int64_t size) {
            if (size >= 0) {
              NoteReportFileSize(value, size);
            }
            std::move(reply).Run(base::Value(size >= 0));
          },
          out->value(), std::move(reply)));
}

}

void AddRecordingMethods(ModuleRegistry::Module& module) {
  module
      .Async("recordingSource", AnswerOf([](const base::ListValue& args) {
               return IssueSource(StringArg(args, 0));
             }))
      .Sync("recordingPageRects", SyncOf([](const base::ListValue& args) {
              return PageRects(StringArg(args, 0));
            }))
      .Async("writeRecording",
             AsyncOf([](base::ListValue args, ModuleReply reply) {
               WriteChunk(std::move(args), std::move(reply), true);
             }))
      .Async("appendRecording",
             AsyncOf([](base::ListValue args, ModuleReply reply) {
               WriteChunk(std::move(args), std::move(reply), false);
             }))
      .Async("recordingThumbnail",
             AsyncOf([](base::ListValue args, ModuleReply reply) {
               CopyThumbnail(std::move(args), std::move(reply));
             }))
      .Sync("showRecordingPill", SyncOf([](const base::ListValue& args) {
              AppWindow* window = AppWindows::Get().Find(StringArg(args, 0));
              RecordingPill::Current().reset();
              if (window && window->widget() &&
                  !ardiacore::BackgroundInstance()) {
                RecordingPill::Current() =
                    std::make_unique<RecordingPill>(window);
              }
              return ModuleResult(
                  base::Value(RecordingPill::Current() != nullptr));
            }))
      .Sync("setRecordingSeconds", SyncOf([](const base::ListValue& args) {
              if (RecordingPill::Current()) {
                RecordingPill::Current()->SetSeconds(
                    static_cast<int>(NumberArg(args, 0)));
              }
              return ModuleResult(base::Value());
            }))
      .Sync("hideRecordingPill", SyncOf([](const base::ListValue&) {
              RecordingPill::Current().reset();
              return ModuleResult(base::Value());
            }))
      .Sync("recordingPillState", SyncOf([](const base::ListValue&) {
              return ModuleResult(
                  RecordingPill::Current()
                      ? base::Value(RecordingPill::Current()->DebugState())
                      : base::Value());
            }))
      .Sync("noteRecording", SyncOf([](const base::ListValue& args) {
              const std::string outcome = StringArg(args, 0);
              if (outcome == "started") {
                CountLinux("report_recordings_started");
              } else if (outcome == "failed") {
                CountLinux("report_recording_failures");
              }
              Note("report", "recording " + outcome);
              return ModuleResult(base::Value());
            }));
}

bool AnswerRecordingMediaRequest(content::WebContents* host,
                                 const content::MediaStreamRequest& request,
                                 content::MediaResponseCallback& callback) {
  std::optional<CaptureSource> source = std::move(PendingSource());
  PendingSource().reset();
  content::RenderFrameHost* frame = content::RenderFrameHost::FromID(
      request.render_process_id, request.render_frame_id);
  const bool from_host = frame && host &&
                         content::WebContents::FromRenderFrameHost(frame) ==
                             host &&
                         frame == host->GetPrimaryMainFrame();
  const bool asks_for_source =
      request.video_type ==
          blink::mojom::MediaStreamType::GUM_DESKTOP_VIDEO_CAPTURE &&
      request.audio_type == blink::mojom::MediaStreamType::NO_SERVICE &&
      !request.requested_video_device_ids.empty();
  if (!from_host || !asks_for_source || !source ||
      base::TimeTicks::Now() - source->issued > kSourceLifetime ||
      request.requested_video_device_ids.front() != source->token ||
      !AppWindows::Get().Find(source->window)) {
    Note("report", "refused a capture request from the UI host");
    std::move(callback).Run(
        blink::mojom::StreamDevicesSet(),
        blink::mojom::MediaStreamRequestResult::PERMISSION_DENIED, nullptr);
    return true;
  }
  blink::mojom::StreamDevicesSet devices;
  devices.stream_devices.emplace_back(blink::mojom::StreamDevices::New());
  devices.stream_devices[0]->video_device = blink::MediaStreamDevice(
      blink::mojom::MediaStreamType::GUM_DESKTOP_VIDEO_CAPTURE,
      source->media_id, "Ardia window");
  std::move(callback).Run(devices, blink::mojom::MediaStreamRequestResult::OK,
                          nullptr);
  return true;
}

bool RecordingTakesKey(const input::NativeWebKeyboardEvent& event) {
  const int modifiers = event.GetModifiers() &
                        (blink::WebInputEvent::kShiftKey |
                         blink::WebInputEvent::kControlKey |
                         blink::WebInputEvent::kAltKey |
                         blink::WebInputEvent::kMetaKey);
  if (!RecordingPill::Current() ||
      event.GetType() != blink::WebInputEvent::Type::kRawKeyDown ||
      event.windows_key_code != ui::VKEY_ESCAPE || modifiers) {
    return false;
  }
  EmitPillStop();
  return true;
}

}
