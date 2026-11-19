//! Native pen backends. Every backend is split into a pure translator (raw protocol
//! events in, `PenSample`s out; always compiled and replay-tested) and a thin I/O
//! layer behind a cargo feature.

pub mod wayland;
pub mod windows;
pub mod x11;

#[cfg(all(feature = "wayland", unix))]
pub mod wayland_io;
#[cfg(all(feature = "windows", windows))]
pub mod windows_io;
#[cfg(all(feature = "x11", unix))]
pub mod x11_io;
