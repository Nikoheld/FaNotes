//! vello_hybrid on wgpu.
//!
//! Committed-ink tiles are wgpu textures rendered by a vello_hybrid renderer
//! and sampled into the frame with `draw_texture_rects`; PDF pages are
//! textures uploaded once per image id. A renderer's GPU buffers are staged
//! with `queue.write_*`, so every vello render is submitted before the next.

use std::collections::{HashMap, HashSet};

use kurbo::{Affine, BezPath};
use peniko::ImageQuality;
use vello_common_hybrid::geometry::RectU16;
use vello_hybrid::{RenderSize, RenderTargetConfig, SampleRect, Scene, TextureBindings, TextureId};

use super::vello::{encode_exact_ink, encode_live, encode_paper, encode_tile_ink};
use super::{BackendKind, FrameStats, MemoryStats, RenderError, Renderer};
use crate::camera::Camera;
use crate::image::RgbaImage;
use crate::ruling::Prim;
use crate::scene::PageScene;
use crate::tiles::{plan_tiles, TileCache, TileKey, TILE_GUTTER};

super::vello::impl_canvas!(
    Scene,
    vello_common_hybrid::filter_effects::Filter,
    vello_common_hybrid::filter_effects::FilterPrimitive,
    vello_common_hybrid::filter_effects::EdgeMode::None
);

/// Format of tiles, page textures and the offscreen frame.
const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
/// Strokes in one scene above which its storage is not kept for reuse.
const LARGE_ENCODE: usize = 4096;
/// Free tile textures kept per size for reuse while panning.
const POOL_PER_SIZE: usize = 32;

/// Instance, adapter, device and queue.
pub struct GpuContext {
    pub instance: wgpu::Instance,
    pub adapter: wgpu::Adapter,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
}

impl GpuContext {
    pub fn instance() -> wgpu::Instance {
        let mut desc = wgpu::InstanceDescriptor::new_without_display_handle();
        desc.backends = wgpu::Backends::PRIMARY.with_env();
        wgpu::Instance::new(desc)
    }

    /// Pick an adapter: `FANOTES_GPU_ADAPTER` (a name substring) wins, then a
    /// high-performance adapter compatible with `surface`.
    pub fn new(
        instance: wgpu::Instance,
        surface: Option<&wgpu::Surface<'_>>,
    ) -> Result<Self, RenderError> {
        let wanted = std::env::var("FANOTES_GPU_ADAPTER")
            .ok()
            .filter(|name| !name.is_empty());
        let adapter = match wanted {
            Some(name) => {
                let adapters =
                    pollster::block_on(instance.enumerate_adapters(wgpu::Backends::all()));
                adapters
                    .into_iter()
                    .find(|adapter| {
                        adapter
                            .get_info()
                            .name
                            .to_lowercase()
                            .contains(&name.to_lowercase())
                            && surface.is_none_or(|surface| adapter.is_surface_supported(surface))
                    })
                    .ok_or_else(|| {
                        RenderError::NoAdapter(format!("no adapter named like {name:?}"))
                    })?
            }
            None => pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                compatible_surface: surface,
            }))
            .map_err(|error| RenderError::NoAdapter(error.to_string()))?,
        };
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("fanotes-gpu"),
            required_features: wgpu::Features::empty(),
            required_limits: adapter.limits(),
            ..Default::default()
        }))
        .map_err(|error| RenderError::Gpu(error.to_string()))?;
        Ok(Self {
            instance,
            adapter,
            device,
            queue,
        })
    }

    pub fn headless() -> Result<Self, RenderError> {
        Self::new(Self::instance(), None)
    }

    pub fn adapter_name(&self) -> String {
        let info = self.adapter.get_info();
        format!("{} ({:?})", info.name, info.backend)
    }

    fn texture(
        &self,
        width: u32,
        height: u32,
        label: &str,
        extra: wgpu::TextureUsages,
    ) -> wgpu::Texture {
        self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: FORMAT,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | extra,
            view_formats: &[],
        })
    }

    fn wait(&self) {
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
    }
}

struct GpuTile {
    id: TextureId,
    texture: wgpu::Texture,
}

enum Target {
    Offscreen {
        texture: wgpu::Texture,
        width: u32,
        height: u32,
    },
    Surface {
        surface: wgpu::Surface<'static>,
        config: wgpu::SurfaceConfiguration,
    },
}

pub struct HybridRenderer {
    gpu: GpuContext,
    tile_renderer: vello_hybrid::Renderer,
    tile_resources: vello_hybrid::Resources,
    frame_renderer: vello_hybrid::Renderer,
    frame_resources: vello_hybrid::Resources,
    target: Option<Target>,
    surface_format: Option<wgpu::TextureFormat>,
    scene: Scene,
    tile_scenes: Vec<Scene>,
    /// The last frame encoded a lot of ink; start the next one from a fresh scene.
    shrink_frame: bool,
    tiles: TileCache<GpuTile>,
    pool: HashMap<u32, Vec<wgpu::Texture>>,
    images: HashMap<u64, (TextureId, wgpu::Texture, (u32, u32))>,
    bindings: TextureBindings,
    next_texture: u64,
    tiling: bool,
    /// Wait for the GPU at the end of every offscreen frame (timings include it).
    pub wait_each_frame: bool,
    prims: Vec<Prim>,
    scratch: BezPath,
}

impl HybridRenderer {
    /// Offscreen renderer on the default (or `FANOTES_GPU_ADAPTER`) adapter.
    pub fn headless() -> Result<Self, RenderError> {
        Ok(Self::with_context(GpuContext::headless()?, None))
    }

    /// Renderer presenting to `surface`, which must come from `gpu.instance`.
    pub fn with_surface(
        gpu: GpuContext,
        surface: wgpu::Surface<'static>,
        width: u32,
        height: u32,
    ) -> Result<Self, RenderError> {
        let caps = surface.get_capabilities(&gpu.adapter);
        // vello writes sRGB-encoded values like a canvas; use a non-sRGB view.
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|format| {
                matches!(
                    format,
                    wgpu::TextureFormat::Rgba8Unorm | wgpu::TextureFormat::Bgra8Unorm
                )
            })
            .ok_or_else(|| {
                RenderError::Gpu(format!(
                    "no 8-bit unorm surface format in {:?}",
                    caps.formats
                ))
            })?;
        let present_mode = if caps.present_modes.contains(&wgpu::PresentMode::Mailbox) {
            wgpu::PresentMode::Mailbox
        } else {
            wgpu::PresentMode::Fifo
        };
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: width.max(1),
            height: height.max(1),
            present_mode,
            desired_maximum_frame_latency: 1,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
        };
        surface.configure(&gpu.device, &config);
        let mut renderer = Self::with_context(gpu, Some(format));
        renderer.target = Some(Target::Surface { surface, config });
        Ok(renderer)
    }

    fn with_context(gpu: GpuContext, surface_format: Option<wgpu::TextureFormat>) -> Self {
        let config = |format| RenderTargetConfig {
            format,
            width: 512,
            height: 512,
        };
        let (tile_renderer, tile_resources) =
            vello_hybrid::Renderer::new(&gpu.device, &config(FORMAT));
        let (frame_renderer, frame_resources) =
            vello_hybrid::Renderer::new(&gpu.device, &config(surface_format.unwrap_or(FORMAT)));
        Self {
            gpu,
            tile_renderer,
            tile_resources,
            frame_renderer,
            frame_resources,
            target: None,
            surface_format,
            scene: Scene::new(1, 1),
            tile_scenes: Vec::new(),
            shrink_frame: false,
            tiles: TileCache::default(),
            pool: HashMap::new(),
            images: HashMap::new(),
            bindings: TextureBindings::new(),
            next_texture: 1,
            tiling: true,
            wait_each_frame: true,
            prims: Vec::new(),
            scratch: BezPath::new(),
        }
    }

    pub fn adapter_name(&self) -> String {
        self.gpu.adapter_name()
    }

    pub fn gpu(&self) -> &GpuContext {
        &self.gpu
    }

    /// New window size for a surface renderer.
    pub fn resize(&mut self, width: u32, height: u32) {
        if let Some(Target::Surface { surface, config }) = &mut self.target {
            if (config.width, config.height) != (width, height) && width > 0 && height > 0 {
                config.width = width;
                config.height = height;
                surface.configure(&self.gpu.device, config);
            }
        }
    }

    fn texture_id(&mut self) -> TextureId {
        let id = TextureId(self.next_texture);
        self.next_texture += 1;
        id
    }

    fn release_tile(&mut self, tile: GpuTile) {
        self.bindings.remove(tile.id);
        let size = tile.texture.width();
        let pool = self.pool.entry(size).or_default();
        if pool.len() < POOL_PER_SIZE {
            pool.push(tile.texture);
        }
    }

    /// Encode missing tiles on all cores (a vello_hybrid scene builds its
    /// strips on the CPU, one thread per scene), then render them in order.
    fn render_tiles(&mut self, scene: &PageScene, keys: &[TileKey]) -> Result<usize, RenderError> {
        let threads = std::thread::available_parallelism()
            .map_or(1, |n| n.get())
            .clamp(1, 8);
        let mut strokes = 0;
        for batch in keys.chunks(threads) {
            let mut scenes = std::mem::take(&mut self.tile_scenes);
            scenes.resize_with(batch.len().max(scenes.len()), || Scene::new(1, 1));
            let counts: Vec<usize> = std::thread::scope(|scope| {
                let jobs: Vec<_> = batch
                    .iter()
                    .zip(scenes.iter_mut())
                    .map(|(key, tile_scene)| {
                        scope.spawn(move || {
                            let size = key.texture_px() as u16;
                            tile_scene.reset_and_resize(size, size);
                            encode_tile_ink(tile_scene, scene, key, true, &mut BezPath::new())
                        })
                    })
                    .collect();
                jobs.into_iter()
                    .map(|job| job.join().expect("tile encoder"))
                    .collect()
            });
            strokes += counts.iter().sum::<usize>();
            for (key, tile_scene) in batch.iter().zip(scenes.iter()) {
                let tile = self.upload_tile(tile_scene, key)?;
                let bytes = tile.texture.width() as usize * tile.texture.height() as usize * 4;
                self.tiles.insert(*key, tile, bytes);
            }
            self.tile_scenes = scenes;
        }
        if strokes > LARGE_ENCODE {
            // A dense tile's strip storage is not kept for reuse.
            self.tile_scenes.clear();
        }
        Ok(strokes)
    }

    fn upload_tile(&mut self, tile_scene: &Scene, key: &TileKey) -> Result<GpuTile, RenderError> {
        let size = key.texture_px();
        let texture = match self.pool.get_mut(&size).and_then(Vec::pop) {
            Some(texture) => texture,
            None => self.gpu.texture(
                size,
                size,
                "fanotes-gpu tile",
                wgpu::TextureUsages::RENDER_ATTACHMENT,
            ),
        };
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self
            .gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("tile"),
            });
        self.tile_renderer
            .render(
                tile_scene,
                &mut self.tile_resources,
                &self.gpu.device,
                &self.gpu.queue,
                &mut encoder,
                &RenderSize {
                    width: size,
                    height: size,
                },
                &view,
                &TextureBindings::new(),
            )
            .map_err(|error| RenderError::Gpu(error.to_string()))?;
        self.gpu.queue.submit([encoder.finish()]);
        let id = self.texture_id();
        self.bindings.insert(id, view);
        Ok(GpuTile { id, texture })
    }

    fn sync_images(&mut self, scene: &PageScene) {
        let wanted: HashSet<u64> = scene.images().iter().map(|image| image.id).collect();
        let stale: Vec<u64> = self
            .images
            .keys()
            .filter(|id| !wanted.contains(id))
            .copied()
            .collect();
        for id in stale {
            if let Some((texture_id, _, _)) = self.images.remove(&id) {
                self.bindings.remove(texture_id);
            }
        }
        for image in scene.images() {
            if self.images.contains_key(&image.id) {
                continue;
            }
            let (w, h) = (image.image.width, image.image.height);
            let texture = self.gpu.texture(
                w,
                h,
                "fanotes-gpu page image",
                wgpu::TextureUsages::COPY_DST,
            );
            self.gpu.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                &image.image.to_premultiplied(),
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(w * 4),
                    rows_per_image: Some(h),
                },
                wgpu::Extent3d {
                    width: w,
                    height: h,
                    depth_or_array_layers: 1,
                },
            );
            let id = self.texture_id();
            self.bindings.insert(
                id,
                texture.create_view(&wgpu::TextureViewDescriptor::default()),
            );
            self.images.insert(image.id, (id, texture, (w, h)));
        }
    }

    fn ensure_offscreen(&mut self, width: u32, height: u32) {
        let fits = matches!(&self.target, Some(Target::Offscreen { width: w, height: h, .. }) if (*w, *h) == (width, height));
        if !fits && !matches!(self.target, Some(Target::Surface { .. })) {
            let texture = self.gpu.texture(
                width,
                height,
                "fanotes-gpu frame",
                wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            );
            self.target = Some(Target::Offscreen {
                texture,
                width,
                height,
            });
        }
    }
}

fn rect_u16(x0: u32, y0: u32, x1: u32, y1: u32) -> RectU16 {
    RectU16 {
        x0: x0 as u16,
        y0: y0 as u16,
        x1: x1 as u16,
        y1: y1 as u16,
    }
}

impl Renderer for HybridRenderer {
    fn kind(&self) -> BackendKind {
        BackendKind::VelloHybrid
    }

    fn render(&mut self, scene: &PageScene, camera: &Camera) -> Result<FrameStats, RenderError> {
        let (w, h) = (camera.width, camera.height);
        let max = self
            .gpu
            .device
            .limits()
            .max_texture_dimension_2d
            .min(u16::MAX as u32);
        if w == 0 || h == 0 || w > max || h > max {
            return Err(RenderError::Size(w, h));
        }
        self.ensure_offscreen(w, h);
        let mut stats = FrameStats::default();
        for (_, tile) in self.tiles.sync(scene) {
            self.release_tile(tile);
        }
        self.sync_images(scene);

        let plan = if self.tiling {
            plan_tiles(camera)
        } else {
            None
        };
        if let Some(plan) = &plan {
            stats.bucket_density = Some(plan.density);
            stats.tiles_used = plan.keys.len();
            let missing: Vec<TileKey> = plan
                .keys
                .iter()
                .filter(|key| self.tiles.get(key).is_none())
                .copied()
                .collect();
            stats.tiles_rendered = missing.len();
            stats.strokes_encoded += self.render_tiles(scene, &missing)?;
            let keep: HashSet<TileKey> = plan.keys.iter().copied().collect();
            for (_, tile) in self.tiles.evict(&keep) {
                self.release_tile(tile);
            }
        }

        if std::mem::take(&mut self.shrink_frame) {
            // A scene keeps its strip storage across `reset`; after a huge exact
            // frame that made every later layered frame ~13x slower.
            self.scene = Scene::new(w as u16, h as u16);
            // The renderer's buffers grew to that frame too; it is cheap to rebuild once.
            let format = self.surface_format.unwrap_or(FORMAT);
            let (renderer, resources) = vello_hybrid::Renderer::new(
                &self.gpu.device,
                &RenderTargetConfig {
                    format,
                    width: w,
                    height: h,
                },
            );
            self.frame_renderer = renderer;
            self.frame_resources = resources;
        }
        self.scene.reset_and_resize(w as u16, h as u16);
        encode_paper(
            &mut self.scene,
            scene,
            camera,
            &mut self.prims,
            &mut self.scratch,
        );
        for image in scene.images() {
            let Some((id, _, (iw, ih))) = self.images.get(&image.id) else {
                continue;
            };
            let transform = camera.page_to_device()
                * Affine::translate((image.rect.x0, image.rect.y0))
                * Affine::scale_non_uniform(
                    image.rect.width() / *iw as f64,
                    image.rect.height() / *ih as f64,
                );
            self.scene.set_transform(transform);
            self.scene.draw_texture_rects(
                *id,
                ImageQuality::Medium,
                [SampleRect {
                    source_region: rect_u16(0, 0, *iw, *ih),
                    transform: Affine::IDENTITY,
                }],
            );
        }
        if let Some(plan) = &plan {
            let quality = if plan.pixel_aligned {
                ImageQuality::Low
            } else {
                ImageQuality::Medium
            };
            let g = TILE_GUTTER;
            for key in &plan.keys {
                let Some(tile) = self.tiles.peek(key) else {
                    continue;
                };
                let content = key.content_px();
                self.scene.set_transform(key.content_to_device(camera));
                self.scene.draw_texture_rects(
                    tile.id,
                    quality,
                    [SampleRect {
                        source_region: rect_u16(g, g, g + content, g + content),
                        transform: Affine::IDENTITY,
                    }],
                );
            }
        } else {
            stats.strokes_encoded +=
                encode_exact_ink(&mut self.scene, scene, camera, true, &mut self.scratch);
            self.shrink_frame = stats.strokes_encoded > LARGE_ENCODE;
        }
        encode_live(&mut self.scene, scene, camera, true, &mut self.scratch);

        let mut encoder = self
            .gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("frame"),
            });
        let size = RenderSize {
            width: w,
            height: h,
        };
        match self.target.as_mut().expect("target") {
            Target::Offscreen { texture, .. } => {
                let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
                self.frame_renderer
                    .render(
                        &self.scene,
                        &mut self.frame_resources,
                        &self.gpu.device,
                        &self.gpu.queue,
                        &mut encoder,
                        &size,
                        &view,
                        &self.bindings,
                    )
                    .map_err(|error| RenderError::Gpu(error.to_string()))?;
                self.gpu.queue.submit([encoder.finish()]);
                if self.wait_each_frame {
                    self.gpu.wait();
                }
            }
            Target::Surface { surface, config } => {
                let frame = match surface.get_current_texture() {
                    wgpu::CurrentSurfaceTexture::Success(frame)
                    | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
                    wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                        surface.configure(&self.gpu.device, config);
                        return Ok(stats);
                    }
                    other => return Err(RenderError::Gpu(format!("surface: {other:?}"))),
                };
                let view = frame
                    .texture
                    .create_view(&wgpu::TextureViewDescriptor::default());
                self.frame_renderer
                    .render(
                        &self.scene,
                        &mut self.frame_resources,
                        &self.gpu.device,
                        &self.gpu.queue,
                        &mut encoder,
                        &size,
                        &view,
                        &self.bindings,
                    )
                    .map_err(|error| RenderError::Gpu(error.to_string()))?;
                self.gpu.queue.submit([encoder.finish()]);
                frame.present();
            }
        }
        Ok(stats)
    }

    fn read_rgba(&mut self) -> Result<RgbaImage, RenderError> {
        let Some(Target::Offscreen {
            texture,
            width,
            height,
        }) = &self.target
        else {
            return Err(RenderError::NoFrame);
        };
        let (width, height) = (*width, *height);
        let row = (width * 4).next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let buffer = self.gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: row as u64 * height as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self
            .gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("readback"),
            });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(row),
                    rows_per_image: None,
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        self.gpu.queue.submit([encoder.finish()]);
        buffer.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        self.gpu.wait();
        let mut data = Vec::with_capacity(width as usize * height as usize * 4);
        {
            let mapped = buffer.slice(..).get_mapped_range();
            for line in mapped.chunks_exact(row as usize) {
                data.extend_from_slice(&line[..width as usize * 4]);
            }
        }
        buffer.unmap();
        Ok(RgbaImage::from_premultiplied(width, height, data))
    }

    fn memory(&self) -> MemoryStats {
        let pool: usize = self
            .pool
            .values()
            .flatten()
            .map(|texture| texture.width() as usize * texture.height() as usize * 4)
            .sum();
        let images: usize = self
            .images
            .values()
            .map(|(_, _, (w, h))| *w as usize * *h as usize * 4)
            .sum();
        let target = match &self.target {
            Some(Target::Offscreen { width, height, .. }) => *width as usize * *height as usize * 4,
            Some(Target::Surface { config, .. }) => {
                config.width as usize * config.height as usize * 4 * 3
            }
            None => 0,
        };
        MemoryStats {
            tiles: self.tiles.len(),
            tile_bytes: self.tiles.bytes(),
            other_bytes: pool + images + target,
        }
    }

    fn set_tiling(&mut self, enabled: bool) {
        self.tiling = enabled;
    }

    fn clear_cache(&mut self) {
        for (_, tile) in self.tiles.clear() {
            self.bindings.remove(tile.id);
        }
        self.pool.clear();
        for (_, (id, _, _)) in self.images.drain() {
            self.bindings.remove(id);
        }
    }
}
