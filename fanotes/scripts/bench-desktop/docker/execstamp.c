// execstamp <stamp-file> <program> [args...]
// Writes "<CLOCK_MONOTONIC ns> <pid>" to stamp-file, then execs the program in
// the same process. The harness uses it as "process start" for both hosts:
// Electron is spawned by the harness, Tauri by WebKitWebDriver.
// Build: cc -O2 -o fanotes-execstamp execstamp.c
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <time.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: execstamp <stamp-file> <program> [args...]\n");
    return 2;
  }
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  FILE *stamp = fopen(argv[1], "w");
  if (stamp) {
    fprintf(stamp, "%lld %ld\n", (long long)ts.tv_sec * 1000000000LL + ts.tv_nsec, (long)getpid());
    fclose(stamp);
  }
  execv(argv[2], argv + 2);
  perror("execv");
  return 127;
}
