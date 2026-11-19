# fanotes-bench:1 — the measurement image for scripts/bench-desktop.
# Derived from the Tauri build image (Rust 1.85.1, WebKitGTK 4.1, webkit2gtk-driver,
# Xvfb), plus what the Electron build and the harness need. Both hosts run here,
# in the same container, under the same Xvfb.
#
#   sudo docker build -t fanotes-bench:1 fanotes/scripts/bench-desktop/docker
FROM fanotes-tauri-build:1

RUN apt-get update && apt-get install -y --no-install-recommends \
      libnss3 libxss1 libxtst-dev libgl1-mesa-dri libegl1 libgles2 \
      x11-utils xdotool util-linux procps time \
    && rm -rf /var/lib/apt/lists/*

# Node for the harness and the TypeScript sync engine; same version as the host.
ARG NODE_VERSION=22.23.2
ARG NODE_SHA256=d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307
RUN curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --exclude='*.md' --exclude=LICENSE \
    && rm /tmp/node.tar.xz && node --version

COPY xinject.c execstamp.c /opt/bench/
RUN cc -O2 -Wall -o /usr/local/bin/fanotes-xinject /opt/bench/xinject.c -lX11 -lXtst \
    && cc -O2 -Wall -o /usr/local/bin/fanotes-execstamp /opt/bench/execstamp.c
