#import <AppKit/AppKit.h>

#import "../ios/ArdiaFaviconAddress.h"
#import "../ios/ArdiaFaviconSessions.h"

#include <cstdio>

using namespace ardia_favicons;

static int failures = 0;

static void Expect(bool ok, const char *what) {
  if (ok) return;
  failures++;
  fprintf(stderr, "FAIL %s\n", what);
}

static NSData *Icon(int shade) {
  NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:8 pixelsHigh:8 bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO
                                                              colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
  unsigned char *pixels = rep.bitmapData;
  for (int i = 0; i < 8 * 8; i++) {
    pixels[i * 4] = (unsigned char)(shade & 255);
    pixels[i * 4 + 1] = (unsigned char)((shade >> 8) & 255);
    pixels[i * 4 + 2] = (unsigned char)(i * 3);
    pixels[i * 4 + 3] = 255;
  }
  return [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
}

static NSData *Served(NSString *address) {
  __block NSData *png = nil;
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  Load(address, ^(ArdiaFaviconDelivery *delivery) {
    [delivery deliver:^(NSData *bytes) {
      png = bytes;
    }];
    dispatch_semaphore_signal(done);
  });
  dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
  return png;
}

struct Pending {
  NSMutableArray<Resolved> *answers = [NSMutableArray array];
  int asked = 0;
};

int main() {
  @autoreleasepool {
    NSFileManager *files = NSFileManager.defaultManager;
    NSString *root = [NSTemporaryDirectory() stringByAppendingPathComponent:[@"ardia-favicon-sessions-" stringByAppendingString:NSUUID.UUID.UUIDString]];
    NSString *profileDir = [root stringByAppendingPathComponent:@"Default"];
    [files createDirectoryAtPath:profileDir withIntermediateDirectories:YES attributes:nil error:nil];
    NSString *snapshot = [profileDir stringByAppendingPathComponent:@"Ardia Launch Icons.plist"];

    __block Pending pending;
    SetResolver(^(ArdiaFaviconSession *, Kind, NSString *, Resolved done) {
      @synchronized(pending.answers) {
        pending.asked++;
        [pending.answers addObject:[done copy]];
      }
    });
    void (^answerAll)(NSData *) = ^(NSData *png) {
      NSArray<Resolved> *answers;
      @synchronized(pending.answers) {
        answers = [pending.answers copy];
        [pending.answers removeAllObjects];
      }
      for (Resolved answer in answers) answer(png);
    };

    NSString *page = @"https://a.test/x?q=1#f";
    NSString *icon = @"https://a.test/favicon.ico";

    {
      Expect(HasNoIcon(@"ardia://notes/page") && HasNoIcon(@"about:blank") && HasNoIcon(@"data:text/html,x") && HasNoIcon(@"no scheme"), "internal pages have no icon");
      Expect(!HasNoIcon(@"https://ardia.dev/") && !HasNoIcon(@"file:///tmp/a.html"), "websites and files have one");
      Expect(!AddressOf(@"0123456789abcdef01234567", Kind::icon, @"file:///a.ico", RevisionOf(Icon(1))), "an icon address names a web icon only");
      NSString *address = AddressOf(@"0123456789abcdef01234567", Kind::page, page, RevisionOf(Icon(1)));
      const Address parsed = ParseAddress(address);
      Expect(parsed.kind == Kind::page && [parsed.key isEqualToString:page], "an address names its page");
      Expect(![address containsString:@"#"] && ![address containsString:@"?q"], "the page is encoded whole");
      Expect(!ParseAddress([address stringByReplacingOccurrencesOfString:@"%3A" withString:@":"]).key, "an address in another spelling is refused");
      Expect(!ParseAddress([address stringByAppendingString:@"&x"]).key, "anything after the revision is refused");
    }

    ArdiaFaviconSession *regular = Open(@"default", @"Default", false, snapshot);
    WaitForSnapshot();
    ArdiaFaviconSession *other = Open(@"work", @"Work", false, nil);
    Expect(Open(@"default", @"Default", false, snapshot) == regular, "a profile has one session");
    Expect(regular.token.length == kTokenLength && ![regular.token isEqualToString:other.token], "each session has its own token");

    {
      NSString *address = Keep(regular, EpochOf(regular), Kind::page, page, Icon(1));
      Expect(address && Owns(regular, address) && !Owns(other, address), "an address belongs to one session");
      Expect([Served(address) isEqualToData:Icon(1)], "a kept icon is served from memory");
      Expect(!Keep(regular, EpochOf(regular), Kind::page, page, [@"not a png" dataUsingEncoding:NSUTF8StringEncoding]), "bytes that are not a PNG are refused");
      Expect(!Keep(regular, EpochOf(regular) + 1, Kind::page, page, Icon(2)), "an answer from before a forget is refused");
      NSString *forged = [address stringByReplacingOccurrencesOfString:regular.token withString:@"0123456789abcdef01234567"];
      Expect(!Served(forged), "a made-up token serves nothing");
    }

    {
      Forget(regular);
      NSString *address = AddressOf(regular.token, Kind::icon, icon, RevisionOf(Icon(3)));
      __block int delivered = 0;
      for (int i = 0; i < 3; i++)
        Load(address, ^(ArdiaFaviconDelivery *delivery) {
          [delivery deliver:^(NSData *png) {
            if ([png isEqualToData:Icon(3)]) delivered++;
          }];
        });
      Expect(pending.asked == 1, "rows sharing a missing icon ask once");
      answerAll(Icon(3));
      Expect(delivered == 3, "every row waiting for it gets it");
      pending.asked = 0;
      Expect([Served(address) isEqualToData:Icon(3)] && pending.asked == 0, "a resolved icon is kept");
    }

    {
      Forget(regular);
      NSString *address = AddressOf(regular.token, Kind::page, page, RevisionOf(Icon(4)));
      Load(address, ^(ArdiaFaviconDelivery *) {
      });
      Forget(regular);
      answerAll(Icon(4));
      pending.asked = 0;
      Load(address, ^(ArdiaFaviconDelivery *) {
      });
      Expect(pending.asked == 1, "a lookup that began before history was removed does not refill memory");
      answerAll(nil);
    }

    {
      ArdiaFaviconSession *incognito = Open(@"incognito-1", @"incognito-1", true, snapshot);
      NSString *address = Keep(incognito, EpochOf(incognito), Kind::icon, icon, Icon(5));
      __block ArdiaFaviconDelivery *held = nil;
      Load(address, ^(ArdiaFaviconDelivery *delivery) {
        held = delivery;
      });
      Expect(held != nil, "a private icon is served while its window is open");
      __block bool failed = false;
      NSString *waiting = AddressOf(incognito.token, Kind::icon, @"https://b.test/i.png", RevisionOf(Icon(6)));
      Load(waiting, ^(ArdiaFaviconDelivery *delivery) {
        failed = !delivery;
      });
      Retire(@"incognito-1");
      Expect(failed, "a request waiting when the window closes fails");
      Expect(![held deliver:^(NSData *) {
             }],
             "bytes in hand when the window closes are not delivered");
      answerAll(Icon(6));
      Expect(!Served(address), "a closed window's icons are gone");
      Expect(!Open(@"incognito-1", @"incognito-1", true, nil), "a closed window's session never reopens");
      Expect(!SaveSnapshot(incognito, @[ address ]).count, "a private window saves nothing");
      Expect(![files fileExistsAtPath:snapshot], "a private window writes nothing");
    }

    {
      Forget(regular);
      NSString *a = Keep(regular, EpochOf(regular), Kind::page, page, Icon(7));
      NSString *b = Keep(regular, EpochOf(regular), Kind::icon, icon, Icon(8));
      NSString *stale = AddressOf(regular.token, Kind::page, @"https://gone.test/", RevisionOf(Icon(1)));
      NSArray *saved = SaveSnapshot(regular, @[ a, b, a, stale ]);
      Expect([saved isEqualToArray:@[ a, b, a ]], "the launch look lists only the icons the snapshot holds");
      NSDictionary *mode = [files attributesOfItemAtPath:snapshot error:nil];
      Expect([mode[NSFilePosixPermissions] integerValue] == 0600, "the launch icons are the owner's only");
      Retire(@"default");
      Restore(@"default");
      ArdiaFaviconSession *relaunched = Open(@"default", @"Default", false, snapshot);
      pending.asked = 0;
      NSString *again = [a stringByReplacingOccurrencesOfString:regular.token withString:relaunched.token];
      Expect([Served(again) isEqualToData:Icon(7)] && pending.asked == 0, "a relaunch serves the last look's icons with no lookup");
      Expect(![relaunched.token isEqualToString:regular.token], "a relaunch makes a new token");
      Forget(relaunched);
      WaitForSnapshot();
      Expect(![files fileExistsAtPath:snapshot], "removing history removes the launch icons");
      Keep(relaunched, EpochOf(relaunched), Kind::page, page, Icon(9));
      [files removeItemAtPath:profileDir error:nil];
      Expect(!SaveSnapshot(relaunched, @[ [again stringByReplacingOccurrencesOfString:RevisionOf(Icon(7)) withString:RevisionOf(Icon(9))] ]).count, "a deleted profile saves nothing");
      Expect(![files fileExistsAtPath:profileDir], "saving never recreates a deleted profile");
    }

    {
      Limits small;
      small.regularBytes = Icon(10).length * 3;
      SetLimits(small);
      ArdiaFaviconSession *tight = Open(@"tight", @"Tight", false, nil);
      NSMutableArray *addresses = [NSMutableArray array];
      for (int i = 0; i < 6; i++) [addresses addObject:Keep(tight, EpochOf(tight), Kind::page, [NSString stringWithFormat:@"https://t.test/%d", i], Icon(10 + i))];
      Served(addresses[5]);
      Expect(Held(addresses[5]) && !Held(addresses[0]), "memory keeps the most recently used icons within its bytes");
    }

    const Counts counts = TakeCounts();
    Expect(counts.kept > 0 && counts.snapshot == 2, "counts reach telemetry");
    [files removeItemAtPath:root error:nil];
  }
  if (failures) return 1;
  printf("favicon sessions: ok\n");
  return 0;
}
