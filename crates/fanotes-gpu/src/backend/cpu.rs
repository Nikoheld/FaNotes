//! vello_cpu backend.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use kurbo::{Affine, BezPath, Rect};
use peniko::{Extend, ImageQuality, ImageSampler};
use vello_cpu::{
    Image, ImageSource, PixelMetadata, Pixmap, RenderContext, RenderSettings, Resources,
};

use super::vello::{encode_exact_ink, encode_live, encode_paper, encode_tile_ink};
use super::{BackendKind, FrameStats, MemoryStats, RenderError, Renderer};
use crate::camera::Camera;
use crate::image::RgbaImage;
use crate::ruling::Prim;
use crate::scene::PageScene;
use crate::tiles::{plan_tiles, TileCache, TileKey, TILE_GUTTER};

super::vello::impl_canvas!(
    RenderContext,
    vello_cpu::filter_effects::Filter,
    vello_cpu::filter_effects::FilterPrimitive,
    vello_cpu::filter_effects::EdgeMode::None
);

pub struct CpuRenderer {
    settings: RenderSettings,
    frame: Option<RenderContext>,
    tile_contexts: HashMap<u32, RenderContext>,
    resources: Resources,
    target: Option<Pixmap>,
    tiles: TileCache<Arc<Pixmap>>,
    images: HashMap<u64, Arc<Pixmap>>,
    tiling: bool,
    prims: Vec<Prim>,
    scratch: BezPath,
}

impl CpuRenderer {
    /// `threads`: worker threads (`None` = all cores but one, at most 8).
    /// With 0 threads the neon glow filter is drawn; vello_cpu cannot run
    /// filters on its multithreaded path.
    pub fn new(threads: Option<u16>) -> Self {
        let mut settings = RenderSettings::default();
        if let Some(threads) = threads {
            settings.num_threads = threads;
        }
        Self {
            settings,
            frame: None,
            tile_contexts: HashMap::new(),
            resources: Resources::new(),
            target: None,
            tiles: TileCache::default(),
            images: HashMap::new(),
            tiling: true,
            prims: Vec::new(),
            scratch: BezPath::new(),
        }
    }

    pub fn tiles(&self) -> &TileCache<Arc<Pixmap>> {
        &self.tiles
    }

    fn render_tile(&mut self, scene: &PageScene, key: &TileKey) -> (Arc<Pixmap>, usize) {
        let size = key.texture_px();
        let settings = self.settings;
        let context = self
            .tile_contexts
            .entry(size)
            .or_insert_with(|| RenderContext::new_with(size as u16, size as u16, settings));
        context.reset();
        let glow_ok = settings.num_threads == 0;
        let strokes = encode_tile_ink(context, scene, key, glow_ok, &mut self.scratch);
        context.flush();
        let mut pixmap = Pixmap::new(size as u16, size as u16);
        context.render(&mut pixmap, &mut self.resources);
        (Arc::new(pixmap), strokes)
    }

    fn image_pixmap(&mut self, id: u64, image: &RgbaImage) -> Arc<Pixmap> {
        self.images
            .entry(id)
            .or_insert_with(|| {
                Arc::new(Pixmap::from_parts(
                    image.data.clone(),
                    image.width as u16,
                    image.height as u16,
                    PixelMetadata {
                        may_have_transparency: true,
                        alpha_type: vello_cpu::peniko::ImageAlphaType::Alpha,
                    },
                ))
            })
            .clone()
    }
}

fn image_paint(pixmap: Arc<Pixmap>, quality: ImageQuality) -> Image {
    Image {
        image: ImageSource::Pixmap(pixmap),
        sampler: ImageSampler {
            x_extend: Extend::Pad,
            y_extend: Extend::Pad,
            quality,
            alpha: 1.0,
        },
    }
}

impl Renderer for CpuRenderer {
    fn kind(&self) -> BackendKind {
        BackendKind::VelloCpu
    }

    fn render(&mut self, scene: &PageScene, camera: &Camera) -> Result<FrameStats, RenderError> {
        let (w, h) = (camera.width, camera.height);
        if w == 0 || h == 0 || w > u16::MAX as u32 || h > u16::MAX as u32 {
            return Err(RenderError::Size(w, h));
        }
        let mut stats = FrameStats::default();
        self.tiles.sync(scene);
        // Images still in the scene stay uploaded.
        let live_images: HashSet<u64> = scene.images().iter().map(|image| image.id).collect();
        self.images.retain(|id, _| live_images.contains(id));
        let page_images: Vec<(Arc<Pixmap>, Affine)> = scene
            .images()
            .iter()
            .map(|image| {
                let pixmap = self.image_pixmap(image.id, &image.image);
                let transform = camera.page_to_device()
                    * Affine::translate((image.rect.x0, image.rect.y0))
                    * Affine::scale_non_uniform(
                        image.rect.width() / image.image.width.max(1) as f64,
                        image.rect.height() / image.image.height.max(1) as f64,
                    );
                (pixmap, transform)
            })
            .collect();

        let plan = if self.tiling {
            plan_tiles(camera)
        } else {
            None
        };
        let mut tile_draws = Vec::new();
        if let Some(plan) = &plan {
            stats.bucket_density = Some(plan.density);
            for key in &plan.keys {
                let tile = match self.tiles.get(key) {
                    Some(tile) => tile.clone(),
                    None => {
                        let (tile, strokes) = self.render_tile(scene, key);
                        let bytes = tile.width() as usize * tile.height() as usize * 4;
                        self.tiles.insert(*key, tile.clone(), bytes);
                        stats.tiles_rendered += 1;
                        stats.strokes_encoded += strokes;
                        tile
                    }
                };
                tile_draws.push((*key, tile));
            }
            stats.tiles_used = plan.keys.len();
            let keep: HashSet<TileKey> = plan.keys.iter().copied().collect();
            self.tiles.evict(&keep);
        }

        let settings = self.settings;
        let frame = match &mut self.frame {
            Some(frame) if frame.width() as u32 == w && frame.height() as u32 == h => frame,
            slot => slot.insert(RenderContext::new_with(w as u16, h as u16, settings)),
        };
        frame.reset();
        encode_paper(frame, scene, camera, &mut self.prims, &mut self.scratch);
        for (pixmap, transform) in page_images {
            let (iw, ih) = (pixmap.width() as f64, pixmap.height() as f64);
            frame.set_transform(transform);
            frame.set_paint(image_paint(pixmap, ImageQuality::Medium));
            frame.fill_rect(&Rect::new(0.0, 0.0, iw, ih));
        }
        let glow_ok = settings.num_threads == 0;
        if let Some(plan) = &plan {
            let quality = if plan.pixel_aligned {
                ImageQuality::Low
            } else {
                ImageQuality::Medium
            };
            let g = TILE_GUTTER as f64;
            for (key, tile) in tile_draws {
                let content = key.content_px() as f64;
                frame.set_transform(key.content_to_device(camera) * Affine::translate((-g, -g)));
                frame.set_paint(image_paint(tile, quality));
                frame.fill_rect(&Rect::new(g, g, g + content, g + content));
            }
        } else {
            stats.strokes_encoded +=
                encode_exact_ink(frame, scene, camera, glow_ok, &mut self.scratch);
        }
        encode_live(frame, scene, camera, glow_ok, &mut self.scratch);
        frame.flush();
        let target = match &mut self.target {
            Some(target) if target.width() as u32 == w && target.height() as u32 == h => target,
            slot => slot.insert(Pixmap::new(w as u16, h as u16)),
        };
        frame.render(&mut *target, &mut self.resources);
        if stats.strokes_encoded > 4096 && stats.bucket_density.is_none() {
            // Do not carry a huge exact frame's buffers into the next frames.
            self.frame = None;
        }
        Ok(stats)
    }

    fn read_rgba(&mut self) -> Result<RgbaImage, RenderError> {
        let target = self.target.as_ref().ok_or(RenderError::NoFrame)?;
        Ok(RgbaImage::from_premultiplied(
            target.width() as u32,
            target.height() as u32,
            target.data_as_u8_slice().to_vec(),
        ))
    }

    fn memory(&self) -> MemoryStats {
        let target = self.target.as_ref().map_or(0, |target| {
            target.width() as usize * target.height() as usize * 4
        });
        let images: usize = self
            .images
            .values()
            .map(|image| image.width() as usize * image.height() as usize * 4)
            .sum();
        MemoryStats {
            tiles: self.tiles.len(),
            tile_bytes: self.tiles.bytes(),
            other_bytes: target + images,
        }
    }

    fn set_tiling(&mut self, enabled: bool) {
        self.tiling = enabled;
    }

    fn clear_cache(&mut self) {
        self.tiles.clear();
        self.images.clear();
    }
}
