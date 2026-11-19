//! The tiny-skia reference: `fanotes_raster::draw_ink_stroke` for every stroke.
//!
//! No tiles and no op building: each frame paints the visible strokes exactly,
//! the way `drawInkStroke` paints a page canvas, onto a transparent ink layer
//! that is composited over the sheet. The wet stroke is a full repaint too.

use fanotes_raster::{draw_ink_stroke, to_rgba, InkPoint, InkStroke};
use tiny_skia::{
    Color, FillRule, FilterQuality, Paint, PathBuilder, Pixmap, PixmapPaint, Rect as SkRect,
    Transform,
};

use super::{exact_query_margin, BackendKind, FrameStats, MemoryStats, RenderError, Renderer};
use crate::camera::Camera;
use crate::image::RgbaImage;
use crate::ruling::{ruling_prims, Prim};
use crate::scene::PageScene;

#[derive(Default)]
pub struct ReferenceRenderer {
    target: Option<Pixmap>,
    ink: Option<Pixmap>,
    prims: Vec<Prim>,
}

impl ReferenceRenderer {
    pub fn new() -> Self {
        Self::default()
    }
}

fn sk_transform(affine: kurbo::Affine) -> Transform {
    let [a, b, c, d, e, f] = affine.as_coeffs();
    Transform::from_row(a as f32, b as f32, c as f32, d as f32, e as f32, f as f32)
}

fn color(rgba: [u8; 4]) -> Color {
    Color::from_rgba8(rgba[0], rgba[1], rgba[2], rgba[3])
}

/// Page-px points → the 0–1 points `drawInkStroke` takes.
fn normalized(stroke: &InkStroke, page: (f64, f64)) -> InkStroke {
    let mut copy = stroke.clone();
    for point in &mut copy.points {
        *point = InkPoint {
            x: point.x / page.0,
            y: point.y / page.1,
            pressure: point.pressure,
        };
    }
    copy
}

fn paint_stroke(layer: &mut Pixmap, stroke: &InkStroke, scene: &PageScene, camera: &Camera) {
    let page = scene.page_size();
    if !(page.0 > 0.0 && page.1 > 0.0) {
        return;
    }
    let scale = camera.device_scale();
    let dpr = camera.dpr;
    let norm = normalized(stroke, page);
    draw_ink_stroke(
        &mut layer.as_mut(),
        &norm,
        page.0 * scale,
        page.1 * scale,
        scene.smoothing,
        1,
        page.0,
        page.0,
        norm.points.len(),
        (camera.scroll_x * dpr, camera.scroll_y * dpr),
    );
}

impl Renderer for ReferenceRenderer {
    fn kind(&self) -> BackendKind {
        BackendKind::TinySkia
    }

    fn render(&mut self, scene: &PageScene, camera: &Camera) -> Result<FrameStats, RenderError> {
        let (w, h) = (camera.width, camera.height);
        let fresh = |slot: &mut Option<Pixmap>| -> Result<(), RenderError> {
            if slot
                .as_ref()
                .is_none_or(|p| p.width() != w || p.height() != h)
            {
                *slot = Some(Pixmap::new(w, h).ok_or(RenderError::Size(w, h))?);
            }
            Ok(())
        };
        fresh(&mut self.target)?;
        fresh(&mut self.ink)?;
        let target = self.target.as_mut().expect("target");
        let ink = self.ink.as_mut().expect("ink");
        let bg = scene.background;
        target.fill(Color::from_rgba8(
            (bg >> 16) as u8,
            (bg >> 8) as u8,
            bg as u8,
            255,
        ));

        self.prims.clear();
        ruling_prims(
            scene.paper,
            (camera.origin_x, camera.origin_y),
            camera.visible_page_rect(),
            camera.device_scale(),
            &mut self.prims,
        );
        let to_device = sk_transform(camera.page_to_device());
        let mut paint = Paint {
            anti_alias: true,
            ..Paint::default()
        };
        for prim in &self.prims {
            match prim {
                Prim::Rect { rect, rgba } => {
                    paint.set_color(color(*rgba));
                    let clipped = rect.intersect(camera.visible_page_rect().inflate(2.0, 2.0));
                    if let Some(r) = SkRect::from_ltrb(
                        clipped.x0 as f32,
                        clipped.y0 as f32,
                        clipped.x1 as f32,
                        clipped.y1 as f32,
                    ) {
                        // `fill_rect` trips a tiny-skia debug assertion on sub-pixel rects.
                        target.fill_path(
                            &PathBuilder::from_rect(r),
                            &paint,
                            FillRule::Winding,
                            to_device,
                            None,
                        );
                    }
                }
                Prim::Circle { c, r, rgba } => {
                    paint.set_color(color(*rgba));
                    if let Some(path) = PathBuilder::from_circle(c.x as f32, c.y as f32, *r as f32)
                    {
                        target.fill_path(&path, &paint, FillRule::Winding, to_device, None);
                    }
                }
            }
        }

        for image in scene.images() {
            let data = image.image.to_premultiplied();
            let Some(size) = tiny_skia::IntSize::from_wh(image.image.width, image.image.height)
            else {
                continue;
            };
            let Some(pixmap) = Pixmap::from_vec(data, size) else {
                continue;
            };
            let transform = camera.page_to_device()
                * kurbo::Affine::translate((image.rect.x0, image.rect.y0))
                * kurbo::Affine::scale_non_uniform(
                    image.rect.width() / image.image.width as f64,
                    image.rect.height() / image.image.height as f64,
                );
            let paint = PixmapPaint {
                quality: FilterQuality::Bilinear,
                ..PixmapPaint::default()
            };
            target.draw_pixmap(0, 0, pixmap.as_ref(), &paint, sk_transform(transform), None);
        }

        ink.fill(Color::TRANSPARENT);
        let scale = camera.device_scale();
        let margin = exact_query_margin(scale);
        let strokes = scene.strokes_in(camera.visible_page_rect().inflate(margin, margin));
        for (_, stroke) in &strokes {
            paint_stroke(ink, &stroke.stroke, scene, camera);
        }
        target.draw_pixmap(
            0,
            0,
            ink.as_ref(),
            &PixmapPaint::default(),
            Transform::identity(),
            None,
        );

        if let Some(live) = scene.live().filter(|live| !live.points().is_empty()) {
            ink.fill(Color::TRANSPARENT);
            paint_stroke(ink, &live.to_stroke(), scene, camera);
            target.draw_pixmap(
                0,
                0,
                ink.as_ref(),
                &PixmapPaint::default(),
                Transform::identity(),
                None,
            );
        }
        Ok(FrameStats {
            bucket_density: None,
            tiles_used: 0,
            tiles_rendered: 0,
            strokes_encoded: strokes.len(),
        })
    }

    fn read_rgba(&mut self) -> Result<RgbaImage, RenderError> {
        let target = self.target.as_ref().ok_or(RenderError::NoFrame)?;
        Ok(RgbaImage {
            width: target.width(),
            height: target.height(),
            data: to_rgba(target),
        })
    }

    fn memory(&self) -> MemoryStats {
        let bytes = |p: &Option<Pixmap>| p.as_ref().map_or(0, |p| p.data().len());
        MemoryStats {
            tiles: 0,
            tile_bytes: 0,
            other_bytes: bytes(&self.target) + bytes(&self.ink),
        }
    }

    fn set_tiling(&mut self, _enabled: bool) {}

    fn clear_cache(&mut self) {}
}
