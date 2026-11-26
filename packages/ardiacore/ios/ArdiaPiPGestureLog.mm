#import "ArdiaPiPGestureLog.h"

namespace ardia_pip {

namespace {

constexpr NSUInteger kGestureLogLength = 60;

NSMutableArray<NSString *> *GestureLines() {
  static NSMutableArray<NSString *> *lines = [NSMutableArray array];
  return lines;
}

}

void NoteGesture(NSString *format, ...) {
  static NSDateFormatter *clock = [] {
    NSDateFormatter *formatter = [[NSDateFormatter alloc] init];
    formatter.dateFormat = @"HH:mm:ss.SSS";
    return formatter;
  }();
  va_list arguments;
  va_start(arguments, format);
  NSString *what = [[NSString alloc] initWithFormat:format arguments:arguments];
  va_end(arguments);
  NSMutableArray<NSString *> *lines = GestureLines();
  @synchronized(lines) {
    [lines addObject:[NSString stringWithFormat:@"%@ %@", [clock stringFromDate:NSDate.date], what]];
    if (lines.count > kGestureLogLength) [lines removeObjectAtIndex:0];
  }
}

NSString *GestureLog() {
  NSMutableArray<NSString *> *lines = GestureLines();
  @synchronized(lines) {
    return [lines componentsJoinedByString:@"\n"];
  }
}

}
