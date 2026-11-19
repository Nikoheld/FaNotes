//! Committed-ink tile cache.
//!
//! A tile covers 512 × 512 page px and is rendered at a zoom bucket's density
//! (device px per page px), plus a 2 px gutter so bilinear sampling across a
//! tile edge never reads transparent pixels. A frame between buckets samples
//! the nearest bucket; a zoom outside every bucket paints exactly instead.
//! Tiles are dropped only where the scene's dirty log says paint changed.

use std::collections::{HashMap, HashSet};

use kurbo::{Affine, Rect};

use crate::camera::Camera;
use crate::scene::{Dirty, PageScene, TILE_PAGE_PX};

/// Tile densities as multiples of the device pixel ratio.
pub const ZOOM_BUCKETS: [f64; 5] = [0.25, 0.5, 1.0, 2.0, 4.0];
/// Lowest density allowed relative to the screen (the `check:zoom-500-sharp` bar).
pub const BUCKET_MIN_SHARPNESS: f64 = 0.85;
/// Highest density allowed relative to the screen.
pub const BUCKET_MAX_OVERSAMPLE: f64 = 2.0;
/// Extra texels around a tile's content on every side.
pub const TILE_GUTTER: u32 = 2;
/// Default tile memory budget.
pub const TILE_BUDGET_BYTES: usize = 384 << 20;

/// Bucket for a camera zoom, or `None` when the frame paints at the exact scale.
pub fn zoom_bucket(zoom: f64) -> Option<f64> {
    if !zoom.is_finite() || !(zoom > 0.0) {
        return None;
    }
    ZOOM_BUCKETS.into_iter().find(|bucket| {
        *bucket >= BUCKET_MIN_SHARPNESS * zoom - 1e-9
            && *bucket <= BUCKET_MAX_OVERSAMPLE * zoom + 1e-9
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TileKey {
    /// `f64::to_bits` of the density (device px per page px).
    pub density: u64,
    pub col: i32,
    pub row: i32,
}

impl TileKey {
    pub fn density(&self) -> f64 {
        f64::from_bits(self.density)
    }

    /// Content rect, page px.
    pub fn page_rect(&self) -> Rect {
        let x = self.col as f64 * TILE_PAGE_PX;
        let y = self.row as f64 * TILE_PAGE_PX;
        Rect::new(x, y, x + TILE_PAGE_PX, y + TILE_PAGE_PX)
    }

    /// Content edge in texels.
    pub fn content_px(&self) -> u32 {
        (TILE_PAGE_PX * self.density()).round() as u32
    }

    /// Texture edge in texels, gutter included.
    pub fn texture_px(&self) -> u32 {
        self.content_px() + 2 * TILE_GUTTER
    }

    /// Page rect the texture covers, gutter included.
    pub fn texture_page_rect(&self) -> Rect {
        let g = TILE_GUTTER as f64 / self.density();
        self.page_rect().inflate(g, g)
    }

    /// Build px (page px × density) → texel, for rendering the tile.
    pub fn render_transform(&self) -> Affine {
        let d = self.density();
        let g = TILE_GUTTER as f64;
        Affine::translate((
            g - self.col as f64 * TILE_PAGE_PX * d,
            g - self.row as f64 * TILE_PAGE_PX * d,
        ))
    }

    /// Content texel (0, 0)–(content, content) → device px, for compositing.
    pub fn content_to_device(&self, camera: &Camera) -> Affine {
        let rect = self.page_rect();
        camera.page_to_device()
            * Affine::translate((rect.x0, rect.y0))
            * Affine::scale(1.0 / self.density())
    }
}

/// Tiles a frame needs.
#[derive(Clone, Debug, PartialEq)]
pub struct TilePlan {
    pub density: f64,
    pub keys: Vec<TileKey>,
    /// Nearest-neighbour sampling is exact (bucket == device scale, integral scroll).
    pub pixel_aligned: bool,
}

/// The tiles the camera shows, or `None` to paint the frame exactly.
pub fn plan_tiles(camera: &Camera) -> Option<TilePlan> {
    let bucket = zoom_bucket(camera.zoom)?;
    let density = bucket * camera.dpr;
    let visible = camera.visible_page_rect();
    let c0 = (visible.x0 / TILE_PAGE_PX).floor() as i32;
    let r0 = (visible.y0 / TILE_PAGE_PX).floor() as i32;
    let c1 = ((visible.x1 / TILE_PAGE_PX).ceil() as i32 - 1).max(c0);
    let r1 = ((visible.y1 / TILE_PAGE_PX).ceil() as i32 - 1).max(r0);
    let mut keys = Vec::with_capacity(((c1 - c0 + 1) * (r1 - r0 + 1)) as usize);
    for row in r0..=r1 {
        for col in c0..=c1 {
            keys.push(TileKey {
                density: density.to_bits(),
                col,
                row,
            });
        }
    }
    Some(TilePlan {
        density,
        keys,
        pixel_aligned: camera.is_pixel_aligned(density),
    })
}

struct Entry<T> {
    tile: T,
    bytes: usize,
    used: u64,
}

/// Backend-agnostic cache: `T` is a pixmap or a GPU texture.
pub struct TileCache<T> {
    tiles: HashMap<TileKey, Entry<T>>,
    seen: u64,
    clock: u64,
    bytes: usize,
    pub budget_bytes: usize,
    /// Tiles dropped by invalidation since creation (tests and stats).
    pub invalidated: usize,
}

impl<T> Default for TileCache<T> {
    fn default() -> Self {
        Self {
            tiles: HashMap::new(),
            seen: 0,
            clock: 0,
            bytes: 0,
            budget_bytes: TILE_BUDGET_BYTES,
            invalidated: 0,
        }
    }
}

impl<T> TileCache<T> {
    pub fn len(&self) -> usize {
        self.tiles.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tiles.is_empty()
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn contains(&self, key: &TileKey) -> bool {
        self.tiles.contains_key(key)
    }

    pub fn keys(&self) -> impl Iterator<Item = &TileKey> {
        self.tiles.keys()
    }

    /// Replay the scene's dirty log; return the tiles it dropped.
    pub fn sync(&mut self, scene: &PageScene) -> Vec<(TileKey, T)> {
        let mut dropped = Vec::new();
        match scene.dirty_since(self.seen) {
            Dirty::Nothing => {}
            Dirty::All => {
                dropped.extend(self.tiles.drain().map(|(key, entry)| (key, entry.tile)));
                self.bytes = 0;
            }
            Dirty::Rects(rects) => {
                let stale: Vec<TileKey> = self
                    .tiles
                    .keys()
                    .filter(|key| {
                        let rect = key.texture_page_rect();
                        rects.iter().any(|(_, dirty)| dirty.overlaps(rect))
                    })
                    .copied()
                    .collect();
                for key in stale {
                    if let Some(entry) = self.tiles.remove(&key) {
                        self.bytes -= entry.bytes;
                        dropped.push((key, entry.tile));
                    }
                }
            }
        }
        self.invalidated += dropped.len();
        self.seen = scene.revision();
        dropped
    }

    pub fn get(&mut self, key: &TileKey) -> Option<&T> {
        self.clock += 1;
        let clock = self.clock;
        self.tiles.get_mut(key).map(|entry| {
            entry.used = clock;
            &entry.tile
        })
    }

    pub fn peek(&self, key: &TileKey) -> Option<&T> {
        self.tiles.get(key).map(|entry| &entry.tile)
    }

    pub fn insert(&mut self, key: TileKey, tile: T, bytes: usize) {
        self.clock += 1;
        if let Some(old) = self.tiles.insert(
            key,
            Entry {
                tile,
                bytes,
                used: self.clock,
            },
        ) {
            self.bytes -= old.bytes;
        }
        self.bytes += bytes;
    }

    /// Drop least-recently-used tiles over budget, never one in `keep`.
    pub fn evict(&mut self, keep: &HashSet<TileKey>) -> Vec<(TileKey, T)> {
        let mut dropped = Vec::new();
        if self.bytes <= self.budget_bytes {
            return dropped;
        }
        let mut order: Vec<(u64, TileKey)> = self
            .tiles
            .iter()
            .filter(|(key, _)| !keep.contains(key))
            .map(|(key, entry)| (entry.used, *key))
            .collect();
        order.sort_unstable_by_key(|(used, _)| *used);
        for (_, key) in order {
            if self.bytes <= self.budget_bytes {
                break;
            }
            if let Some(entry) = self.tiles.remove(&key) {
                self.bytes -= entry.bytes;
                dropped.push((key, entry.tile));
            }
        }
        dropped
    }

    pub fn clear(&mut self) -> Vec<(TileKey, T)> {
        self.bytes = 0;
        self.tiles
            .drain()
            .map(|(key, entry)| (key, entry.tile))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_keep_ink_sharp_and_bounded() {
        assert_eq!(zoom_bucket(1.0), Some(1.0));
        assert_eq!(zoom_bucket(0.85), Some(1.0));
        // Like `fanotes-raster`: the first (sharpest-needed) bucket in range wins.
        assert_eq!(zoom_bucket(1.2), Some(2.0));
        assert_eq!(zoom_bucket(1.17), Some(1.0));
        assert_eq!(zoom_bucket(1.5), Some(2.0));
        assert_eq!(zoom_bucket(3.0), Some(4.0));
        assert_eq!(zoom_bucket(0.3), Some(0.5));
        assert_eq!(zoom_bucket(0.2), Some(0.25));
        assert_eq!(zoom_bucket(5.0), None, "zoom 500% paints exactly");
        assert_eq!(zoom_bucket(0.1), None);
        for zoom in [0.15, 0.3, 0.6, 0.9, 1.3, 2.2, 3.5, 4.6] {
            if let Some(bucket) = zoom_bucket(zoom) {
                assert!(
                    bucket >= BUCKET_MIN_SHARPNESS * zoom - 1e-9 && bucket <= 2.0 * zoom + 1e-9
                );
            }
        }
    }

    #[test]
    fn a_tile_maps_its_content_onto_the_camera() {
        let mut camera = Camera::new(1024, 768);
        camera.zoom = 1.0;
        camera.scroll_x = 100.0;
        let plan = plan_tiles(&camera).expect("bucket");
        assert!(plan.pixel_aligned);
        assert_eq!(plan.keys.len(), 3 * 2);
        let key = TileKey {
            density: 1.0f64.to_bits(),
            col: 1,
            row: 0,
        };
        let origin = key.content_to_device(&camera) * kurbo::Point::ZERO;
        assert_eq!((origin.x, origin.y), (512.0 - 100.0, 0.0));
        let texel = key.render_transform() * kurbo::Point::new(512.0, 0.0);
        assert_eq!((texel.x, texel.y), (2.0, 2.0));
        assert_eq!(key.texture_px(), 516);
    }
}
