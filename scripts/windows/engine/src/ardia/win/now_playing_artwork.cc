#include "ardia/win/now_playing_artwork.h"

#include <algorithm>
#include <cstdint>
#include <utility>

#include "base/base64.h"
#include "base/functional/bind.h"
#include "base/location.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/time/time.h"
#include "content/common/content_export.h"
#include "content/public/browser/media_session.h"
#include "content/public/browser/web_contents.h"
#include "skia/ext/image_operations.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/gfx/codec/png_codec.h"
#include "url/gurl.h"

namespace content {
CONTENT_EXPORT std::vector<media_session::MediaImage>
ArdiaWinMediaSessionArtwork(WebContents* contents);
}

namespace ardia_win {

namespace {

constexpr size_t kImageUrlLimit = 1 << 20;
constexpr size_t kLongestReportedUrl = 2048;
constexpr int kMostImagePixels = 512;
constexpr base::TimeDelta kDeadline = base::Seconds(30);
constexpr char kTokenPrefix[] = "ardia-artwork:";

bool AllowedImage(const GURL& url) {
  if (!url.is_valid() || url.spec().size() > kImageUrlLimit) {
    return false;
  }
  return url.SchemeIsHTTPOrHTTPS() ||
         base::StartsWith(url.spec(), "data:image/",
                          base::CompareCase::INSENSITIVE_ASCII);
}

base::DictValue NoImage() {
  base::DictValue result;
  result.Set("uri", base::Value());
  return result;
}

std::optional<SkBitmap> InNativeOrder(const SkBitmap& bitmap) {
  if (bitmap.colorType() == kN32_SkColorType) {
    return bitmap;
  }
  SkBitmap converted;
  const SkImageInfo info = bitmap.info().makeColorType(kN32_SkColorType);
  if (!converted.tryAllocPixels(info) ||
      !bitmap.readPixels(info, converted.getPixels(), converted.rowBytes(), 0,
                         0)) {
    return std::nullopt;
  }
  return converted;
}

base::DictValue ImageOf(const SkBitmap& downloaded, int pixels) {
  if (downloaded.drawsNothing() || downloaded.width() <= 0 ||
      downloaded.height() <= 0) {
    return NoImage();
  }
  std::optional<SkBitmap> bitmap = InNativeOrder(downloaded);
  if (!bitmap) {
    return NoImage();
  }
  const int longest = std::max(bitmap->width(), bitmap->height());
  if (longest > pixels) {
    const double scale = static_cast<double>(pixels) / longest;
    const int width = std::max(1, static_cast<int>(bitmap->width() * scale));
    const int height = std::max(1, static_cast<int>(bitmap->height() * scale));
    bitmap = skia::ImageOperations::Resize(
        *bitmap, skia::ImageOperations::RESIZE_BEST, width, height);
  }
  std::optional<std::vector<uint8_t>> png =
      gfx::PNGCodec::EncodeBGRASkBitmap(*bitmap, false);
  if (!png) {
    return NoImage();
  }
  base::DictValue result;
  result.Set("uri", "data:image/png;base64," + base::Base64Encode(*png));
  result.Set("width", bitmap->width());
  result.Set("height", bitmap->height());
  return result;
}

}

NowPlayingArtwork::NowPlayingArtwork(content::WebContents& contents)
    : contents_(contents) {}

NowPlayingArtwork::~NowPlayingArtwork() {
  AnswerAll();
}

std::vector<media_session::MediaImage> NowPlayingArtwork::Declared() const {
  std::vector<media_session::MediaImage> declared =
      content::ArdiaWinMediaSessionArtwork(&*contents_);
  std::erase_if(declared, [](const media_session::MediaImage& image) {
    return !AllowedImage(image.src);
  });
  return declared;
}

bool NowPlayingArtwork::StillDeclared(
    const media_session::MediaImage& image) const {
  return std::ranges::contains(Declared(), image);
}

void NowPlayingArtwork::PageChanged() {
  long_url_.clear();
  long_token_.clear();
}

std::string NowPlayingArtwork::Reported(const std::string& url) {
  if (url.size() <= kLongestReportedUrl) {
    return url;
  }
  if (url != long_url_) {
    long_url_ = url;
    long_token_ = kTokenPrefix + base::NumberToString(++tokens_);
  }
  return long_token_;
}

void NowPlayingArtwork::Download(const std::string& asked,
                                 int pixels,
                                 Reply reply) {
  const GURL url(!long_token_.empty() && asked == long_token_ ? long_url_
                                                              : asked);
  const std::vector<media_session::MediaImage> declared = Declared();
  const auto image = std::ranges::find(declared, url,
                                       &media_session::MediaImage::src);
  if (image == declared.end()) {
    Answer(std::move(reply), NoImage());
    return;
  }
  Ask ask{*image, std::clamp(pixels, 1, kMostImagePixels), std::move(reply)};
  if (current_) {
    if (queued_) {
      Answer(std::move(queued_->reply), NoImage());
    }
    queued_ = std::move(ask);
    return;
  }
  Start(std::move(ask));
}

void NowPlayingArtwork::Start(Ask ask) {
  if (!StillDeclared(ask.image)) {
    Answer(std::move(ask.reply), NoImage());
    return;
  }
  current_ = std::move(ask);
  deadline_.Start(FROM_HERE, kDeadline,
                  base::BindOnce(&NowPlayingArtwork::TimedOut,
                                 weak_factory_.GetWeakPtr()));
  content::MediaSession::Get(&*contents_)
      ->GetMediaImageBitmap(
          current_->image, 0, current_->pixels,
          base::BindOnce(&NowPlayingArtwork::Got, weak_factory_.GetWeakPtr()));
}

void NowPlayingArtwork::Got(const SkBitmap& bitmap) {
  if (!current_) {
    return;
  }
  if (!current_->reply || !StillDeclared(current_->image)) {
    Finish(NoImage());
    return;
  }
  Finish(ImageOf(bitmap, current_->pixels));
}

void NowPlayingArtwork::TimedOut() {
  if (current_) {
    Answer(std::move(current_->reply), NoImage());
  }
}

void NowPlayingArtwork::Finish(base::DictValue result) {
  deadline_.Stop();
  std::optional<Ask> done = std::move(current_);
  current_.reset();
  if (done) {
    Answer(std::move(done->reply), std::move(result));
  }
  if (queued_) {
    Ask next = std::move(*queued_);
    queued_.reset();
    Start(std::move(next));
  }
}

void NowPlayingArtwork::Answer(Reply reply, base::DictValue result) {
  if (reply) {
    std::move(reply).Run(std::move(result));
  }
}

void NowPlayingArtwork::AnswerAll() {
  weak_factory_.InvalidateWeakPtrs();
  deadline_.Stop();
  if (current_) {
    Reply reply = std::move(current_->reply);
    current_.reset();
    Answer(std::move(reply), NoImage());
  }
  if (queued_) {
    Reply reply = std::move(queued_->reply);
    queued_.reset();
    Answer(std::move(reply), NoImage());
  }
}

}
