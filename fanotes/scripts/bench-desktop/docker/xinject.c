// X11 input injection for scripts/bench-desktop. One command per stdin line,
// one answer per stdout line. Times are CLOCK_MONOTONIC nanoseconds, the clock
// behind Node's process.hrtime.bigint(), so the harness can line them up with
// in-page timestamps without a wall clock.
//
//   ping                      -> ok <ns>
//   window <pid>              -> ok <window> <x> <y> <w> <h>   (top-level with _NET_WM_PID)
//   place <pid> <x> <y> <w> <h> -> ok                          (move/resize, raise, focus)
//   focus <pid>               -> ok
//   move <x> <y>              -> ok
//   click <button>            -> ok
//   key <keysym> [modifier-keysym...] -> ok <ns after the press left the client>
//
// Build: cc -O2 -o fanotes-xinject xinject.c -lX11 -lXtst
#define _POSIX_C_SOURCE 200809L
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XTest.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static Display *dpy;

static long long now_ns(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

static long window_pid(Window w) {
  static Atom pid_atom = None;
  if (pid_atom == None) pid_atom = XInternAtom(dpy, "_NET_WM_PID", True);
  if (pid_atom == None) return -1;
  Atom type;
  int format;
  unsigned long items, after;
  unsigned char *data = NULL;
  long pid = -1;
  if (XGetWindowProperty(dpy, w, pid_atom, 0, 1, False, XA_CARDINAL, &type, &format, &items, &after, &data) == Success && data) {
    if (items == 1 && format == 32) pid = (long)*(unsigned long *)data;
    XFree(data);
  }
  return pid;
}

// The largest mapped top-level (or its direct child) owned by pid.
static Window find_window(long pid, XWindowAttributes *out) {
  Window root = DefaultRootWindow(dpy), parent, *children = NULL, best = 0;
  unsigned int count = 0;
  long best_area = 0;
  if (!XQueryTree(dpy, root, &root, &parent, &children, &count)) return 0;
  for (unsigned int i = 0; i < count; i++) {
    Window candidates[64];
    int n = 0;
    candidates[n++] = children[i];
    Window r2, p2, *inner = NULL;
    unsigned int inner_count = 0;
    if (XQueryTree(dpy, children[i], &r2, &p2, &inner, &inner_count)) {
      for (unsigned int j = 0; j < inner_count && n < 64; j++) candidates[n++] = inner[j];
      if (inner) XFree(inner);
    }
    for (int k = 0; k < n; k++) {
      if (window_pid(candidates[k]) != pid) continue;
      XWindowAttributes attrs;
      if (!XGetWindowAttributes(dpy, candidates[k], &attrs) || attrs.map_state != IsViewable) continue;
      long area = (long)attrs.width * attrs.height;
      if (area > best_area) {
        best_area = area;
        best = candidates[k];
        if (out) *out = attrs;
      }
    }
  }
  if (children) XFree(children);
  return best;
}

static int keycode_for(const char *name) {
  KeySym sym = XStringToKeysym(name);
  if (sym == NoSymbol) return 0;
  return XKeysymToKeycode(dpy, sym);
}

int main(void) {
  const char *display = getenv("DISPLAY");
  dpy = XOpenDisplay(display);
  if (!dpy) {
    fprintf(stderr, "cannot open display %s\n", display ? display : "(unset)");
    return 1;
  }
  int ev, er, maj, min;
  if (!XTestQueryExtension(dpy, &ev, &er, &maj, &min)) {
    fprintf(stderr, "XTEST extension missing\n");
    return 1;
  }
  setvbuf(stdout, NULL, _IOLBF, 0);
  char line[512];
  while (fgets(line, sizeof line, stdin)) {
    char *argv[16];
    int argc = 0;
    for (char *token = strtok(line, " \t\r\n"); token && argc < 16; token = strtok(NULL, " \t\r\n")) argv[argc++] = token;
    if (!argc) continue;
    if (!strcmp(argv[0], "ping")) {
      printf("ok %lld\n", now_ns());
    } else if (!strcmp(argv[0], "window") && argc == 2) {
      XWindowAttributes attrs;
      Window w = find_window(atol(argv[1]), &attrs);
      if (!w) { printf("err no-window\n"); continue; }
      int x = 0, y = 0;
      Window child;
      XTranslateCoordinates(dpy, w, DefaultRootWindow(dpy), 0, 0, &x, &y, &child);
      printf("ok %lu %d %d %d %d\n", (unsigned long)w, x, y, attrs.width, attrs.height);
    } else if ((!strcmp(argv[0], "place") && argc == 6) || (!strcmp(argv[0], "focus") && argc == 2)) {
      Window w = find_window(atol(argv[1]), NULL);
      if (!w) { printf("err no-window\n"); continue; }
      if (argc == 6) XMoveResizeWindow(dpy, w, atoi(argv[2]), atoi(argv[3]), (unsigned)atoi(argv[4]), (unsigned)atoi(argv[5]));
      XRaiseWindow(dpy, w);
      XSetInputFocus(dpy, w, RevertToPointerRoot, CurrentTime);
      XSync(dpy, False);
      printf("ok\n");
    } else if (!strcmp(argv[0], "move") && argc == 3) {
      XTestFakeMotionEvent(dpy, -1, atoi(argv[1]), atoi(argv[2]), CurrentTime);
      XSync(dpy, False);
      printf("ok\n");
    } else if (!strcmp(argv[0], "click") && argc == 2) {
      unsigned int button = (unsigned)atoi(argv[1]);
      XTestFakeButtonEvent(dpy, button, True, CurrentTime);
      XTestFakeButtonEvent(dpy, button, False, CurrentTime);
      XSync(dpy, False);
      printf("ok\n");
    } else if (!strcmp(argv[0], "key") && argc >= 2) {
      int code = keycode_for(argv[1]);
      if (!code) { printf("err unknown-keysym\n"); continue; }
      int mods[8], mod_count = 0;
      for (int i = 2; i < argc && mod_count < 8; i++) {
        int mod = keycode_for(argv[i]);
        if (mod) mods[mod_count++] = mod;
      }
      for (int i = 0; i < mod_count; i++) XTestFakeKeyEvent(dpy, (unsigned)mods[i], True, CurrentTime);
      XTestFakeKeyEvent(dpy, (unsigned)code, True, CurrentTime);
      XFlush(dpy);
      long long sent = now_ns();
      XTestFakeKeyEvent(dpy, (unsigned)code, False, CurrentTime);
      for (int i = mod_count - 1; i >= 0; i--) XTestFakeKeyEvent(dpy, (unsigned)mods[i], False, CurrentTime);
      XSync(dpy, False);
      printf("ok %lld\n", sent);
    } else {
      printf("err unknown-command\n");
    }
  }
  XCloseDisplay(dpy);
  return 0;
}
