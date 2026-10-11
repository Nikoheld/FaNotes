//! Canvas `shadowBlur`: a Gaussian with σ = blur / 2, approximated by three box blurs.

/// Box width for three passes that approximate σ (SVG filter effects, feGaussianBlur).
fn box_size(sigma: f64) -> usize {
    let size = (sigma * 3.0 * (2.0 * std::f64::consts::PI).sqrt() / 4.0 + 0.5).floor() as usize;
    size.max(1) | 1
}

/// Extra px a blur of this size can reach past the shape.
pub fn blur_reach(blur: f64) -> usize {
    let sigma = blur / 2.0;
    if !(sigma > 0.0) {
        return 0;
    }
    3 * (box_size(sigma) / 2) + 1
}

fn blur_line(source: &[f32], target: &mut [f32], radius: usize) {
    let len = source.len();
    let window = (2 * radius + 1) as f32;
    let mut sum = 0.0_f32;
    for value in source.iter().take(radius.min(len)) {
        sum += value;
    }
    for index in 0..len {
        let enter = index + radius;
        if enter < len {
            sum += source[enter];
        }
        if index > radius {
            sum -= source[index - radius - 1];
        }
        target[index] = (sum / window).max(0.0);
    }
}

/// Blurs a coverage plane in place. Samples past the edges count as empty.
pub fn blur_alpha(alpha: &mut [f32], width: usize, height: usize, blur: f64) {
    let sigma = blur / 2.0;
    if !(sigma > 0.0) || width == 0 || height == 0 {
        return;
    }
    let radius = box_size(sigma) / 2;
    if radius == 0 {
        return;
    }
    let mut line_in = vec![0.0_f32; width.max(height)];
    let mut line_out = vec![0.0_f32; width.max(height)];
    for _ in 0..3 {
        for y in 0..height {
            let row = &mut alpha[y * width..(y + 1) * width];
            line_in[..width].copy_from_slice(row);
            blur_line(&line_in[..width], &mut line_out[..width], radius);
            row.copy_from_slice(&line_out[..width]);
        }
        for x in 0..width {
            for y in 0..height {
                line_in[y] = alpha[y * width + x];
            }
            blur_line(&line_in[..height], &mut line_out[..height], radius);
            for y in 0..height {
                alpha[y * width + x] = line_out[y];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blur_spreads_coverage_and_keeps_its_mass() {
        let (width, height) = (41, 41);
        let mut alpha = vec![0.0_f32; width * height];
        for y in 18..23 {
            for x in 18..23 {
                alpha[y * width + x] = 1.0;
            }
        }
        blur_alpha(&mut alpha, width, height, 8.0);
        let mass: f32 = alpha.iter().sum();
        assert!((mass - 25.0).abs() < 0.5, "{mass}");
        assert!(alpha[20 * width + 20] < 1.0);
        assert!(
            alpha[20 * width + 27] > 0.0,
            "the glow reaches past the shape"
        );
        assert_eq!(alpha[0], 0.0);
        assert!(blur_reach(8.0) >= 7);
    }
}
