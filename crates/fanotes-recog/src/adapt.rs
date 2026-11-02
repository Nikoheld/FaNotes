//! Personal adaptation of the ink recognizer's output layer.
//!
//! The line model is split at its last hidden layer: the backbone and recurrent encoder stay
//! frozen, and only the classifier changes. A low-rank update `W = W0 + A·B` plus a bias shift is
//! fitted to the writer's own labelled lines with the CTC loss, pulled back towards the shipped
//! weights so a few dozen lines cannot overwrite the general model.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AdaptOptions {
    pub rank: usize,
    pub iterations: usize,
    pub learning_rate: f32,
    /// L2 pull of the update towards zero (i.e. towards the shipped classifier).
    pub weight_decay: f32,
    pub seed: u64,
}

impl Default for AdaptOptions {
    fn default() -> Self {
        Self {
            rank: 8,
            iterations: 120,
            learning_rate: 0.02,
            weight_decay: 0.02,
            seed: 7,
        }
    }
}

/// One labelled line: encoder features `[frames, dim]` and target class indexes (no blanks).
pub struct AdaptSample<'a> {
    pub features: &'a [f32],
    pub labels: &'a [u32],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadUpdate {
    pub classes: usize,
    pub dim: usize,
    pub rank: usize,
    /// `[classes, rank]`
    pub a: Vec<f32>,
    /// `[rank, dim]`
    pub b: Vec<f32>,
    /// `[classes]`
    pub bias: Vec<f32>,
    /// Mean CTC loss per line before and after fitting.
    pub loss_before: f32,
    pub loss_after: f32,
}

impl HeadUpdate {
    /// Adds `A·B·h + bias` to base logits computed from the same features.
    pub fn apply(&self, features: &[f32], logits: &mut [f32]) {
        let frames = features.len() / self.dim;
        let mut projected = vec![0f32; self.rank];
        for frame in 0..frames {
            let h = &features[frame * self.dim..(frame + 1) * self.dim];
            for (r, value) in projected.iter_mut().enumerate() {
                *value = dot(&self.b[r * self.dim..(r + 1) * self.dim], h);
            }
            let row = &mut logits[frame * self.classes..(frame + 1) * self.classes];
            for (class, logit) in row.iter_mut().enumerate() {
                *logit += self.bias[class]
                    + dot(
                        &self.a[class * self.rank..(class + 1) * self.rank],
                        &projected,
                    );
            }
        }
    }
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

const NEG_INF: f64 = f64::NEG_INFINITY;

fn log_add(a: f64, b: f64) -> f64 {
    if a == NEG_INF {
        return b;
    }
    if b == NEG_INF {
        return a;
    }
    let (high, low) = if a > b { (a, b) } else { (b, a) };
    high + (low - high).exp().ln_1p()
}

/// CTC loss of `labels` under `logits` and its gradient with respect to the logits.
/// Returns `None` when the line is too short to hold the labels.
pub fn ctc_loss_and_gradient(
    logits: &[f32],
    classes: usize,
    labels: &[u32],
) -> Option<(f64, Vec<f32>)> {
    let frames = logits.len() / classes;
    let states = labels.len() * 2 + 1;
    let label = |s: usize| {
        if s.is_multiple_of(2) {
            0usize
        } else {
            labels[s / 2] as usize
        }
    };
    let mut log_y = vec![0f64; logits.len()];
    let mut prob = vec![0f64; logits.len()];
    for frame in 0..frames {
        let row = &logits[frame * classes..(frame + 1) * classes];
        let max = row.iter().copied().fold(f32::NEG_INFINITY, f32::max) as f64;
        let sum: f64 = row.iter().map(|&v| (v as f64 - max).exp()).sum();
        for class in 0..classes {
            let value = row[class] as f64 - max - sum.ln();
            log_y[frame * classes + class] = value;
            prob[frame * classes + class] = value.exp();
        }
    }
    let skip = |s: usize| s >= 2 && s % 2 == 1 && labels[s / 2] != labels[s / 2 - 1];
    let mut alpha = vec![NEG_INF; frames * states];
    alpha[0] = log_y[label(0)];
    if states > 1 {
        alpha[1] = log_y[label(1)];
    }
    for t in 1..frames {
        for s in 0..states {
            let mut value = alpha[(t - 1) * states + s];
            if s >= 1 {
                value = log_add(value, alpha[(t - 1) * states + s - 1]);
            }
            if skip(s) {
                value = log_add(value, alpha[(t - 1) * states + s - 2]);
            }
            if value > NEG_INF {
                alpha[t * states + s] = value + log_y[t * classes + label(s)];
            }
        }
    }
    let last = (frames - 1) * states;
    let total = if states > 1 {
        log_add(alpha[last + states - 1], alpha[last + states - 2])
    } else {
        alpha[last]
    };
    if total == NEG_INF {
        return None;
    }
    let mut beta = vec![NEG_INF; frames * states];
    beta[last + states - 1] = log_y[(frames - 1) * classes + label(states - 1)];
    if states > 1 {
        beta[last + states - 2] = log_y[(frames - 1) * classes + label(states - 2)];
    }
    for t in (0..frames - 1).rev() {
        for s in 0..states {
            let mut value = beta[(t + 1) * states + s];
            if s + 1 < states {
                value = log_add(value, beta[(t + 1) * states + s + 1]);
            }
            if s + 2 < states && skip(s + 2) {
                value = log_add(value, beta[(t + 1) * states + s + 2]);
            }
            if value > NEG_INF {
                beta[t * states + s] = value + log_y[t * classes + label(s)];
            }
        }
    }
    let mut gradient = vec![0f32; logits.len()];
    let mut occupancy = vec![NEG_INF; classes];
    for t in 0..frames {
        occupancy.iter_mut().for_each(|value| *value = NEG_INF);
        for s in 0..states {
            let class = label(s);
            let value = alpha[t * states + s] + beta[t * states + s] - log_y[t * classes + class];
            occupancy[class] = log_add(occupancy[class], value);
        }
        for class in 0..classes {
            let posterior = (occupancy[class] - total).exp();
            gradient[t * classes + class] = (prob[t * classes + class] - posterior) as f32;
        }
    }
    Some((-total, gradient))
}

struct Adam {
    m: Vec<f32>,
    v: Vec<f32>,
    step: i32,
}

impl Adam {
    fn new(size: usize) -> Self {
        Self {
            m: vec![0.0; size],
            v: vec![0.0; size],
            step: 0,
        }
    }

    fn update(&mut self, weights: &mut [f32], gradient: &[f32], learning_rate: f32) {
        self.step += 1;
        let (beta1, beta2) = (0.9f32, 0.999f32);
        let correction1 = 1.0 - beta1.powi(self.step);
        let correction2 = 1.0 - beta2.powi(self.step);
        for index in 0..weights.len() {
            let g = gradient[index];
            self.m[index] = beta1 * self.m[index] + (1.0 - beta1) * g;
            self.v[index] = beta2 * self.v[index] + (1.0 - beta2) * g * g;
            let m = self.m[index] / correction1;
            let v = self.v[index] / correction2;
            weights[index] -= learning_rate * m / (v.sqrt() + 1e-8);
        }
    }
}

fn base_logits(
    features: &[f32],
    weight: &[f32],
    bias: &[f32],
    classes: usize,
    dim: usize,
) -> Vec<f32> {
    let frames = features.len() / dim;
    let mut out = vec![0f32; frames * classes];
    for frame in 0..frames {
        let h = &features[frame * dim..(frame + 1) * dim];
        for class in 0..classes {
            out[frame * classes + class] =
                bias[class] + dot(&weight[class * dim..(class + 1) * dim], h);
        }
    }
    out
}

/// Fits a [`HeadUpdate`] to `samples`. `weight` is the shipped classifier `[classes, dim]`.
pub fn adapt_head(
    samples: &[AdaptSample<'_>],
    weight: &[f32],
    bias: &[f32],
    classes: usize,
    dim: usize,
    options: &AdaptOptions,
) -> Option<HeadUpdate> {
    if classes == 0
        || dim == 0
        || weight.len() != classes * dim
        || bias.len() != classes
        || options.rank == 0
    {
        return None;
    }
    let usable: Vec<(&AdaptSample<'_>, Vec<f32>)> = samples
        .iter()
        .filter(|sample| {
            !sample.labels.is_empty()
                && sample.features.len() % dim == 0
                && sample.features.len() / dim > sample.labels.len() * 2
                && sample
                    .labels
                    .iter()
                    .all(|&label| (label as usize) < classes && label != 0)
        })
        .map(|sample| {
            (
                sample,
                base_logits(sample.features, weight, bias, classes, dim),
            )
        })
        .collect();
    if usable.is_empty() {
        return None;
    }
    let rank = options.rank;
    let mut seed = options.seed.max(1);
    let mut random = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        ((seed >> 11) as f64 / (1u64 << 53) as f64) as f32 - 0.5
    };
    let scale = 1.0 / (dim as f32).sqrt();
    let mut update = HeadUpdate {
        classes,
        dim,
        rank,
        a: vec![0.0; classes * rank],
        b: (0..rank * dim).map(|_| random() * 2.0 * scale).collect(),
        bias: vec![0.0; classes],
        loss_before: 0.0,
        loss_after: 0.0,
    };
    let mut adam_a = Adam::new(update.a.len());
    let mut adam_b = Adam::new(update.b.len());
    let mut adam_bias = Adam::new(update.bias.len());
    let count = usable.len() as f32;
    for iteration in 0..=options.iterations {
        let mut grad_a = vec![0f32; update.a.len()];
        let mut grad_b = vec![0f32; update.b.len()];
        let mut grad_bias = vec![0f32; update.bias.len()];
        let mut loss = 0f64;
        for (sample, base) in &usable {
            let mut logits = base.clone();
            update.apply(sample.features, &mut logits);
            let Some((value, gradient)) = ctc_loss_and_gradient(&logits, classes, sample.labels)
            else {
                continue;
            };
            loss += value;
            let frames = sample.features.len() / dim;
            let mut projected = vec![0f32; rank];
            let mut back = vec![0f32; rank];
            for frame in 0..frames {
                let h = &sample.features[frame * dim..(frame + 1) * dim];
                let g = &gradient[frame * classes..(frame + 1) * classes];
                for (r, value) in projected.iter_mut().enumerate() {
                    *value = dot(&update.b[r * dim..(r + 1) * dim], h);
                }
                back.iter_mut().for_each(|value| *value = 0.0);
                for class in 0..classes {
                    let gc = g[class];
                    if gc.abs() < 1e-7 {
                        continue;
                    }
                    grad_bias[class] += gc;
                    for r in 0..rank {
                        grad_a[class * rank + r] += gc * projected[r];
                        back[r] += gc * update.a[class * rank + r];
                    }
                }
                for r in 0..rank {
                    if back[r] == 0.0 {
                        continue;
                    }
                    let row = &mut grad_b[r * dim..(r + 1) * dim];
                    for (target, &value) in row.iter_mut().zip(h) {
                        *target += back[r] * value;
                    }
                }
            }
        }
        let mean_loss = (loss / f64::from(count)) as f32;
        if iteration == 0 {
            update.loss_before = mean_loss;
        }
        update.loss_after = mean_loss;
        if iteration == options.iterations {
            break;
        }
        let decay = options.weight_decay;
        for (g, w) in grad_a.iter_mut().zip(&update.a) {
            *g = *g / count + decay * w;
        }
        for (g, w) in grad_b.iter_mut().zip(&update.b) {
            *g = *g / count + decay * w;
        }
        for (g, w) in grad_bias.iter_mut().zip(&update.bias) {
            *g = *g / count + decay * w;
        }
        let rate = options.learning_rate
            * (0.5
                + 0.5
                    * (std::f32::consts::PI * iteration as f32 / options.iterations as f32).cos());
        adam_a.update(&mut update.a, &grad_a, rate);
        adam_b.update(&mut update.b, &grad_b, rate);
        adam_bias.update(&mut update.bias, &grad_bias, rate);
    }
    Some(update)
}
