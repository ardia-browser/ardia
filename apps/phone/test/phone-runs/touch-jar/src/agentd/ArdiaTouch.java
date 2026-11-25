package agentd;

import java.io.BufferedReader;
import java.io.FileReader;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;

public final class ArdiaTouch {
  static long now() { return System.nanoTime() / 1_000_000L; }
  static void sleepUntil(long t) throws InterruptedException { long w; while ((w = t - now()) > 0) Thread.sleep(Math.min(w, 50)); }

  static int[] display() throws Exception {
    Object dmg = Class.forName("android.hardware.display.DisplayManagerGlobal").getMethod("getInstance").invoke(null);
    Object info = dmg.getClass().getMethod("getDisplayInfo", int.class).invoke(dmg, 0);
    Class<?> c = info.getClass();
    return new int[]{c.getField("logicalWidth").getInt(info), c.getField("logicalHeight").getInt(info), c.getField("rotation").getInt(info)};
  }
  static int[] toDevice(float x, float y, int[] d) {
    int nw = d[0], nh = d[1];
    x = Math.max(0, Math.min(nw - 1, x)); y = Math.max(0, Math.min(nh - 1, y));
    return new int[]{Math.round(x * Hid.MAX / (nw - 1)), Math.round(y * Hid.MAX / (nh - 1))};
  }
  static void waitForDevice(String name) throws Exception {
    Object im = null;
    for (String cls : new String[]{"android.hardware.input.InputManagerGlobal", "android.hardware.input.InputManager"}) {
      try { im = Class.forName(cls).getMethod("getInstance").invoke(null); break; } catch (Exception ignored) {}
    }
    long t0 = now();
    if (im == null) { Thread.sleep(600); return; }
    Method ids = im.getClass().getMethod("getInputDeviceIds");
    Method dev = im.getClass().getMethod("getInputDevice", int.class);
    while (now() - t0 < 3000) {
      for (int id : (int[]) ids.invoke(im)) {
        Object o = dev.invoke(im, id);
        if (o != null && name.equals(o.getClass().getMethod("getName").invoke(o))) {
          System.out.println("[ardia-touch-sync14] " + name + " ready in " + (now() - t0) + " ms");
          Thread.sleep(30);
          return;
        }
      }
      Thread.sleep(15);
    }
    throw new IllegalStateException(name + " did not show up");
  }

  static void stroke(Hid t, int[] d, float x1, float y1, float x2, float y2, long ms) throws Exception {
    int steps = Math.max(1, (int) (ms / 8));
    long start = now();
    for (int i = 0; i <= steps; i++) {
      float f = (float) i / steps;
      int[] u = toDevice(x1 + (x2 - x1) * f, y1 + (y2 - y1) * f, d);
      t.send(Hid.touchReport(new int[][]{{1, u[0], u[1]}}));
      long wait = start + (long) (ms * (i + 1.0) / (steps + 1)) - now();
      if (wait > 0) Thread.sleep(wait);
    }
    t.send(Hid.touchReport(new int[][]{{0, 0, 0}}));
  }

  public static void main(String[] a) throws Exception {
    List<String[]> steps = new ArrayList<>();
    try (BufferedReader r = new BufferedReader(new FileReader(a[0]))) {
      String l; while ((l = r.readLine()) != null) { l = l.trim(); if (l.isEmpty() || l.startsWith("#")) continue; steps.add(l.split("\\s+")); }
    }
    Hid t = new Hid("ardia timed touch", 0x7A13, Hid.touchDesc());
    try {
      waitForDevice(t.name);
      int[] d = display();
      if (d[2] != 0) throw new IllegalStateException("rotation " + d[2] + ", expected portrait");
      System.out.println("ready"); System.out.flush();
      long t0 = now();
      StringBuilder log = new StringBuilder();
      for (String[] s : steps) {
        long at = Long.parseLong(s[0]);
        sleepUntil(t0 + at);
        long started = now() - t0;
        log.append(' ').append(at).append("->").append(started);
        if (s[1].equals("tap")) stroke(t, d, Float.parseFloat(s[2]), Float.parseFloat(s[3]), Float.parseFloat(s[2]), Float.parseFloat(s[3]), 50);
        else if (s[1].equals("swipe")) stroke(t, d, Float.parseFloat(s[2]), Float.parseFloat(s[3]), Float.parseFloat(s[4]), Float.parseFloat(s[5]), Long.parseLong(s[6]));
        else if (s[1].equals("wait")) {}
        else throw new IllegalArgumentException("unknown action " + s[1]);
      }
      System.out.println("done " + (now() - t0) + " ms; planned->started:" + log);
      Thread.sleep(200);
    } finally { t.close(); }
  }
}
