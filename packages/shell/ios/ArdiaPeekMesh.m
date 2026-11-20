#import "ArdiaPeekMesh.h"
#import <dlfcn.h>
#import <math.h>
#import <objc/runtime.h>

typedef struct {
  CGFloat x;
  CGFloat y;
  CGFloat z;
} ArdiaPeekMeshRawPoint;

typedef struct {
  CGPoint from;
  ArdiaPeekMeshRawPoint to;
} ArdiaPeekMeshRawVertex;

typedef struct {
  unsigned int indices[4];
  float w[4];
} ArdiaPeekMeshRawFace;

typedef id (*ArdiaPeekMeshMake)(Class, SEL, NSUInteger, const ArdiaPeekMeshRawVertex *, NSUInteger, const ArdiaPeekMeshRawFace *, NSString *);
typedef void (*ArdiaPeekMeshSet)(id, SEL, id);
typedef id (*ArdiaPeekMeshGet)(id, SEL);
typedef ArdiaPeekMeshRawVertex (*ArdiaPeekMeshRead)(id, SEL, NSUInteger);

static const NSUInteger kMaxGrid = 64;
static NSString *const kFactoryEncoding = @"@56@0:8Q16r^{CAMeshVertex={CGPoint=dd}{CAPoint3D=ddd}}24Q32r^{CAMeshFace=[4I][4f]}40@48";
static NSString *const kVertexReaderEncoding = @"{CAMeshVertex={CGPoint=dd}{CAPoint3D=ddd}}24@0:8Q16";
static NSString *const kLayerProperty = @"T@\"CAMeshTransform\",C";
static ArdiaPeekMeshTestMode gTestMode = ArdiaPeekMeshTestModeNone;
static BOOL gInspected = NO;

static NSString *Unqualified(const char *type) {
  if (!type) return @"";
  while (*type && strchr("rnNoORV", *type)) type++;
  return [NSString stringWithUTF8String:type] ?: @"";
}

static NSString *ArgumentType(Method method, unsigned int index) {
  char *type = method_copyArgumentType(method, index);
  NSString *text = Unqualified(type);
  free(type);
  return text;
}

static NSString *ReturnType(Method method) {
  char *type = method_copyReturnType(method);
  NSString *text = Unqualified(type);
  free(type);
  return text;
}

static BOOL Matches(NSString *text, NSString *pattern) {
  NSRegularExpression *regex = [NSRegularExpression regularExpressionWithPattern:pattern options:0 error:nil];
  return regex && [regex firstMatchInString:text options:0 range:NSMakeRange(0, text.length)] != nil;
}

static BOOL PointeeSize(NSString *pointer, NSUInteger expected) {
  if (![pointer hasPrefix:@"^"]) return NO;
  NSUInteger size = 0, alignment = 0;
  @try {
    NSGetSizeAndAlignment([pointer substringFromIndex:1].UTF8String, &size, &alignment);
  } @catch (NSException *) {
    return NO;
  }
  return size == expected;
}

typedef struct {
  Class meshClass;
  SEL make;
  SEL set;
  SEL get;
  IMP makeIMP;
  NSString *depth;
  NSString *reason;
} ArdiaPeekMeshRuntime;

static ArdiaPeekMeshRuntime Inspect(void) {
  ArdiaPeekMeshRuntime runtime = {0};
  Class meshClass = NSClassFromString(@"CAMeshTransform");
  if (!meshClass) return (runtime.reason = @"class", runtime);
  SEL make = NSSelectorFromString(@"meshTransformWithVertexCount:vertices:faceCount:faces:depthNormalization:");
  Method method = class_getClassMethod(meshClass, make);
  if (!method) return (runtime.reason = @"selector", runtime);
  if (method_getNumberOfArguments(method) != 7 || ![@(method_getTypeEncoding(method) ?: "") isEqualToString:kFactoryEncoding])
    return (runtime.reason = @"encoding", runtime);
  NSString *returns = ReturnType(method), *count = ArgumentType(method, 2), *vertices = ArgumentType(method, 3);
  NSString *faceCount = ArgumentType(method, 4), *faces = ArgumentType(method, 5), *depth = ArgumentType(method, 6);
  if (![returns isEqualToString:@"@"] || ![count isEqualToString:@"Q"] || ![faceCount isEqualToString:@"Q"] || ![depth isEqualToString:@"@"])
    return (runtime.reason = @"encoding", runtime);
  if (!Matches(vertices, @"^\\^\\{[A-Za-z0-9_]*=\\{CGPoint=dd\\}\\{[A-Za-z0-9_]*=ddd\\}\\}$") || !PointeeSize(vertices, sizeof(ArdiaPeekMeshRawVertex)))
    return (runtime.reason = @"layout", runtime);
  if (!Matches(faces, @"^\\^\\{[A-Za-z0-9_]*=\\[4I\\]\\[4f\\]\\}$") || !PointeeSize(faces, sizeof(ArdiaPeekMeshRawFace)))
    return (runtime.reason = @"layout", runtime);
  SEL set = NSSelectorFromString(@"setMeshTransform:"), get = NSSelectorFromString(@"meshTransform");
  Method setter = class_getInstanceMethod(CALayer.class, set), getter = class_getInstanceMethod(CALayer.class, get);
  if (!setter || !getter || method_getNumberOfArguments(setter) != 3 || ![ArgumentType(setter, 2) isEqualToString:@"@"] ||
      ![ReturnType(setter) isEqualToString:@"v"] || method_getNumberOfArguments(getter) != 2 || ![ReturnType(getter) isEqualToString:@"@"])
    return (runtime.reason = @"setter", runtime);
  objc_property_t property = class_getProperty(CALayer.class, "meshTransform");
  if (!property || ![@(property_getAttributes(property) ?: "") isEqualToString:kLayerProperty]) return (runtime.reason = @"setter", runtime);
  SEL read = NSSelectorFromString(@"vertexAtIndex:");
  Method reader = class_getInstanceMethod(meshClass, read);
  if (!reader || ![@(method_getTypeEncoding(reader) ?: "") isEqualToString:kVertexReaderEncoding]) return (runtime.reason = @"layout", runtime);
  if (![meshClass instancesRespondToSelector:NSSelectorFromString(@"CA_interpolateValue:byFraction:")]) return (runtime.reason = @"interpolation", runtime);
  NSString *__unsafe_unretained *constant = (NSString *__unsafe_unretained *)dlsym(RTLD_DEFAULT, "kCADepthNormalizationNone");
  if (!constant || ![*constant isKindOfClass:NSString.class]) return (runtime.reason = @"constant", runtime);
  runtime.meshClass = meshClass;
  runtime.make = make;
  runtime.set = set;
  runtime.get = get;
  runtime.makeIMP = method_getImplementation(method);
  runtime.depth = *constant;
  const ArdiaPeekMeshRawVertex probe[4] = {{{0, 0}, {0.125, 0.25, 0}}, {{1, 0}, {0.75, 0.0625, 0}}, {{0, 1}, {0.5, 1, 0}}, {{1, 1}, {1, 0.875, 0}}};
  const ArdiaPeekMeshRawFace face = {.indices = {0, 1, 3, 2}, .w = {0, 0, 0, 0}};
  @try {
    id mesh = ((ArdiaPeekMeshMake)runtime.makeIMP)(meshClass, make, 4, probe, 1, &face, runtime.depth);
    if (![mesh isKindOfClass:meshClass]) return (runtime.reason = @"construction", runtime);
    for (NSUInteger i = 0; i < 4; i++) {
      const ArdiaPeekMeshRawVertex back = ((ArdiaPeekMeshRead)method_getImplementation(reader))(mesh, read, i);
      if (back.from.x != probe[i].from.x || back.from.y != probe[i].from.y || back.to.x != probe[i].to.x || back.to.y != probe[i].to.y)
        return (runtime.reason = @"layout", runtime);
    }
  } @catch (NSException *) {
    return (runtime.reason = @"exception", runtime);
  }
  return runtime;
}

static const ArdiaPeekMeshRuntime *Runtime(void) {
  static ArdiaPeekMeshRuntime runtime;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    gInspected = YES;
    runtime = Inspect();
  });
  return &runtime;
}

static BOOL Finite(double v, double lo, double hi) {
  return isfinite(v) && v >= lo && v <= hi;
}

@implementation ArdiaPeekMesh

+ (BOOL)inspected {
  return gInspected;
}

+ (ArdiaPeekMeshTestMode)testMode {
  return gTestMode;
}

+ (void)setTestMode:(ArdiaPeekMeshTestMode)testMode {
  gTestMode = testMode;
}

+ (NSString *)unavailableReason {
  if (gTestMode == ArdiaPeekMeshTestModeUnavailable) return @"test";
  return Runtime()->reason;
}

+ (NSString *)applyToLayer:(CALayer *)layer points:(const ArdiaPeekMeshPoint *)points rows:(NSUInteger)rows columns:(NSUInteger)columns {
  NSString *unavailable = [self unavailableReason];
  if (unavailable) return unavailable;
  if (!layer || !points || rows < 1 || columns < 1 || rows > kMaxGrid || columns > kMaxGrid) return @"invalid";
  const ArdiaPeekMeshRuntime *runtime = Runtime();
  const NSUInteger stride = columns + 1, count = (rows + 1) * stride, faceCount = rows * columns;
  ArdiaPeekMeshRawVertex *vertices = calloc(count, sizeof(ArdiaPeekMeshRawVertex));
  ArdiaPeekMeshRawFace *faces = calloc(faceCount, sizeof(ArdiaPeekMeshRawFace));
  if (!vertices || !faces) {
    free(vertices);
    free(faces);
    return @"invalid";
  }
  NSString *failure = nil;
  for (NSUInteger i = 0; i < count && !failure; i++) {
    const ArdiaPeekMeshPoint p = points[i];
    if (!Finite(p.fromX, -1, 2) || !Finite(p.fromY, -1, 2) || !Finite(p.toX, -4, 5) || !Finite(p.toY, -4, 5)) failure = @"invalid";
    vertices[i] = (ArdiaPeekMeshRawVertex){.from = CGPointMake(p.fromX, p.fromY), .to = {p.toX, p.toY, 0}};
  }
  for (NSUInteger r = 0; r < rows && !failure; r++)
    for (NSUInteger c = 0; c < columns; c++) {
      const unsigned int a = (unsigned int)(r * stride + c), b = a + 1, d = (unsigned int)((r + 1) * stride + c), e = d + 1;
      if (e >= count) failure = @"invalid";
      faces[r * columns + c] = (ArdiaPeekMeshRawFace){.indices = {a, b, e, d}, .w = {0, 0, 0, 0}};
    }
  if (!failure) {
    @try {
      if (gTestMode == ArdiaPeekMeshTestModeThrows) [NSException raise:NSInternalInconsistencyException format:@"peekMesh=throws"];
      id mesh = ((ArdiaPeekMeshMake)runtime->makeIMP)(runtime->meshClass, runtime->make, count, vertices, faceCount, faces, runtime->depth);
      if (![mesh isKindOfClass:runtime->meshClass]) failure = @"construction";
      else ((ArdiaPeekMeshSet)[layer methodForSelector:runtime->set])(layer, runtime->set, mesh);
    } @catch (NSException *) {
      failure = @"exception";
    }
  }
  free(vertices);
  free(faces);
  if (failure) [self clearLayer:layer];
  return failure;
}

+ (void)clearLayer:(CALayer *)layer {
  const ArdiaPeekMeshRuntime *runtime = Runtime();
  if (!layer || runtime->reason) return;
  @try {
    ((ArdiaPeekMeshSet)[layer methodForSelector:runtime->set])(layer, runtime->set, nil);
  } @catch (NSException *) {
  }
}

+ (BOOL)layerHasMesh:(CALayer *)layer {
  const ArdiaPeekMeshRuntime *runtime = Runtime();
  if (!layer || runtime->reason) return NO;
  @try {
    return ((ArdiaPeekMeshGet)[layer methodForSelector:runtime->get])(layer, runtime->get) != nil;
  } @catch (NSException *) {
    return NO;
  }
}

@end
