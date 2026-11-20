package agentd;

import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.concurrent.atomic.AtomicInteger;

final class Hid {
  static final int UHID_DESTROY = 1, UHID_CREATE2 = 11, UHID_INPUT2 = 12;
  static final int EVENT_SIZE = 4376, BUS_USB = 3;

  static final AtomicInteger made = new AtomicInteger();

  final String name;
  final RandomAccessFile f;
  volatile boolean open = true;

  Hid(String kind, int product, byte[] desc) throws Exception {
    byte[] r = new byte[3];
    new SecureRandom().nextBytes(r);
    String tag = android.os.Process.myPid() + "." + made.incrementAndGet() + "." + String.format("%02x%02x%02x", r[0], r[1], r[2]);
    this.name = kind + " " + tag;
    f = new RandomAccessFile("/dev/uhid", "rw");
    ByteBuffer b = ByteBuffer.allocate(EVENT_SIZE).order(ByteOrder.LITTLE_ENDIAN);
    b.putInt(0, UHID_CREATE2);

    put(b, 4, name, 128);
    put(b, 132, "agentd/" + tag, 64);
    put(b, 196, "agentd-" + tag, 64);
    b.putShort(260, (short) desc.length);
    b.putShort(262, (short) BUS_USB);
    b.putInt(264, 0x18d1);
    b.putInt(268, product);
    b.putInt(272, 1);
    b.position(280); b.put(desc);
    f.write(b.array());

    Thread t = new Thread(() -> {
      byte[] buf = new byte[EVENT_SIZE];
      try { while (open && f.read(buf) > 0) {} } catch (Exception ignored) {}
    }, "uhid-" + name);
    t.setDaemon(true);
    t.start();
  }

  private static void put(ByteBuffer b, int at, String s, int size) {
    byte[] n = s.getBytes(StandardCharsets.UTF_8);
    b.position(at); b.put(n, 0, Math.min(n.length, size - 1));
  }

  synchronized void send(byte[] report) throws Exception {
    ByteBuffer b = ByteBuffer.allocate(6 + report.length).order(ByteOrder.LITTLE_ENDIAN);
    b.putInt(UHID_INPUT2).putShort((short) report.length).put(report);
    f.write(b.array());
  }

  synchronized void close() {
    if (!open) return;
    open = false;
    try {
      ByteBuffer b = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(UHID_DESTROY);
      f.write(b.array());
    } catch (Exception ignored) {}
    try { f.close(); } catch (Exception ignored) {}
  }

  static final int MAX = 32767, FINGERS = 2;

  static byte[] touchDesc() {
    ByteBuffer b = ByteBuffer.allocate(256);
    b.put(new byte[]{0x05, 0x0D, 0x09, 0x04, (byte) 0xA1, 0x01});
    for (int i = 0; i < FINGERS; i++) {
      b.put(new byte[]{
        0x09, 0x22, (byte) 0xA1, 0x02,
        0x09, 0x42, 0x09, 0x32, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, (byte) 0x95, 0x02, (byte) 0x81, 0x02,
        0x75, 0x06, (byte) 0x95, 0x01, (byte) 0x81, 0x03,
        0x09, 0x51, 0x15, 0x00, 0x25, 0x0A, 0x75, 0x08, (byte) 0x95, 0x01, (byte) 0x81, 0x02,
        0x05, 0x01, 0x09, 0x30, 0x09, 0x31, 0x15, 0x00, 0x26, (byte) 0xFF, 0x7F, 0x75, 0x10, (byte) 0x95, 0x02, (byte) 0x81, 0x02,
        (byte) 0xC0,
        0x05, 0x0D,
      });
    }
    b.put(new byte[]{0x09, 0x54, 0x15, 0x00, 0x25, 0x0A, 0x75, 0x08, (byte) 0x95, 0x01, (byte) 0x81, 0x02, (byte) 0xC0});
    byte[] out = new byte[b.position()];
    b.flip(); b.get(out);
    return out;
  }

  static byte[] touchReport(int[][] fingers) {
    ByteBuffer b = ByteBuffer.allocate(6 * FINGERS + 1).order(ByteOrder.LITTLE_ENDIAN);
    int count = 0;
    for (int i = 0; i < FINGERS; i++) {
      int[] p = i < fingers.length ? fingers[i] : null;
      if (p != null) count++;
      b.put((byte) (p != null && p[0] == 1 ? 0x03 : 0x00));
      b.put((byte) i);
      b.putShort((short) (p != null ? p[1] : 0));
      b.putShort((short) (p != null ? p[2] : 0));
    }
    b.put((byte) Math.max(count, 1));
    return b.array();
  }

  static byte[] keyboardDesc() {
    return new byte[]{
      0x05, 0x01, 0x09, 0x06, (byte) 0xA1, 0x01,
      0x05, 0x07, 0x19, (byte) 0xE0, 0x29, (byte) 0xE7, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, (byte) 0x95, 0x08, (byte) 0x81, 0x02,
      0x75, 0x08, (byte) 0x95, 0x01, (byte) 0x81, 0x03,
      0x05, 0x07, 0x19, 0x00, 0x2A, (byte) 0xFF, 0x00, 0x15, 0x00, 0x26, (byte) 0xFF, 0x00, 0x75, 0x08, (byte) 0x95, 0x06, (byte) 0x81, 0x00,
      (byte) 0xC0,
    };
  }

  static byte[] keyReport(int modifiers, int usage) {
    return new byte[]{(byte) modifiers, 0, (byte) usage, 0, 0, 0, 0, 0};
  }

  static final int SHIFT = 0x02;

  static int usageForKeycode(int code) {
    if (code >= 29 && code <= 54) return 0x04 + (code - 29);
    if (code >= 8 && code <= 16) return 0x1E + (code - 8);
    if (code == 7) return 0x27;
    if (code >= 131 && code <= 142) return 0x3A + (code - 131);
    switch (code) {
      case 66: return 0x28;
      case 111: return 0x29;
      case 4: return 0x29;
      case 67: return 0x2A;
      case 61: return 0x2B;
      case 62: return 0x2C;
      case 112: return 0x4C;
      case 22: return 0x4F;
      case 21: return 0x50;
      case 20: return 0x51;
      case 19: return 0x52;
      case 122: return 0x4A;
      case 123: return 0x4D;
      case 92: return 0x4B;
      case 93: return 0x4E;
      case 82: return 0x76;
      case 26: return 0x66;
      case 24: return 0x80;
      case 25: return 0x81;
      case 164: return 0x7F;
      default: return -1;
    }
  }

  static int[] usageForChar(char c) {
    if (c >= 'a' && c <= 'z') return new int[]{0, 0x04 + (c - 'a')};
    if (c >= 'A' && c <= 'Z') return new int[]{SHIFT, 0x04 + (c - 'A')};
    if (c >= '1' && c <= '9') return new int[]{0, 0x1E + (c - '1')};
    String plain = "0\n\t -=[]\\;'`,./";
    int[] plainU = {0x27, 0x28, 0x2B, 0x2C, 0x2D, 0x2E, 0x2F, 0x30, 0x31, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38};
    int i = plain.indexOf(c);
    if (i >= 0) return new int[]{0, plainU[i]};
    String shifted = ")!@#$%^&*(_+{}|:\"~<>?";
    int[] shiftedU = {0x27, 0x1E, 0x1F, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x2D, 0x2E, 0x2F, 0x30, 0x31, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38};
    i = shifted.indexOf(c);
    if (i >= 0) return new int[]{SHIFT, shiftedU[i]};
    return null;
  }
}
