# Linux build environment for the FaNotes Tauri shell (WebKitGTK 4.1).
# Same Rust as rust-toolchain.toml (1.99.0) so lockfiles and MSRV agree.
# Node 22 builds the React bundle and runs the Tauri CLI through npx.
FROM node:22-bookworm-slim AS node

FROM rust:1.99.0-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
      libsoup-3.0-dev libjavascriptcoregtk-4.1-dev libssl-dev libxdo-dev libdbus-1-dev \
      pkg-config build-essential patchelf file xdg-utils curl ca-certificates \
      webkit2gtk-driver xvfb xauth dbus-x11 gnome-keyring \
    && rm -rf /var/lib/apt/lists/*
RUN rustup component add rustfmt clippy
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && node --version && npm --version
