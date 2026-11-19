// fanotes-pen-uinput: a virtual pen tablet through /dev/uinput, for the S1 pen
// probe. It creates the device, prints "ready <sysname>" and then reads
// commands from stdin:
//   stroke <x0> <y0> <x1> <y1> <steps> <pressure 0..4095> <tilt -64..63>
//     pen in range, down, moves in <steps> steps, up, out of range
//   quit
// Coordinates are device units, 0..32767 on both axes (mapped to the screen).
#include <fcntl.h>
#include <linux/uinput.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int fd;

static void emit(int type, int code, int value) {
  struct input_event event;
  memset(&event, 0, sizeof event);
  event.type = type;
  event.code = code;
  event.value = value;
  if (write(fd, &event, sizeof event) != sizeof event) perror("write");
}

static void sync_frame(void) { emit(EV_SYN, SYN_REPORT, 0); }

static void absinfo(int code, int min, int max, int resolution) {
  struct uinput_abs_setup setup;
  memset(&setup, 0, sizeof setup);
  setup.code = code;
  setup.absinfo.minimum = min;
  setup.absinfo.maximum = max;
  setup.absinfo.resolution = resolution;
  if (ioctl(fd, UI_ABS_SETUP, &setup) < 0) perror("UI_ABS_SETUP");
}

int main(void) {
  fd = open("/dev/uinput", O_WRONLY | O_NONBLOCK);
  if (fd < 0) { perror("/dev/uinput"); return 1; }
  ioctl(fd, UI_SET_EVBIT, EV_KEY);
  ioctl(fd, UI_SET_EVBIT, EV_ABS);
  ioctl(fd, UI_SET_EVBIT, EV_SYN);
  ioctl(fd, UI_SET_KEYBIT, BTN_TOOL_PEN);
  ioctl(fd, UI_SET_KEYBIT, BTN_TOUCH);
  ioctl(fd, UI_SET_KEYBIT, BTN_STYLUS);
  ioctl(fd, UI_SET_ABSBIT, ABS_X);
  ioctl(fd, UI_SET_ABSBIT, ABS_Y);
  ioctl(fd, UI_SET_ABSBIT, ABS_PRESSURE);
  ioctl(fd, UI_SET_ABSBIT, ABS_TILT_X);
  ioctl(fd, UI_SET_ABSBIT, ABS_TILT_Y);
  ioctl(fd, UI_SET_PROPBIT, INPUT_PROP_DIRECT);
  absinfo(ABS_X, 0, 32767, 100);
  absinfo(ABS_Y, 0, 32767, 100);
  absinfo(ABS_PRESSURE, 0, 4095, 0);
  absinfo(ABS_TILT_X, -64, 63, 57);
  absinfo(ABS_TILT_Y, -64, 63, 57);
  struct uinput_setup setup;
  memset(&setup, 0, sizeof setup);
  setup.id.bustype = BUS_USB;
  setup.id.vendor = 0x056a; // a Wacom-like id so libinput treats it as a tablet
  setup.id.product = 0x0357;
  strcpy(setup.name, "FaNotes S1 virtual pen");
  if (ioctl(fd, UI_DEV_SETUP, &setup) < 0) { perror("UI_DEV_SETUP"); return 1; }
  if (ioctl(fd, UI_DEV_CREATE) < 0) { perror("UI_DEV_CREATE"); return 1; }
  char name[64] = {0};
  ioctl(fd, UI_GET_SYSNAME(sizeof name), name);
  printf("ready %s\n", name);
  fflush(stdout);
  char line[256];
  while (fgets(line, sizeof line, stdin)) {
    int x0, y0, x1, y1, steps, pressure, tilt;
    if (!strncmp(line, "quit", 4)) break;
    if (sscanf(line, "stroke %d %d %d %d %d %d %d", &x0, &y0, &x1, &y1, &steps, &pressure, &tilt) == 7) {
      emit(EV_ABS, ABS_X, x0); emit(EV_ABS, ABS_Y, y0); emit(EV_ABS, ABS_TILT_X, tilt); emit(EV_ABS, ABS_TILT_Y, -tilt);
      emit(EV_KEY, BTN_TOOL_PEN, 1); sync_frame(); usleep(20000);
      emit(EV_ABS, ABS_PRESSURE, pressure); emit(EV_KEY, BTN_TOUCH, 1); sync_frame(); usleep(8000);
      for (int step = 1; step <= steps; step += 1) {
        emit(EV_ABS, ABS_X, x0 + (x1 - x0) * step / steps);
        emit(EV_ABS, ABS_Y, y0 + (y1 - y0) * step / steps);
        emit(EV_ABS, ABS_PRESSURE, pressure / 2 + (pressure / 2) * step / steps);
        sync_frame();
        usleep(5000);
      }
      emit(EV_ABS, ABS_PRESSURE, 0); emit(EV_KEY, BTN_TOUCH, 0); sync_frame(); usleep(8000);
      emit(EV_KEY, BTN_TOOL_PEN, 0); sync_frame();
      printf("ok\n");
      fflush(stdout);
    }
  }
  ioctl(fd, UI_DEV_DESTROY);
  close(fd);
  return 0;
}
