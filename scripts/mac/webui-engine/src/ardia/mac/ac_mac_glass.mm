#include "ardia/mac/ac_mac_glass.h"

#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>

#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>

#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/task/sequenced_task_runner.h"
#include "ui/compositor/layer.h"
#include "ui/compositor/layer_not_drawn.h"
#include "ui/compositor/layer_solid_color.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/rect_conversions.h"
#include "ui/gfx/geometry/rect_f.h"
#include "ui/gfx/geometry/rounded_corners_f.h"
#include "ui/views/view.h"
#include "ui/views/widget/widget.h"

@interface ArdiaMacGlassSlotView : NSView
@end

@implementation ArdiaMacGlassSlotView

- (BOOL)isFlipped {
  return YES;
}

- (NSView*)hitTest:(NSPoint)point {
  return nil;
}

- (BOOL)acceptsFirstResponder {
  return NO;
}

@end

@interface ArdiaMacVibrancyView : NSVisualEffectView
@property(nonatomic) BOOL windowTreatment;
- (void)applyTreatment;
@end

@implementation ArdiaMacVibrancyView

@synthesize windowTreatment = _windowTreatment;

- (void)applyTreatment {
  self.emphasized = self.windowTreatment;
  if (!self.windowTreatment) {
    return;
  }
  const bool dark = [[self.effectiveAppearance bestMatchFromAppearancesWithNames:@[
    NSAppearanceNameDarkAqua, NSAppearanceNameAqua
  ]] isEqualToString:NSAppearanceNameDarkAqua];
  self.material = static_cast<NSVisualEffectMaterial>(
      ardia_mac::glass::TreatmentMaterial(dark));
  self.state = NSVisualEffectStateFollowsWindowActiveState;
}

- (void)viewDidChangeEffectiveAppearance {
  [super viewDidChangeEffectiveAppearance];
  [self applyTreatment];
}

@end

namespace ardia_mac {

namespace {

Class GlassEffectClass() {
  return NSClassFromString(@"NSGlassEffectView");
}

Class GlassContainerClass() {
  return NSClassFromString(@"NSGlassEffectContainerView");
}

NSString* const kTintLayer = @"ardia.tint";

NSColor* ColorOf(const std::optional<glass::Color>& color) {
  if (!color) return nil;
  return [NSColor colorWithSRGBRed:color->red green:color->green blue:color->blue alpha:color->alpha];
}

NSAppearance* AppearanceOf(glass::Appearance appearance) {
  switch (appearance) {
    case glass::Appearance::kLight:
      return [NSAppearance appearanceNamed:NSAppearanceNameAqua];
    case glass::Appearance::kDark:
      return [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    case glass::Appearance::kAuto:
      return nil;
  }
  return nil;
}

void ApplyTintLayer(NSView* view, const std::optional<glass::Color>& tint, double radius) {
  view.wantsLayer = YES;
  CALayer* found = nil;
  for (CALayer* layer in view.layer.sublayers) {
    if ([layer.name isEqualToString:kTintLayer]) {
      found = layer;
      break;
    }
  }
  if (!tint) {
    [found removeFromSuperlayer];
    return;
  }
  if (!found) {
    found = [CALayer layer];
    found.name = kTintLayer;
    [view.layer addSublayer:found];
  }
  found.frame = view.layer.bounds;
  found.cornerRadius = radius;
  found.cornerCurve = kCACornerCurveContinuous;
  found.backgroundColor = ColorOf(tint).CGColor;
}

NSVisualEffectMaterial VibrancyMaterial(glass::Material material) {
  switch (material) {
    case glass::Material::kHeader:
      return NSVisualEffectMaterialHeaderView;
    case glass::Material::kMenu:
      return NSVisualEffectMaterialMenu;
    case glass::Material::kPopover:
    case glass::Material::kLiquid:
    case glass::Material::kLiquidClear:
      return NSVisualEffectMaterialPopover;
    case glass::Material::kHud:
    case glass::Material::kWindowTreatment:
      return NSVisualEffectMaterialHUDWindow;
    case glass::Material::kWindow:
      return NSVisualEffectMaterialWindowBackground;
    case glass::Material::kUnderWindow:
      return NSVisualEffectMaterialUnderWindowBackground;
    case glass::Material::kSidebar:
      return NSVisualEffectMaterialSidebar;
  }
  return NSVisualEffectMaterialSidebar;
}

NSView* MakeEffect(const glass::Placement& placement, glass::Plane plane) {
  if (glass::EffectFor(placement.material, LiquidGlassAvailable()) ==
      glass::Effect::kLiquidGlass) {
    return [[GlassEffectClass() alloc] initWithFrame:NSZeroRect];
  }
  ArdiaMacVibrancyView* view =
      [[ArdiaMacVibrancyView alloc] initWithFrame:NSZeroRect];
  view.blendingMode = plane == glass::Plane::kBehindWindow
                          ? NSVisualEffectBlendingModeBehindWindow
                          : NSVisualEffectBlendingModeWithinWindow;
  view.state = NSVisualEffectStateActive;
  view.wantsLayer = YES;
  return view;
}

CGPathRef CornerPath(NSRect bounds, const glass::Radii& radii, bool flipped) {
  const CGFloat top = flipped ? NSMinY(bounds) : NSMaxY(bounds);
  const CGFloat bottom = flipped ? NSMaxY(bounds) : NSMinY(bounds);
  const CGFloat down = flipped ? 1 : -1;
  const CGFloat left = NSMinX(bounds);
  const CGFloat right = NSMaxX(bounds);
  CGMutablePathRef path = CGPathCreateMutable();
  CGPathMoveToPoint(path, nullptr, left + radii.upper_left, top);
  CGPathAddLineToPoint(path, nullptr, right - radii.upper_right, top);
  CGPathAddArcToPoint(path, nullptr, right, top, right, top + down * radii.upper_right, radii.upper_right);
  CGPathAddLineToPoint(path, nullptr, right, bottom - down * radii.lower_right);
  CGPathAddArcToPoint(path, nullptr, right, bottom, right - radii.lower_right, bottom, radii.lower_right);
  CGPathAddLineToPoint(path, nullptr, left + radii.lower_left, bottom);
  CGPathAddArcToPoint(path, nullptr, left, bottom, left, bottom - down * radii.lower_left, radii.lower_left);
  CGPathAddLineToPoint(path, nullptr, left, top + down * radii.upper_left);
  CGPathAddArcToPoint(path, nullptr, left, top, left + radii.upper_left, top, radii.upper_left);
  CGPathCloseSubpath(path);
  return path;
}

void ApplyCornerMask(NSView* view, const glass::CornerShape& shape) {
  view.wantsLayer = YES;
  if (shape.uniform) {
    view.layer.mask = nil;
    return;
  }
  CAShapeLayer* mask = [CAShapeLayer layer];
  mask.frame = view.bounds;
  CGPathRef path = CornerPath(view.bounds, shape.radii, view.isFlipped);
  mask.path = path;
  CGPathRelease(path);
  view.layer.mask = mask;
}

void ApplySliceMask(NSView* view, const glass::SliceMask& mask) {
  view.wantsLayer = YES;
  const glass::Rect& outline = mask.outline;
  const NSRect shape =
      NSMakeRect(outline.x, view.isFlipped ? outline.y : NSHeight(view.bounds) - outline.y - outline.height,
                 outline.width, outline.height);
  CAShapeLayer* layer = [CAShapeLayer layer];
  layer.frame = view.bounds;
  CGPathRef path = CornerPath(shape, mask.radii, view.isFlipped);
  layer.path = path;
  CGPathRelease(path);
  view.layer.mask = layer;
}

void ApplyMask(NSView* view, const glass::CornerShape& shape, const glass::SliceMask& slice) {
  if (slice.active) {
    ApplySliceMask(view, slice);
  } else {
    ApplyCornerMask(view, shape);
  }
}

void Style(NSView* view, const glass::Placement& placement) {
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  view.frame = NSMakeRect(placement.frame.x, placement.frame.y,
                          placement.frame.width, placement.frame.height);
  view.alphaValue = placement.opacity;
  view.appearance = AppearanceOf(placement.appearance);
  const glass::CornerShape shape = glass::ShapeFor(placement.radii);
  const glass::SliceMask slice = glass::MaskFor(placement);
  const double native = slice.active ? 0 : glass::NativeCornerRadius(shape);
  if ([view isKindOfClass:GlassEffectClass()]) {
    if ([view respondsToSelector:NSSelectorFromString(@"setStyle:")]) {
      [view setValue:@(glass::GlassStyle(placement.material)) forKey:@"style"];
    }
    if ([view respondsToSelector:NSSelectorFromString(@"setCornerRadius:")]) {
      [view setValue:@(native) forKey:@"cornerRadius"];
    }
    if ([view respondsToSelector:NSSelectorFromString(@"setTintColor:")]) {
      [view setValue:ColorOf(placement.tint) forKey:@"tintColor"];
    }
    ApplyMask(view, shape, slice);
  } else if ([view isKindOfClass:NSVisualEffectView.class]) {
    NSVisualEffectView* vibrancy = static_cast<NSVisualEffectView*>(view);
    vibrancy.material = VibrancyMaterial(placement.material);
    vibrancy.state = NSVisualEffectStateActive;
    if ([view isKindOfClass:ArdiaMacVibrancyView.class]) {
      ArdiaMacVibrancyView* treated = static_cast<ArdiaMacVibrancyView*>(view);
      treated.windowTreatment =
          placement.material == glass::Material::kWindowTreatment;
      [treated applyTreatment];
    }
    view.layer.cornerRadius = native;
    view.layer.cornerCurve = kCACornerCurveContinuous;
    view.layer.masksToBounds = native > 0;
    ApplyMask(view, shape, slice);
    ApplyTintLayer(view, placement.tint, native);
  }
  [CATransaction commit];
}

std::optional<double> Number(const base::DictValue* dict, std::string_view key) {
  if (!dict) return std::nullopt;
  const base::Value* value = dict->Find(key);
  if (!value) return std::nullopt;
  if (value->is_int()) return static_cast<double>(value->GetInt());
  if (value->is_double()) return value->GetDouble();
  return std::nullopt;
}

std::optional<glass::Rect> RectOf(const base::DictValue* dict) {
  const std::optional<double> x = Number(dict, "x");
  const std::optional<double> y = Number(dict, "y");
  const std::optional<double> width = Number(dict, "width");
  const std::optional<double> height = Number(dict, "height");
  if (!x || !y || !width || !height) return std::nullopt;
  return glass::Rect{*x, *y, *width, *height};
}

std::optional<glass::Region> RegionOf(const base::Value& value, glass::Layer default_layer) {
  const base::DictValue* dict = value.GetIfDict();
  if (!dict) return std::nullopt;
  glass::Region region;
  const std::string* id = dict->FindString("id");
  region.id = id ? *id : std::string();
  const std::optional<glass::Rect> rect = RectOf(dict->FindDict("rect"));
  if (!rect) return std::nullopt;
  region.rect = *rect;
  if (const base::DictValue* radii = dict->FindDict("radii")) {
    region.radii = {Number(radii, "upperLeft").value_or(0),
                    Number(radii, "upperRight").value_or(0),
                    Number(radii, "lowerRight").value_or(0),
                    Number(radii, "lowerLeft").value_or(0)};
  } else if (std::optional<double> radius = Number(dict, "radius")) {
    region.radii = {*radius, *radius, *radius, *radius};
  }
  region.opacity = Number(dict, "opacity").value_or(1);
  region.blur = Number(dict, "blur").value_or(24);
  const std::string* layer = dict->FindString("layer");
  const std::string* material = dict->FindString("material");
  const std::optional<glass::Layer> parsed_layer =
      layer ? glass::LayerNamed(*layer) : std::optional<glass::Layer>(default_layer);
  const std::optional<glass::Material> parsed_material =
      glass::MaterialNamed(material ? *material : std::string_view());
  if (!parsed_layer || !parsed_material) return std::nullopt;
  region.layer = *parsed_layer;
  region.material = *parsed_material;
  if (const base::Value* tint = dict->Find("tint")) {
    if (!tint->is_string()) return std::nullopt;
    region.tint = glass::ColorFrom(tint->GetString());
    if (!region.tint) return std::nullopt;
  }
  if (const base::Value* group = dict->Find("group")) {
    if (!group->is_string() || !glass::ValidGroup(group->GetString())) return std::nullopt;
    region.group = group->GetString();
  }
  const std::string* appearance = dict->FindString("appearance");
  const std::optional<glass::Appearance> parsed_appearance =
      glass::AppearanceNamed(appearance ? *appearance : std::string_view());
  if (!parsed_appearance) return std::nullopt;
  region.appearance = *parsed_appearance;
  return region;
}


namespace theme = backdrop_theme;

std::optional<theme::Color> ThemeColorOf(const base::Value* value) {
  const base::ListValue* list = value ? value->GetIfList() : nullptr;
  if (!list || list->size() != 5) return std::nullopt;
  std::array<double, 5> parts{};
  for (std::size_t index = 0; index < 5; ++index) {
    const base::Value& part = (*list)[index];
    if (!part.is_int() && !part.is_double()) return std::nullopt;
    parts[index] = part.GetDouble();
  }
  return theme::ColorFrom(parts);
}

std::optional<double> PointPart(const base::ListValue* point, std::size_t index) {
  if (!point || point->size() != 2) return std::nullopt;
  const base::Value& value = (*point)[index];
  if (!value.is_int() && !value.is_double()) return std::nullopt;
  return theme::GradientPoint(value.GetDouble());
}

std::optional<theme::Theme> ThemeOf(const base::DictValue* dict) {
  const base::ListValue* layers = dict ? dict->FindList("layers") : nullptr;
  if (!layers || !theme::LayerCountFits(layers->size())) return std::nullopt;
  theme::Theme parsed;
  parsed.opacity = theme::Unit(Number(dict, "opacity").value_or(1));
  if (const base::DictValue* radii = dict->FindDict("radii")) {
    const char* const keys[] = {"upperLeft", "upperRight", "lowerRight", "lowerLeft"};
    for (std::size_t index = 0; index < 4; ++index) {
      parsed.radii[index] = theme::ThemeRadius(Number(radii, keys[index]).value_or(0));
    }
  }
  for (const base::Value& entry : *layers) {
    const base::DictValue* layer = entry.GetIfDict();
    const std::string* kind = layer ? layer->FindString("kind") : nullptr;
    if (!kind) return std::nullopt;
    theme::Layer out;
    out.opacity = theme::Unit(Number(layer, "opacity").value_or(1));
    if (*kind == "fill") {
      const std::optional<theme::Color> color = ThemeColorOf(layer->Find("color"));
      if (!color) return std::nullopt;
      out.kind = theme::Kind::kFill;
      out.color = *color;
    } else if (*kind == "gradient") {
      const base::ListValue* start = layer->FindList("start");
      const base::ListValue* end = layer->FindList("end");
      const base::ListValue* stops = layer->FindList("stops");
      const auto sx = PointPart(start, 0), sy = PointPart(start, 1), ex = PointPart(end, 0), ey = PointPart(end, 1);
      if (!sx || !sy || !ex || !ey || !stops || !theme::StopCountFits(stops->size())) return std::nullopt;
      out.kind = theme::Kind::kGradient;
      out.start_x = *sx;
      out.start_y = *sy;
      out.end_x = *ex;
      out.end_y = *ey;
      for (const base::Value& stop : *stops) {
        const base::DictValue* item = stop.GetIfDict();
        const std::optional<theme::Color> color = item ? ThemeColorOf(item->Find("color")) : std::nullopt;
        if (!color) return std::nullopt;
        out.stops.push_back(theme::Stop{theme::Unit(Number(item, "offset").value_or(0)), *color});
      }
    } else if (*kind == "grain") {
      const std::string* texture = layer->FindString("texture");
      if (!texture || !theme::KnownTexture(*texture)) return std::nullopt;
      out.kind = theme::Kind::kGrain;
      out.texture = *texture;
      out.points = theme::GrainPoints(Number(layer, "points").value_or(theme::kGrainSide));
    } else {
      return std::nullopt;
    }
    parsed.layers.push_back(std::move(out));
  }
  return parsed;
}

CGColorRef CreateThemeColor(const theme::Color& color) {
  NSColor* made = color.display_p3
                      ? [NSColor colorWithDisplayP3Red:color.red green:color.green blue:color.blue alpha:color.alpha]
                      : [NSColor colorWithSRGBRed:color.red green:color.green blue:color.blue alpha:color.alpha];
  return CGColorRetain(made.CGColor);
}

NSColor* GrainPattern(NSMutableDictionary<NSString*, NSColor*>* cache,
                      const std::string& texture,
                      double points,
                      double backing_scale,
                      double zoom) {
  const double scale = theme::Finite(backing_scale) && backing_scale > 0 ? backing_scale : 1;
  const int side = theme::GrainImagePixels(points, scale, zoom);
  NSString* key = [NSString stringWithFormat:@"%s:%d:%g", texture.c_str(), side, scale];
  if (NSColor* found = cache[key]) return found;
  const auto alpha = theme::GrainAlpha(texture);
  const std::size_t pixels_side = static_cast<std::size_t>(side);
  const std::size_t tile = static_cast<std::size_t>(theme::kGrainSide);
  std::vector<std::uint8_t> pixels(pixels_side * pixels_side * 4, 0);
  for (std::size_t y = 0; y < pixels_side; ++y) {
    for (std::size_t x = 0; x < pixels_side; ++x) {
      const std::size_t source = (y * tile / pixels_side) * tile + x * tile / pixels_side;
      pixels[(y * pixels_side + x) * 4 + 3] = alpha[source];
    }
  }
  CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGContextRef context = CGBitmapContextCreate(pixels.data(), pixels_side, pixels_side, 8, pixels_side * 4, space,
                                               static_cast<CGBitmapInfo>(kCGImageAlphaPremultipliedLast));
  CGImageRef image = context ? CGBitmapContextCreateImage(context) : nullptr;
  if (context) CGContextRelease(context);
  CGColorSpaceRelease(space);
  if (!image) return nil;
  NSImage* tile_image = [[NSImage alloc] initWithCGImage:image size:NSMakeSize(side / scale, side / scale)];
  CGImageRelease(image);
  NSColor* pattern = [NSColor colorWithPatternImage:tile_image];
  cache[key] = pattern;
  return pattern;
}

CALayer* MakeThemeLayer(const theme::Layer& layer,
                        NSMutableDictionary<NSString*, NSColor*>* grain_cache,
                        double backing_scale,
                        double zoom) {
  switch (layer.kind) {
    case theme::Kind::kFill: {
      CALayer* fill = [CALayer layer];
      CGColorRef color = CreateThemeColor(layer.color);
      fill.backgroundColor = color;
      CGColorRelease(color);
      fill.opacity = static_cast<float>(layer.opacity);
      return fill;
    }
    case theme::Kind::kGradient: {
      CAGradientLayer* gradient = [CAGradientLayer layer];
      NSMutableArray* colors = [NSMutableArray array];
      NSMutableArray<NSNumber*>* locations = [NSMutableArray array];
      for (const theme::Stop& stop : layer.stops) {
        CGColorRef color = CreateThemeColor(stop.color);
        [colors addObject:(__bridge id)color];
        CGColorRelease(color);
        [locations addObject:@(stop.offset)];
      }
      gradient.colors = colors;
      gradient.locations = locations;
      gradient.startPoint = CGPointMake(layer.start_x, layer.start_y);
      gradient.endPoint = CGPointMake(layer.end_x, layer.end_y);
      gradient.opacity = static_cast<float>(layer.opacity);
      return gradient;
    }
    case theme::Kind::kGrain: {
      CALayer* grain = [CALayer layer];
      grain.backgroundColor = GrainPattern(grain_cache, layer.texture, layer.points, backing_scale, zoom).CGColor;
      grain.opacity = static_cast<float>(layer.opacity);
      return grain;
    }
  }
  return [CALayer layer];
}

void ApplyThemeCorners(CALayer* group, const theme::Theme& spec) {
  const auto& r = spec.radii;
  const bool uniform = r[0] == r[1] && r[1] == r[2] && r[2] == r[3];
  if (uniform) {
    group.mask = nil;
    group.cornerRadius = r[0];
    group.cornerCurve = kCACornerCurveContinuous;
    return;
  }
  group.cornerRadius = 0;
  CAShapeLayer* mask = [CAShapeLayer layer];
  mask.frame = group.bounds;
  CGPathRef path = CornerPath(NSRectFromCGRect(group.bounds), glass::Radii{r[0], r[1], r[2], r[3]}, true);
  mask.path = path;
  CGPathRelease(path);
  group.mask = mask;
}

}

bool LiquidGlassAvailable() {
  if (@available(macOS 26, *)) {
    return GlassEffectClass() != nil;
  }
  return false;
}

bool GlassGroupsAvailable() {
  if (@available(macOS 26, *)) {
    Class container = GlassContainerClass();
    return LiquidGlassAvailable() && container &&
           [container instancesRespondToSelector:NSSelectorFromString(@"setContentView:")];
  }
  return false;
}

struct GlassRegions::Views {
  ArdiaMacGlassSlotView* behind = nil;
  ArdiaMacGlassSlotView* vibrancy = nil;
  ArdiaMacGlassSlotView* theme = nil;
  ArdiaMacGlassSlotView* glass = nil;
  std::vector<CALayer*> theme_groups;
  std::vector<std::string> theme_keys;
  NSMutableDictionary<NSString*, NSColor*>* grain_cache = [NSMutableDictionary dictionary];
  std::map<glass::SlotKey, NSView*> effects;
  std::map<glass::GroupKey, NSView*> groups;
  std::map<int, std::unique_ptr<ui::LayerNotDrawn>> page_clips;
  std::map<glass::SlotKey, std::unique_ptr<ui::LayerSolidColor>> under_shell;
  std::map<std::string, double> blur;
};

GlassRegions::GlassRegions(views::Widget* widget,
                           views::View* under_shell,
                           Presented presented)
    : widget_(widget),
      under_shell_(under_shell),
      views_(std::make_unique<Views>()),
      presented_(std::move(presented)) {}

GlassRegions::~GlassRegions() {
  Clear();
}

void GlassRegions::Clear() {
  for (auto& [key, view] : views_->effects) {
    [view removeFromSuperview];
  }
  views_->effects.clear();
  for (auto& [key, group] : views_->groups) {
    [group removeFromSuperview];
  }
  views_->groups.clear();
  views_->under_shell.clear();
  views_->page_clips.clear();
  views_->blur.clear();
  [views_->behind removeFromSuperview];
  views_->behind = nil;
  views_->vibrancy = nil;
  views_->theme = nil;
  views_->glass = nil;
  views_->theme_groups.clear();
  views_->theme_keys.clear();
  [views_->grain_cache removeAllObjects];
  themes_.clear();
  placed_.clear();
  regions_.clear();
  backdrops_.clear();
  gate_.Invalidate();
  weak_factory_.InvalidateWeakPtrs();
}

void GlassRegions::EmitPresented(glass::PresentedGate::Ticket ticket) {
  if (gate_.Live(ticket) && presented_) {
    presented_.Run(ticket.generation);
  }
}

base::Value GlassRegions::Apply(const base::DictValue& args, double shell_zoom) {
  const base::Value* generation = args.Find("generation");
  const base::ListValue* list = args.FindList("regions");
  base::DictValue reply;
  reply.Set("generation", generation ? generation->Clone() : base::Value());
  reply.Set("available", widget_ != nullptr);
  base::ListValue accepted;
  if (!list || list->size() > glass::kMaxRegions * 2) {
    reply.Set("accepted", std::move(accepted));
    return base::Value(std::move(reply));
  }
  std::vector<glass::Region> regions;
  regions.reserve(list->size());
  for (const base::Value& value : *list) {
    if (std::optional<glass::Region> region = RegionOf(value, glass::Layer::kOverPage)) {
      regions.push_back(std::move(*region));
    }
  }
  regions_ = std::move(regions);
  zoom_ = glass::SanitizedScale(shell_zoom);
  const std::optional<double> raw_generation = Number(&args, "generation");
  const std::optional<int> presentable =
      raw_generation ? glass::PresentableGeneration(*raw_generation) : std::nullopt;
  [CATransaction begin];
  const glass::Layout mounted = Relayout();
  [CATransaction commit];
  if (presentable && presented_) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&GlassRegions::EmitPresented,
                                  weak_factory_.GetWeakPtr(),
                                  gate_.Issue(*presentable)));
  }
  for (const std::string& id : glass::MountedGlass(mounted)) {
    accepted.Append(id);
  }
  reply.Set("accepted", std::move(accepted));
  return base::Value(std::move(reply));
}

base::Value GlassRegions::ApplyBackdrops(const base::DictValue& args, double shell_zoom) {
  const base::ListValue* list = args.FindList("regions");
  if (!list || list->size() > glass::kMaxRegions) {
    return base::Value(false);
  }
  std::vector<glass::Region> backdrops;
  std::vector<std::optional<backdrop_theme::Theme>> themes;
  backdrops.reserve(list->size());
  for (std::size_t index = 0; index < list->size(); ++index) {
    const base::DictValue* dict = (*list)[index].GetIfDict();
    const std::optional<glass::Rect> rect = RectOf(dict ? dict->FindDict("rect") : nullptr);
    const std::string* material = dict ? dict->FindString("material") : nullptr;
    const std::optional<glass::Material> parsed =
        glass::MaterialNamed(material ? *material : std::string_view());
    if (!rect || !parsed) {
      continue;
    }
    glass::Region region;
    region.id = backdrop_theme::BackdropId(backdrops.size());
    region.rect = *rect;
    region.layer = glass::Layer::kBehind;
    region.source = glass::Source::kBackdrop;
    region.material = *parsed;
    backdrops.push_back(std::move(region));
    themes.push_back(ThemeOf(dict->FindDict("theme")));
  }
  backdrops_ = std::move(backdrops);
  themes_ = std::move(themes);
  zoom_ = glass::SanitizedScale(shell_zoom);
  Relayout();
  return base::Value(static_cast<int>(backdrops_.size()));
}

void GlassRegions::SetSurface(const glass::Rect& shell_in_window,
                              std::vector<GlassPage> pages) {
  shell_ = shell_in_window;
  pages_ = std::move(pages);
  Relayout();
}

bool GlassRegions::MountUnderShell(const glass::Placement& placement,
                                   const glass::Rect& page) {
  ui::Layer* parent = under_shell_ ? under_shell_->layer() : nullptr;
  if (!parent) {
    return false;
  }
  auto& clip = views_->page_clips[placement.page];
  if (!clip) {
    clip = std::make_unique<ui::LayerNotDrawn>();
    clip->SetFillsBoundsOpaquely(false);
    clip->SetMasksToBounds(true);
    parent->Add(clip.get());
  }
  clip->SetBounds(gfx::ToEnclosingRect(
      gfx::RectF(page.x, page.y, page.width, page.height)));
  auto& layer = views_->under_shell[glass::KeyOf(placement)];
  if (!layer) {
    layer = std::make_unique<ui::LayerSolidColor>();
    layer->SetFillsBoundsOpaquely(false);
    clip->Add(layer.get());
  }
  const auto found = views_->blur.find(placement.id);
  const double blur = found == views_->blur.end() ? 24 : found->second;
  layer->SetColor(SkColor4f{1, 1, 1, glass::kUnderShellFill});
  layer->SetBounds(gfx::ToEnclosingRect(gfx::RectF(
      placement.frame.x, placement.frame.y, placement.frame.width,
      placement.frame.height)));
  layer->SetOpacity(static_cast<float>(placement.opacity));
  layer->SetBackgroundBlur(static_cast<float>(glass::UnderShellBlur(blur, zoom_)));
  layer->SetRoundedCornerRadius(gfx::RoundedCornersF(
      static_cast<float>(placement.radii.upper_left),
      static_cast<float>(placement.radii.upper_right),
      static_cast<float>(placement.radii.lower_right),
      static_cast<float>(placement.radii.lower_left)));
  layer->SetIsFastRoundedCorner(true);
  clip->StackAtTop(layer.get());
  return true;
}

glass::Layout GlassRegions::Relayout() {
  NSWindow* window =
      widget_ ? widget_->GetNativeWindow().GetNativeNSWindow() : nil;
  NSView* content = window.contentView;
  NSView* frame = content.superview;
  if (!content || !frame) {
    return glass::Layout{};
  }
  std::vector<glass::Page> pages;
  std::set<int> with_native_view;
  std::map<int, glass::Rect> page_rects;
  pages.reserve(pages_.size());
  for (const GlassPage& page : pages_) {
    pages.push_back(page.page);
    page_rects[page.page.id] = page.page.rect;
    if (page.view.GetNativeNSView()) {
      with_native_view.insert(page.page.id);
    }
  }
  views_->blur.clear();
  for (const glass::Region& region : regions_) {
    views_->blur[region.id] = region.blur;
  }
  const glass::Layout layout =
      glass::Lay(glass::Mounted(backdrops_, regions_),
                 glass::MountablePages(pages, with_native_view),
                 glass::Rect{0, 0, shell_.width, shell_.height}, zoom_);
  const bool liquid = LiquidGlassAvailable();
  if (!views_->behind) {
    views_->behind = [[ArdiaMacGlassSlotView alloc] initWithFrame:NSZeroRect];
    [frame addSubview:views_->behind positioned:NSWindowBelow relativeTo:content];
    for (ArdiaMacGlassSlotView* __strong* plane : {&views_->vibrancy, &views_->theme, &views_->glass}) {
      *plane = [[ArdiaMacGlassSlotView alloc] initWithFrame:NSZeroRect];
      (*plane).autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
      (*plane).wantsLayer = YES;
      [views_->behind addSubview:*plane];
    }
    views_->theme.layer.geometryFlipped = YES;
  }
  const CGFloat top = content.isFlipped
                          ? shell_.y
                          : NSHeight(content.bounds) - shell_.y - shell_.height;
  views_->behind.frame = [content
      convertRect:NSMakeRect(shell_.x, top, shell_.width, shell_.height)
           toView:frame];
  for (NSView* plane : {views_->vibrancy, views_->theme, views_->glass}) {
    plane.frame = views_->behind.bounds;
  }

  std::erase_if(views_->under_shell, [&page_rects](const auto& entry) {
    return !page_rects.contains(entry.first.page);
  });
  std::erase_if(views_->page_clips, [&page_rects](const auto& entry) {
    return !page_rects.contains(entry.first);
  });
  const bool groups_glass = GlassGroupsAvailable();
  const std::set<glass::GroupKey> live_groups =
      glass::LiveGroups(layout.placements, groups_glass);
  for (auto it = views_->groups.begin(); it != views_->groups.end();) {
    if (!live_groups.contains(it->first)) {
      [it->second removeFromSuperview];
      it = views_->groups.erase(it);
    } else {
      ++it;
    }
  }
  const auto group_for = [&](const glass::GroupKey& key) -> NSView* {
    NSView* plane = views_->glass;
    auto found = views_->groups.find(key);
    if (found == views_->groups.end()) {
      NSView* container = [[GlassContainerClass() alloc] initWithFrame:plane.bounds];
      ArdiaMacGlassSlotView* members =
          [[ArdiaMacGlassSlotView alloc] initWithFrame:plane.bounds];
      [container setValue:members forKey:@"contentView"];
      container.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
      found = views_->groups.emplace(key, container).first;
    }
    NSView* container = found->second;
    if (container.superview != plane) {
      [plane addSubview:container];
    }
    container.frame = plane.bounds;
    NSView* members = [container valueForKey:@"contentView"];
    members.frame = container.bounds;
    return members;
  };
  const auto parent_of = [&](const glass::Placement& placement) -> NSView* {
    if (glass::EffectFor(placement.material, liquid) != glass::Effect::kLiquidGlass) return views_->vibrancy;
    return glass::Grouped(placement, groups_glass) ? group_for(glass::GroupOf(placement)) : views_->glass;
  };

  LayOutThemes(layout);
  const glass::Diff diff =
      glass::DiffPlacements(placed_, layout.placements, liquid);
  for (const glass::SlotKey& key : diff.remove) {
    views_->under_shell.erase(key);
    auto found = views_->effects.find(key);
    if (found != views_->effects.end()) {
      [found->second removeFromSuperview];
      views_->effects.erase(found);
    }
  }
  for (const glass::Placement& placement : diff.create) {
    if (placement.plane != glass::Plane::kBehindWindow) continue;
    NSView* parent = parent_of(placement);
    NSView* effect = MakeEffect(placement, placement.plane);
    Style(effect, placement);
    [parent addSubview:effect];
    views_->effects[glass::KeyOf(placement)] = effect;
  }
  for (const glass::Placement& placement : diff.update) {
    auto found = views_->effects.find(glass::KeyOf(placement));
    if (found != views_->effects.end()) {
      Style(found->second, placement);
    }
  }
  std::set<glass::SlotKey> attached;
  for (const glass::Placement& placement : layout.placements) {
    const glass::SlotKey key = glass::KeyOf(placement);
    if (glass::MountsUnderShell(placement.plane)) {
      const auto page = page_rects.find(placement.page);
      if (page != page_rects.end() && MountUnderShell(placement, page->second)) {
        attached.insert(key);
      }
      continue;
    }
    auto found = views_->effects.find(key);
    if (found == views_->effects.end()) continue;
    NSView* parent = parent_of(placement);
    if (found->second.superview != parent) {
      [parent addSubview:found->second];
    } else if (!diff.create.empty()) {
      [parent addSubview:found->second positioned:NSWindowAbove relativeTo:nil];
    }
    if (found->second.superview == parent) {
      attached.insert(key);
    }
  }
  glass::Layout mounted = glass::KeepAttached(layout, attached);
  placed_ = mounted.placements;
  return mounted;
}

void GlassRegions::LayOutThemes(const glass::Layout& layout) {
  NSView* plane = views_->theme;
  if (!plane) return;
  CALayer* host = plane.layer;
  const double backing = plane.window ? plane.window.backingScaleFactor : 2;
  std::vector<std::pair<const backdrop_theme::Theme*, const glass::Placement*>> shown_themes;
  for (const glass::Placement& placement : layout.placements) {
    if (placement.source != glass::Source::kBackdrop || placement.plane != glass::Plane::kBehindWindow ||
        placement.slice != 0) {
      continue;
    }
    const std::optional<std::size_t> index = backdrop_theme::BackdropIndex(placement.id, themes_.size());
    if (!index || !themes_[*index]) {
      continue;
    }
    shown_themes.emplace_back(&*themes_[*index], &placement);
  }
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  std::size_t shown = 0;
  for (const auto& [spec, placement] : shown_themes) {
    if (views_->theme_groups.size() <= shown) {
      CALayer* group = [CALayer layer];
      group.masksToBounds = YES;
      group.anchorPoint = CGPointZero;
      [host addSublayer:group];
      views_->theme_groups.push_back(group);
      views_->theme_keys.emplace_back();
    }
    CALayer* group = views_->theme_groups[shown];
    group.hidden = NO;
    group.frame = CGRectMake(placement->frame.x, placement->frame.y, placement->frame.width, placement->frame.height);
    group.opacity = static_cast<float>(spec->opacity * placement->opacity);
    std::string key = std::to_string(backing) + "@" + std::to_string(zoom_);
    for (const backdrop_theme::Layer& layer : spec->layers) {
      key += "|" + std::to_string(static_cast<int>(layer.kind)) + ":" + std::to_string(layer.opacity) + ":" + layer.texture +
             ":" + std::to_string(layer.points) + ":" + std::to_string(layer.start_x) + "," + std::to_string(layer.start_y) +
             "," + std::to_string(layer.end_x) + "," + std::to_string(layer.end_y) + ":" + std::to_string(layer.color.red) +
             "," + std::to_string(layer.color.green) + "," + std::to_string(layer.color.blue) + "," +
             std::to_string(layer.color.alpha) + (layer.color.display_p3 ? "p" : "s");
      for (const backdrop_theme::Stop& stop : layer.stops) {
        key += ";" + std::to_string(stop.offset) + "," + std::to_string(stop.color.red) + "," +
               std::to_string(stop.color.green) + "," + std::to_string(stop.color.blue) + "," +
               std::to_string(stop.color.alpha) + (stop.color.display_p3 ? "p" : "s");
      }
    }
    if (views_->theme_keys[shown] != key) {
      views_->theme_keys[shown] = key;
      group.sublayers = nil;
      for (const backdrop_theme::Layer& layer : spec->layers) {
        [group addSublayer:MakeThemeLayer(layer, views_->grain_cache, backing, zoom_)];
      }
    }
    for (CALayer* sublayer in group.sublayers) {
      sublayer.frame = group.bounds;
    }
    ApplyThemeCorners(group, *spec);
    ++shown;
  }
  for (std::size_t index = shown; index < views_->theme_groups.size(); ++index) {
    views_->theme_groups[index].hidden = YES;
  }
  [CATransaction commit];
}

}
