//! Personal prototype fusion from `buildRecognitionModel` in `recognition.ts`.
//!
//! The TypeScript functions stay callable. This is the same selection, distance, and
//! prototype blend, including Map insertion order and stable sorts, so a model built
//! here publishes the same weights, prototypes, and holdout score.

use std::cmp::Ordering;
use std::collections::HashMap;

use serde::{Deserialize, Serialize};

const FEATURE_SIZE: usize = 24;
const PERSONAL_PROTOTYPE_WEIGHT: f64 = 0.92;
const MAX_BASE_CLASSIFIER_EXAMPLES_PER_LABEL: usize = 3;
const MAX_CLASSIFIER_EXAMPLES_PER_LABEL: usize = 48;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FusionWeights {
    pub raster: f64,
    pub hog: f64,
    pub projections: f64,
    pub shape: f64,
    pub directions: f64,
    pub geometry: f64,
    pub trajectory: f64,
    pub holes: f64,
    pub strokes: f64,
}

impl FusionWeights {
    const fn defaults() -> Self {
        Self {
            raster: 0.34,
            hog: 0.13,
            projections: 0.07,
            shape: 0.07,
            directions: 0.07,
            geometry: 0.06,
            trajectory: 0.18,
            holes: 0.04,
            strokes: 0.04,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FusionFeature {
    pub raster: Vec<u32>,
    pub projection_x: Vec<u32>,
    pub projection_y: Vec<u32>,
    pub hog: Vec<u32>,
    pub shape: Vec<u32>,
    pub holes: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FusionGeometry {
    pub directions: Vec<u32>,
    pub normalized_length: f64,
    pub closedness: f64,
    pub cornerness: f64,
    pub trajectory: Vec<Vec<u32>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FusionEntry {
    pub sample_id: String,
    pub session_id: String,
    pub label_id: String,
    #[serde(flatten)]
    pub feature: FusionFeature,
    pub stroke_count: i32,
    pub physical_aspect: f64,
    pub geometry: FusionGeometry,
    pub standard: bool,
    pub trust: f64,
    pub created_at: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FusionLabelStats {
    pub personal_count: usize,
    pub trusted_count: usize,
    pub radius: f64,
    pub reliability: f64,
    pub aspect_median: f64,
    pub aspect_spread: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FusionAspectStats {
    pub median: f64,
    pub spread: f64,
    pub personal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FusionModel {
    pub trusts: Vec<FusionTrust>,
    pub weights: FusionWeights,
    pub prototypes: Vec<FusionEntry>,
    pub prototype_sets: Vec<FusionIdGroup>,
    pub classifier_ids: Vec<String>,
    pub label_stats: Vec<FusionLabeled<FusionLabelStats>>,
    pub aspect_stats: Vec<FusionLabeled<FusionAspectStats>>,
    pub estimated_accuracy: Option<f64>,
    pub evaluated_samples: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FusionTrust {
    pub sample_id: String,
    pub trust: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FusionIdGroup {
    pub label_id: String,
    pub sample_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FusionLabeled<T> {
    pub label_id: String,
    pub value: T,
}

struct Feature {
    raster: Vec<f32>,
    projection_x: Vec<f32>,
    projection_y: Vec<f32>,
    hog: Vec<f32>,
    shape: Vec<f32>,
    holes: f64,
}

struct Geometry {
    directions: Vec<f32>,
    normalized_length: f64,
    closedness: f64,
    cornerness: f64,
    trajectory: Vec<Vec<f32>>,
}

struct Entry {
    sample_id: String,
    session_id: String,
    label_id: String,
    feature: Feature,
    stroke_count: i32,
    physical_aspect: f64,
    geometry: Geometry,
    standard: bool,
    trust: f64,
    created_at: f64,
}

struct OrderMap<T> {
    order: Vec<String>,
    values: HashMap<String, T>,
}

impl<T> OrderMap<T> {
    fn new() -> Self {
        Self {
            order: Vec::new(),
            values: HashMap::new(),
        }
    }

    fn get_or_insert_with(&mut self, key: &str, make: impl FnOnce() -> T) -> &mut T {
        if !self.values.contains_key(key) {
            self.order.push(key.to_owned());
            self.values.insert(key.to_owned(), make());
        }
        self.values.get_mut(key).expect("key was just inserted")
    }

    fn contains(&self, key: &str) -> bool {
        self.values.contains_key(key)
    }

    fn get(&self, key: &str) -> Option<&T> {
        self.values.get(key)
    }

    fn iter(&self) -> impl Iterator<Item = (&str, &T)> {
        self.order
            .iter()
            .filter_map(|key| self.values.get(key).map(|value| (key.as_str(), value)))
    }
}

/// Builds the published personal model from already-featurized entries.
/// `trust` on the returned entries is the value after conflict suppression.
pub fn fuse_recognition_model(entries: &[FusionEntry]) -> FusionModel {
    let mut entries: Vec<Entry> = entries.iter().cloned().map(Entry::from).collect();
    suppress_conflicts(&mut entries);
    let personal: Vec<usize> = (0..entries.len())
        .filter(|index| !entries[*index].standard)
        .collect();
    let default_weights = FusionWeights::defaults();
    let (weights, evaluation) = if personal.len() >= 4 {
        let adaptive = learn_weights(&entries, &personal);
        let adaptive_score = estimate_accuracy(&entries, &personal, adaptive);
        let default_score = estimate_accuracy(&entries, &personal, default_weights);
        if adaptive_score.score >= default_score.score {
            (adaptive, Some(adaptive_score))
        } else {
            (default_weights, Some(default_score))
        }
    } else {
        (default_weights, None)
    };
    let prototypes = build_prototypes(&entries);
    let prototype_sets = build_prototype_sets(&entries, weights);
    let classifier_ids = build_classifier_ids(&entries, &prototype_sets);
    let label_stats = build_label_stats(&entries, &personal, &prototype_sets, weights);
    let aspect_stats = build_aspect_stats(&entries);
    let evaluation = evaluation.unwrap_or_else(|| estimate_accuracy(&entries, &personal, weights));
    FusionModel {
        trusts: entries
            .iter()
            .map(|entry| FusionTrust {
                sample_id: entry.sample_id.clone(),
                trust: entry.trust,
            })
            .collect(),
        weights,
        prototypes: prototypes
            .iter()
            .map(|(_, entry)| entry.to_wire())
            .collect(),
        prototype_sets: prototype_sets
            .iter()
            .map(|(label, group)| FusionIdGroup {
                label_id: (*label).to_owned(),
                sample_ids: group
                    .iter()
                    .map(|index| entries[*index].sample_id.clone())
                    .collect(),
            })
            .collect(),
        classifier_ids: classifier_ids
            .iter()
            .map(|index| entries[*index].sample_id.clone())
            .collect(),
        label_stats: label_stats
            .iter()
            .map(|(label, value)| FusionLabeled {
                label_id: (*label).to_owned(),
                value: value.clone(),
            })
            .collect(),
        aspect_stats: aspect_stats
            .iter()
            .map(|(label, value)| FusionLabeled {
                label_id: (*label).to_owned(),
                value: *value,
            })
            .collect(),
        estimated_accuracy: evaluation.accuracy,
        evaluated_samples: evaluation.count,
    }
}

struct Accuracy {
    accuracy: Option<f64>,
    count: usize,
    score: f64,
}

fn suppress_conflicts(entries: &mut [Entry]) {
    let mut personal: Vec<usize> = (0..entries.len())
        .filter(|index| !entries[*index].standard)
        .collect();
    personal.sort_by(|first, second| trust_then_time(&entries[*second], &entries[*first]));
    let mut representatives: OrderMap<Vec<usize>> = OrderMap::new();
    for index in &personal {
        let label = entries[*index].label_id.clone();
        let group = representatives.get_or_insert_with(&label, Vec::new);
        if group.len() < 10 {
            group.push(*index);
        }
    }
    for index in personal {
        let entry = &entries[index];
        let has_newer = representatives
            .get(&entry.label_id)
            .into_iter()
            .flatten()
            .any(|candidate| {
                let other = &entries[*candidate];
                other.session_id != entry.session_id
                    && other.created_at > entry.created_at + 60_000.0
                    && direct_distance(entry, other, FusionWeights::defaults()) >= 0.14
            });
        let mut superseding: Vec<(usize, f64)> = representatives
            .iter()
            .filter(|(label, _)| *label != entry.label_id)
            .flat_map(|(_, group)| group.iter().copied())
            .filter(|candidate| {
                let other = &entries[*candidate];
                (other.trust >= 0.99 && entry.trust <= 0.9 && other.created_at >= entry.created_at)
                    || (entry.trust <= 0.34 && other.trust >= 0.8)
                    || (other.session_id != entry.session_id
                        && other.created_at > entry.created_at + 60_000.0
                        && has_newer)
            })
            .filter(|candidate| (entries[*candidate].stroke_count - entry.stroke_count).abs() <= 1)
            .map(|candidate| {
                (
                    candidate,
                    direct_distance(entry, &entries[candidate], FusionWeights::defaults()),
                )
            })
            .filter(|(_, distance)| *distance <= 0.072)
            .collect();
        superseding.sort_by(|first, second| {
            first
                .1
                .partial_cmp(&second.1)
                .unwrap_or(Ordering::Equal)
                .then_with(|| trust_then_time(&entries[second.0], &entries[first.0]))
        });
        if !superseding.is_empty() {
            entries[index].trust = entries[index].trust.min(0.16);
        }
    }
}

fn build_prototypes(entries: &[Entry]) -> OrderMap<Entry> {
    let mut groups: OrderMap<Vec<usize>> = OrderMap::new();
    for (index, entry) in entries.iter().enumerate() {
        groups
            .get_or_insert_with(&entry.label_id, Vec::new)
            .push(index);
    }
    let mut prototypes = OrderMap::new();
    for (label, group) in groups.iter() {
        let personal: Vec<usize> = group
            .iter()
            .copied()
            .filter(|index| !entries[*index].standard)
            .collect();
        let standard: Vec<usize> = group
            .iter()
            .copied()
            .filter(|index| entries[*index].standard)
            .collect();
        let basis: Vec<usize> = if personal.is_empty() {
            standard.clone()
        } else {
            personal.clone()
        };
        if basis.len() < 2 && !(personal.len() == 1 && !standard.is_empty()) {
            continue;
        }
        let personal_feature = if personal.len() == 1 {
            Some(personal[0])
        } else {
            None
        };
        let standard_feature = if personal_feature.is_some() && !standard.is_empty() {
            Some(Feature {
                raster: average(&standard, entries, |entry| &entry.feature.raster, false),
                projection_x: average(
                    &standard,
                    entries,
                    |entry| &entry.feature.projection_x,
                    false,
                ),
                projection_y: average(
                    &standard,
                    entries,
                    |entry| &entry.feature.projection_y,
                    false,
                ),
                hog: average(&standard, entries, |entry| &entry.feature.hog, true),
                shape: average(&standard, entries, |entry| &entry.feature.shape, false),
                holes: js_round(mean(
                    standard.iter().map(|index| entries[*index].feature.holes),
                )) as f64,
            })
        } else {
            None
        };
        let raster = blend_or_average(
            personal_feature,
            standard_feature
                .as_ref()
                .map(|feature| feature.raster.as_slice()),
            &basis,
            entries,
            select_raster,
            false,
        );
        let projection_x = blend_or_average(
            personal_feature,
            standard_feature
                .as_ref()
                .map(|feature| feature.projection_x.as_slice()),
            &basis,
            entries,
            select_projection_x,
            false,
        );
        let projection_y = blend_or_average(
            personal_feature,
            standard_feature
                .as_ref()
                .map(|feature| feature.projection_y.as_slice()),
            &basis,
            entries,
            select_projection_y,
            false,
        );
        let hog = blend_or_average(
            personal_feature,
            standard_feature
                .as_ref()
                .map(|feature| feature.hog.as_slice()),
            &basis,
            entries,
            select_hog,
            true,
        );
        let shape = blend_or_average(
            personal_feature,
            standard_feature
                .as_ref()
                .map(|feature| feature.shape.as_slice()),
            &basis,
            entries,
            select_shape,
            false,
        );
        let holes = if let (Some(personal_index), Some(standard_feature)) =
            (personal_feature, standard_feature.as_ref())
        {
            js_round(
                entries[personal_index].feature.holes * PERSONAL_PROTOTYPE_WEIGHT
                    + standard_feature.holes * (1.0 - PERSONAL_PROTOTYPE_WEIGHT),
            ) as f64
        } else {
            js_round(mean(
                basis.iter().map(|index| entries[*index].feature.holes),
            )) as f64
        };
        let stroke_count = js_round(mean(
            basis
                .iter()
                .map(|index| f64::from(entries[*index].stroke_count)),
        ));
        let physical_aspect = (mean(
            basis
                .iter()
                .map(|index| entries[*index].physical_aspect.ln()),
        ))
        .exp();
        let directions = average(&basis, entries, |entry| &entry.geometry.directions, true);
        let trajectory = if let Some(index) = personal_feature {
            entries[index].geometry.trajectory.clone()
        } else {
            entries[basis[0]].geometry.trajectory.clone()
        };
        let prototype = Entry {
            sample_id: format!("prototype-{label}"),
            session_id: personal_feature
                .map(|index| entries[index].session_id.clone())
                .unwrap_or_else(|| entries[basis[0]].session_id.clone()),
            label_id: label.to_owned(),
            feature: Feature {
                raster,
                projection_x,
                projection_y,
                hog,
                shape,
                holes,
            },
            stroke_count,
            physical_aspect,
            geometry: Geometry {
                directions,
                normalized_length: mean(
                    basis
                        .iter()
                        .map(|index| entries[*index].geometry.normalized_length),
                ),
                closedness: mean(
                    basis
                        .iter()
                        .map(|index| entries[*index].geometry.closedness),
                ),
                cornerness: mean(
                    basis
                        .iter()
                        .map(|index| entries[*index].geometry.cornerness),
                ),
                trajectory,
            },
            standard: personal.is_empty(),
            trust: if personal.is_empty() {
                0.0
            } else {
                personal
                    .iter()
                    .map(|index| entries[*index].trust)
                    .fold(f64::NEG_INFINITY, f64::max)
            },
            created_at: if personal.is_empty() {
                0.0
            } else {
                personal
                    .iter()
                    .map(|index| entries[*index].created_at)
                    .fold(f64::NEG_INFINITY, f64::max)
            },
        };
        prototypes.get_or_insert_with(label, || prototype);
    }
    prototypes
}

fn blend_or_average(
    personal_feature: Option<usize>,
    standard_values: Option<&[f32]>,
    basis: &[usize],
    entries: &[Entry],
    select: fn(&Entry) -> &Vec<f32>,
    normalize: bool,
) -> Vec<f32> {
    if let (Some(personal_index), Some(standard_values)) = (personal_feature, standard_values) {
        blend(
            select(&entries[personal_index]),
            standard_values,
            PERSONAL_PROTOTYPE_WEIGHT,
            normalize,
        )
    } else {
        average(basis, entries, select, normalize)
    }
}

fn select_raster(entry: &Entry) -> &Vec<f32> {
    &entry.feature.raster
}
fn select_projection_x(entry: &Entry) -> &Vec<f32> {
    &entry.feature.projection_x
}
fn select_projection_y(entry: &Entry) -> &Vec<f32> {
    &entry.feature.projection_y
}
fn select_hog(entry: &Entry) -> &Vec<f32> {
    &entry.feature.hog
}
fn select_shape(entry: &Entry) -> &Vec<f32> {
    &entry.feature.shape
}

fn build_prototype_sets(entries: &[Entry], weights: FusionWeights) -> OrderMap<Vec<usize>> {
    let mut groups: OrderMap<Vec<usize>> = OrderMap::new();
    for (index, entry) in entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| !entry.standard)
    {
        groups
            .get_or_insert_with(&entry.label_id, Vec::new)
            .push(index);
    }
    let mut result = OrderMap::new();
    for (label, group) in groups.iter() {
        if group.is_empty() {
            continue;
        }
        let trusted: Vec<usize> = group
            .iter()
            .copied()
            .filter(|index| entries[*index].trust >= 0.3)
            .collect();
        let usable: Vec<usize> = if trusted.is_empty() {
            group.clone()
        } else {
            trusted
        };
        let maximum = 5.min((usable.len() as f64 / 3.0).sqrt().ceil().max(1.0) as usize);
        let mut ordered = usable;
        ordered.sort_by(|first, second| trust_then_time(&entries[*second], &entries[*first]));
        let mut selected = vec![ordered[0]];
        while selected.len() < maximum && selected.len() < ordered.len() {
            let mut ranked: Vec<usize> = ordered
                .iter()
                .copied()
                .filter(|candidate| !selected.contains(candidate))
                .collect();
            ranked.sort_by(|first, second| {
                let distance = |candidate: usize| {
                    selected
                        .iter()
                        .map(|prototype| {
                            weighted_distance(
                                &channel_distances(&entries[candidate], &entries[*prototype]),
                                weights,
                            )
                        })
                        .fold(f64::INFINITY, f64::min)
                };
                distance(*second)
                    .partial_cmp(&distance(*first))
                    .unwrap_or(Ordering::Equal)
                    .then_with(|| trust_then_time(&entries[*second], &entries[*first]))
            });
            let Some(next) = ranked.first().copied() else {
                break;
            };
            selected.push(next);
        }
        result.get_or_insert_with(label, || selected);
    }
    result
}

fn build_classifier_ids(entries: &[Entry], prototype_sets: &OrderMap<Vec<usize>>) -> Vec<usize> {
    let mut groups: OrderMap<Vec<usize>> = OrderMap::new();
    let mut standard_groups: OrderMap<Vec<usize>> = OrderMap::new();
    for (index, entry) in entries.iter().enumerate() {
        if entry.standard {
            standard_groups
                .get_or_insert_with(&entry.label_id, Vec::new)
                .push(index);
        } else {
            groups
                .get_or_insert_with(&entry.label_id, Vec::new)
                .push(index);
        }
    }
    let mut standard = Vec::new();
    for (label, group) in standard_groups.iter() {
        if groups.contains(label) {
            standard.extend(evenly_spaced(group, MAX_BASE_CLASSIFIER_EXAMPLES_PER_LABEL));
        } else {
            standard.extend(group.iter().copied());
        }
    }
    let mut personal = Vec::new();
    for (label, group) in groups.iter() {
        if group.len() <= MAX_CLASSIFIER_EXAMPLES_PER_LABEL {
            personal.extend(group.iter().copied());
            continue;
        }
        let prototypes = prototype_sets.get(label).cloned().unwrap_or_default();
        let pinned: Vec<usize> = prototypes.clone();
        let mut ordered: Vec<usize> = group
            .iter()
            .copied()
            .filter(|index| !pinned.contains(index))
            .collect();
        ordered.sort_by(|first, second| trust_then_time(&entries[*second], &entries[*first]));
        let mut chosen = prototypes;
        chosen.extend(spread_across_history(
            &ordered,
            MAX_CLASSIFIER_EXAMPLES_PER_LABEL.saturating_sub(chosen.len()),
        ));
        chosen.truncate(MAX_CLASSIFIER_EXAMPLES_PER_LABEL);
        personal.extend(chosen);
    }
    personal.extend(standard);
    personal
}

fn build_aspect_stats(entries: &[Entry]) -> OrderMap<FusionAspectStats> {
    let mut groups: OrderMap<Vec<usize>> = OrderMap::new();
    for (index, entry) in entries.iter().enumerate() {
        groups
            .get_or_insert_with(&entry.label_id, Vec::new)
            .push(index);
    }
    let mut result = OrderMap::new();
    for (label, group) in groups.iter() {
        let personal: Vec<usize> = group
            .iter()
            .copied()
            .filter(|index| !entries[*index].standard && entries[*index].trust >= 0.3)
            .collect();
        let basis: Vec<usize> = if personal.is_empty() {
            group.clone()
        } else {
            personal.clone()
        };
        let logs: Vec<f64> = basis
            .iter()
            .map(|index| entries[*index].physical_aspect.ln())
            .collect();
        let center = percentile(&logs, 0.5);
        let deviations: Vec<f64> = logs.iter().map(|value| (value - center).abs()).collect();
        let spread = if basis.len() > 1 {
            clamp(
                percentile(&deviations, 0.86) * 1.7 + 0.08,
                0.14,
                if personal.is_empty() { 0.58 } else { 0.48 },
            )
        } else if personal.is_empty() {
            0.38
        } else {
            0.3
        };
        result.get_or_insert_with(label, || FusionAspectStats {
            median: center.exp(),
            spread,
            personal: !personal.is_empty(),
        });
    }
    result
}

fn build_label_stats(
    entries: &[Entry],
    personal: &[usize],
    prototypes: &OrderMap<Vec<usize>>,
    weights: FusionWeights,
) -> OrderMap<FusionLabelStats> {
    let mut groups: OrderMap<Vec<usize>> = OrderMap::new();
    for index in personal {
        groups
            .get_or_insert_with(&entries[*index].label_id, Vec::new)
            .push(*index);
    }
    let mut stats = OrderMap::new();
    for (label, group) in groups.iter() {
        let within: Vec<f64> = group
            .iter()
            .filter_map(|entry| {
                let peers: Vec<f64> = group
                    .iter()
                    .filter(|candidate| *candidate != entry)
                    .map(|peer| direct_distance(&entries[*entry], &entries[*peer], weights))
                    .collect();
                if peers.is_empty() {
                    None
                } else {
                    Some(peers.into_iter().fold(f64::INFINITY, f64::min))
                }
            })
            .collect();
        let radius = if within.is_empty() {
            0.19
        } else {
            clamp(percentile(&within, 0.86) * 1.3 + 0.018, 0.055, 0.42)
        };
        let separation: Vec<f64> = group
            .iter()
            .map(|entry| {
                let mut same: Vec<f64> = group
                    .iter()
                    .filter(|candidate| *candidate != entry)
                    .map(|candidate| {
                        direct_distance(&entries[*entry], &entries[*candidate], weights)
                    })
                    .collect();
                same.sort_by(|first, second| first.partial_cmp(second).unwrap_or(Ordering::Equal));
                let same_best = same.first().copied().unwrap_or(radius * 0.7);
                let mut other: Vec<f64> = prototypes
                    .iter()
                    .filter(|(candidate_label, _)| *candidate_label != label)
                    .flat_map(|(_, candidates)| {
                        candidates.iter().map(|candidate| {
                            direct_distance(&entries[*entry], &entries[*candidate], weights)
                        })
                    })
                    .collect();
                other.sort_by(|first, second| first.partial_cmp(second).unwrap_or(Ordering::Equal));
                let other_best = other.first().copied().unwrap_or(same_best + 0.18);
                clamp((other_best - same_best + 0.035) / 0.16, 0.0, 1.0)
            })
            .collect();
        let measured = separation.iter().sum::<f64>() / group.len().max(1) as f64;
        let logs: Vec<f64> = group
            .iter()
            .map(|index| entries[*index].physical_aspect.ln())
            .collect();
        let aspect_median_log = percentile(&logs, 0.5);
        let deviations: Vec<f64> = logs
            .iter()
            .map(|value| (value - aspect_median_log).abs())
            .collect();
        let aspect_spread = if group.len() > 1 {
            clamp(percentile(&deviations, 0.86) * 1.7 + 0.08, 0.14, 0.48)
        } else {
            0.3
        };
        let trusted_count = group
            .iter()
            .filter(|index| entries[**index].trust >= 0.8)
            .count();
        let trusted_ratio = trusted_count as f64 / group.len().max(1) as f64;
        let reliability = measured * (0.42 + trusted_ratio * 0.58);
        stats.get_or_insert_with(label, || FusionLabelStats {
            personal_count: group.len(),
            trusted_count,
            radius,
            aspect_median: aspect_median_log.exp(),
            aspect_spread,
            reliability: if group.len() == 1 {
                reliability.max(0.58)
            } else {
                clamp(reliability, 0.22, 1.0)
            },
        });
    }
    stats
}

fn learn_weights(entries: &[Entry], personal: &[usize]) -> FusionWeights {
    let mut groups: OrderMap<Vec<usize>> = OrderMap::new();
    for index in personal {
        groups
            .get_or_insert_with(&entries[*index].label_id, Vec::new)
            .push(*index);
    }
    for group in groups.values.values_mut() {
        group.sort_by(|first, second| trust_then_time(&entries[*second], &entries[*first]));
    }
    let mut selected = Vec::new();
    let mut depth = 0;
    while selected.len() < 180 {
        let mut added = false;
        for key in &groups.order {
            if selected.len() >= 180 {
                break;
            }
            let Some(group) = groups.values.get(key) else {
                continue;
            };
            let Some(index) = group.get(depth).copied() else {
                continue;
            };
            selected.push(index);
            added = true;
        }
        if !added {
            break;
        }
        depth += 1;
    }
    let mut within = [0.0; 9];
    let mut between = [0.0; 9];
    let mut within_count = 0;
    let mut between_count = 0;
    for first_index in 0..selected.len() {
        for second_index in first_index + 1..selected.len() {
            if between_count + within_count > 5_000 {
                break;
            }
            let distances = channel_distances(
                &entries[selected[first_index]],
                &entries[selected[second_index]],
            );
            let target = if entries[selected[first_index]].label_id
                == entries[selected[second_index]].label_id
            {
                within_count += 1;
                &mut within
            } else {
                between_count += 1;
                &mut between
            };
            let packed = distances.pack();
            for (slot, value) in target.iter_mut().zip(packed) {
                *slot += value;
            }
        }
    }
    if within_count < 2 || between_count < 2 {
        return FusionWeights::defaults();
    }
    let defaults = FusionWeights::defaults().pack();
    let mut weights = [0.0; 9];
    for index in 0..9 {
        let within_mean = within[index] / within_count as f64;
        let between_mean = between[index] / between_count as f64;
        let reliability = clamp((between_mean + 0.035) / (within_mean + 0.035), 0.65, 1.7);
        weights[index] = defaults[index] * reliability;
    }
    let total: f64 = weights.iter().sum();
    for value in &mut weights {
        *value /= total;
    }
    FusionWeights::unpack(weights)
}

fn estimate_accuracy(entries: &[Entry], personal: &[usize], weights: FusionWeights) -> Accuracy {
    let mut groups: OrderMap<Vec<usize>> = OrderMap::new();
    for index in personal {
        groups
            .get_or_insert_with(&entries[*index].label_id, Vec::new)
            .push(*index);
    }
    let eligible: Vec<Vec<usize>> = groups
        .iter()
        .filter_map(|(_, group)| {
            if group.len() <= 1 {
                return None;
            }
            let mut ordered = group.clone();
            ordered.sort_by(|first, second| trust_then_time(&entries[*second], &entries[*first]));
            Some(ordered)
        })
        .collect();
    let mut evaluated = Vec::new();
    let mut depth = 0;
    while evaluated.len() < 128 {
        let mut added = false;
        for group in &eligible {
            if evaluated.len() >= 128 || depth >= 4 {
                break;
            }
            let Some(index) = group.get(depth).copied() else {
                continue;
            };
            evaluated.push(index);
            added = true;
        }
        if !added {
            break;
        }
        depth += 1;
    }
    if evaluated.len() < 4 {
        return Accuracy {
            accuracy: None,
            count: 0,
            score: -1.0,
        };
    }
    let mut results: OrderMap<(i32, i32)> = OrderMap::new();
    for entry in &evaluated {
        let mut by_label: OrderMap<Vec<usize>> = OrderMap::new();
        for candidate in evaluated
            .iter()
            .copied()
            .filter(|candidate| entries[*candidate].sample_id != entries[*entry].sample_id)
        {
            by_label
                .get_or_insert_with(&entries[candidate].label_id, Vec::new)
                .push(candidate);
        }
        let mut nearest: Vec<(String, f64)> = by_label
            .iter()
            .map(|(label, candidates)| {
                let cross: Vec<usize> = candidates
                    .iter()
                    .copied()
                    .filter(|candidate| {
                        entries[*candidate].session_id != entries[*entry].session_id
                    })
                    .collect();
                let usable: &[usize] = if cross.is_empty() { candidates } else { &cross };
                let mut distances: Vec<f64> = usable
                    .iter()
                    .map(|candidate| {
                        weighted_distance(
                            &channel_distances(&entries[*entry], &entries[*candidate]),
                            weights,
                        )
                    })
                    .collect();
                distances
                    .sort_by(|first, second| first.partial_cmp(second).unwrap_or(Ordering::Equal));
                let consensus = [0.62, 0.25, 0.13];
                let used = distances.len().min(consensus.len());
                let weight_total: f64 = consensus[..used].iter().sum();
                let distance = distances
                    .iter()
                    .take(used)
                    .enumerate()
                    .map(|(index, value)| value * consensus[index])
                    .sum::<f64>()
                    / weight_total.max(f64::EPSILON);
                ((*label).to_owned(), distance)
            })
            .collect();
        nearest.sort_by(|first, second| first.1.partial_cmp(&second.1).unwrap_or(Ordering::Equal));
        let slot = results.get_or_insert_with(&entries[*entry].label_id, || (0, 0));
        slot.1 += 1;
        if nearest
            .first()
            .is_some_and(|(label, _)| label == &entries[*entry].label_id)
        {
            slot.0 += 1;
        }
    }
    let class_scores: Vec<f64> = results
        .iter()
        .map(|(_, (correct, count))| f64::from(*correct) / (*count).max(1) as f64)
        .collect();
    let score = class_scores.iter().sum::<f64>() / class_scores.len().max(1) as f64;
    Accuracy {
        accuracy: Some((score * 1_000.0).round() / 10.0),
        count: evaluated.len(),
        score,
    }
}

fn direct_distance(first: &Entry, second: &Entry, weights: FusionWeights) -> f64 {
    weighted_distance(&channel_distances(first, second), weights)
}

fn channel_distances(first: &Entry, second: &Entry) -> FusionWeights {
    FusionWeights {
        raster: 1.0 - shifted_cosine(&first.feature.raster, &second.feature.raster),
        hog: 1.0 - vector_cosine(&first.feature.hog, &second.feature.hog),
        projections: projection_distance(first, second),
        shape: mean_distance(&first.feature.shape, &second.feature.shape),
        directions: 1.0 - vector_cosine(&first.geometry.directions, &second.geometry.directions),
        geometry: (first.geometry.normalized_length - second.geometry.normalized_length).abs()
            * 0.35
            + (first.geometry.closedness - second.geometry.closedness).abs() * 0.4
            + (first.geometry.cornerness - second.geometry.cornerness).abs() * 0.25,
        trajectory: trajectory_set_distance(
            &first.geometry.trajectory,
            &second.geometry.trajectory,
        ),
        holes: (first.feature.holes - second.feature.holes).abs().min(2.0) / 2.0,
        strokes: (f64::from(first.stroke_count - second.stroke_count))
            .abs()
            .min(3.0)
            / 3.0,
    }
}

fn weighted_distance(channels: &FusionWeights, weights: FusionWeights) -> f64 {
    channels.raster * weights.raster
        + channels.hog * weights.hog
        + channels.projections * weights.projections
        + channels.shape * weights.shape
        + channels.directions * weights.directions
        + channels.geometry * weights.geometry
        + channels.trajectory * weights.trajectory
        + channels.holes * weights.holes
        + channels.strokes * weights.strokes
}

fn shifted_cosine(first: &[f32], second: &[f32]) -> f64 {
    let mut best = 0.0f64;
    for shift_y in -1..=1 {
        for shift_x in -1..=1 {
            let mut product = 0.0;
            let mut first_magnitude = 0.0;
            let mut second_magnitude = 0.0;
            for y in 0..FEATURE_SIZE {
                let shifted_y = y as isize + shift_y;
                if shifted_y < 0 || shifted_y >= FEATURE_SIZE as isize {
                    continue;
                }
                for x in 0..FEATURE_SIZE {
                    let shifted_x = x as isize + shift_x;
                    if shifted_x < 0 || shifted_x >= FEATURE_SIZE as isize {
                        continue;
                    }
                    let a = f64::from(first[y * FEATURE_SIZE + x]);
                    let b =
                        f64::from(second[shifted_y as usize * FEATURE_SIZE + shifted_x as usize]);
                    product += a * b;
                    first_magnitude += a * a;
                    second_magnitude += b * b;
                }
            }
            let similarity = product / (first_magnitude * second_magnitude).max(0.000001).sqrt();
            best = best.max(similarity);
        }
    }
    best
}

fn vector_cosine(first: &[f32], second: &[f32]) -> f64 {
    let mut product = 0.0;
    let mut first_magnitude = 0.0;
    let mut second_magnitude = 0.0;
    for index in 0..first.len().min(second.len()) {
        let a = f64::from(first[index]);
        let b = f64::from(second[index]);
        product += a * b;
        first_magnitude += a * a;
        second_magnitude += b * b;
    }
    if first_magnitude < 0.000001 && second_magnitude < 0.000001 {
        return 1.0;
    }
    if first_magnitude < 0.000001 || second_magnitude < 0.000001 {
        return 0.0;
    }
    product / (first_magnitude * second_magnitude).sqrt()
}

fn mean_distance(first: &[f32], second: &[f32]) -> f64 {
    let length = first.len().min(second.len());
    if length == 0 {
        return 0.0;
    }
    let distance: f64 = (0..length)
        .map(|index| (f64::from(first[index]) - f64::from(second[index])).abs())
        .sum();
    distance / length as f64
}

fn projection_distance(first: &Entry, second: &Entry) -> f64 {
    let mut distance = 0.0;
    for index in 0..FEATURE_SIZE {
        distance += (f64::from(first.feature.projection_x[index])
            - f64::from(second.feature.projection_x[index]))
        .abs();
        distance += (f64::from(first.feature.projection_y[index])
            - f64::from(second.feature.projection_y[index]))
        .abs();
    }
    distance / (FEATURE_SIZE * 2) as f64
}

fn trajectory_path_distance(first: &[f32], second: &[f32], reverse_second: bool) -> f64 {
    let points = first.len().min(second.len()) / 4;
    if points == 0 {
        return 1.0;
    }
    let mut distance = 0.0;
    for index in 0..points {
        let second_index = if reverse_second {
            points - 1 - index
        } else {
            index
        };
        let first_offset = index * 4;
        let second_offset = second_index * 4;
        let position = (f64::from(first[first_offset]) - f64::from(second[second_offset]))
            .hypot(f64::from(first[first_offset + 1]) - f64::from(second[second_offset + 1]));
        let tangent = (f64::from(first[first_offset + 2]) * f64::from(second[second_offset + 2])
            + f64::from(first[first_offset + 3]) * f64::from(second[second_offset + 3]))
        .abs();
        distance +=
            clamp(position / 0.48, 0.0, 1.0) * 0.76 + (1.0 - clamp(tangent, 0.0, 1.0)) * 0.24;
    }
    distance / points as f64
}

fn trajectory_set_distance(first: &[Vec<f32>], second: &[Vec<f32>]) -> f64 {
    if first.is_empty() && second.is_empty() {
        return 0.0;
    }
    if first.is_empty() || second.is_empty() {
        return 1.0;
    }
    let (smaller, larger) = if first.len() <= second.len() {
        (first, second)
    } else {
        (second, first)
    };
    let costs: Vec<Vec<f64>> = smaller
        .iter()
        .map(|path| {
            larger
                .iter()
                .map(|candidate| {
                    trajectory_path_distance(path, candidate, false)
                        .min(trajectory_path_distance(path, candidate, true))
                })
                .collect()
        })
        .collect();
    let matched = if smaller.len() == 1 {
        costs[0].iter().copied().fold(f64::INFINITY, f64::min)
    } else if larger.len() <= 8 {
        let state_count = 1usize << larger.len();
        let mut states = vec![f64::INFINITY; state_count];
        states[0] = 0.0;
        for row in &costs {
            let mut next = vec![f64::INFINITY; state_count];
            for (mask, score) in states.iter().copied().enumerate() {
                if !score.is_finite() {
                    continue;
                }
                for (index, cost) in row.iter().copied().enumerate() {
                    if mask & (1 << index) != 0 {
                        continue;
                    }
                    let next_mask = mask | (1 << index);
                    next[next_mask] = next[next_mask].min(score + cost);
                }
            }
            states = next;
        }
        states.into_iter().fold(f64::INFINITY, f64::min)
    } else {
        let mut used = vec![false; larger.len()];
        let mut total = 0.0;
        for row in &costs {
            let mut best_index = None;
            let mut best_cost = f64::INFINITY;
            for (index, cost) in row.iter().copied().enumerate() {
                if !used[index] && cost < best_cost {
                    best_index = Some(index);
                    best_cost = cost;
                }
            }
            if let Some(index) = best_index {
                used[index] = true;
                total += best_cost;
            }
        }
        total
    };
    let unmatched = larger.len() - smaller.len();
    clamp(
        (matched + unmatched as f64 * 0.58) / larger.len() as f64,
        0.0,
        1.0,
    )
}

fn average(
    indexes: &[usize],
    entries: &[Entry],
    select: fn(&Entry) -> &Vec<f32>,
    normalize: bool,
) -> Vec<f32> {
    let length = select(&entries[indexes[0]]).len();
    let mut output = vec![0.0f32; length];
    for index in indexes {
        let values = select(&entries[*index]);
        for (slot, value) in output.iter_mut().zip(values) {
            *slot = (f64::from(*slot) + f64::from(*value)) as f32;
        }
    }
    let count = indexes.len() as f64;
    for value in &mut output {
        *value = (f64::from(*value) / count) as f32;
    }
    if normalize {
        normalize_vector(&mut output);
    }
    output
}

fn blend(personal: &[f32], baseline: &[f32], personal_weight: f64, normalize: bool) -> Vec<f32> {
    let mut output: Vec<f32> = personal
        .iter()
        .zip(baseline)
        .map(|(personal, baseline)| {
            (f64::from(*personal) * personal_weight
                + f64::from(*baseline) * (1.0 - personal_weight)) as f32
        })
        .collect();
    if normalize {
        normalize_vector(&mut output);
    }
    output
}

fn normalize_vector(vector: &mut [f32]) {
    let magnitude = vector
        .iter()
        .map(|value| f64::from(*value) * f64::from(*value))
        .sum::<f64>()
        .sqrt();
    if magnitude > 0.000001 {
        for value in vector {
            *value = (f64::from(*value) / magnitude) as f32;
        }
    }
}

fn mean(values: impl Iterator<Item = f64> + Clone) -> f64 {
    let count = values.clone().count();
    if count == 0 {
        return 0.0;
    }
    values.sum::<f64>() / count as f64
}

fn percentile(values: &[f64], fraction: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|first, second| first.partial_cmp(second).unwrap_or(Ordering::Equal));
    sorted[((sorted.len() - 1) as f64 * fraction).floor() as usize]
}

fn spread_across_history(samples: &[usize], maximum: usize) -> Vec<usize> {
    if samples.len() <= maximum {
        return samples.to_vec();
    }
    let recent_count = samples.len().min((maximum as f64 * 0.58).ceil() as usize);
    let mut selected = samples[..recent_count].to_vec();
    let history = &samples[recent_count..];
    let remaining = maximum - selected.len();
    for index in 0..remaining {
        let source_index = (history.len() - 1)
            .min(((index as f64 + 0.5) * history.len() as f64 / remaining as f64).floor() as usize);
        selected.push(history[source_index]);
    }
    selected
}

fn evenly_spaced(values: &[usize], maximum: usize) -> Vec<usize> {
    if values.len() <= maximum {
        return values.to_vec();
    }
    if maximum <= 1 {
        return values[..maximum].to_vec();
    }
    (0..maximum)
        .map(|index| {
            let slot = js_round(index as f64 * (values.len() - 1) as f64 / (maximum - 1) as f64);
            values[slot as usize]
        })
        .collect()
}

fn trust_then_time(first: &Entry, second: &Entry) -> Ordering {
    first
        .trust
        .partial_cmp(&second.trust)
        .unwrap_or(Ordering::Equal)
        .then_with(|| {
            first
                .created_at
                .partial_cmp(&second.created_at)
                .unwrap_or(Ordering::Equal)
        })
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

fn js_round(value: f64) -> i32 {
    value.floor() as i32 + i32::from(value - value.floor() >= 0.5)
}

impl FusionWeights {
    fn pack(self) -> [f64; 9] {
        [
            self.raster,
            self.hog,
            self.projections,
            self.shape,
            self.directions,
            self.geometry,
            self.trajectory,
            self.holes,
            self.strokes,
        ]
    }

    fn unpack(values: [f64; 9]) -> Self {
        Self {
            raster: values[0],
            hog: values[1],
            projections: values[2],
            shape: values[3],
            directions: values[4],
            geometry: values[5],
            trajectory: values[6],
            holes: values[7],
            strokes: values[8],
        }
    }
}

impl Entry {
    fn from(entry: FusionEntry) -> Self {
        Self {
            sample_id: entry.sample_id,
            session_id: entry.session_id,
            label_id: entry.label_id,
            feature: Feature::from(entry.feature),
            stroke_count: entry.stroke_count,
            physical_aspect: entry.physical_aspect,
            geometry: Geometry::from(entry.geometry),
            standard: entry.standard,
            trust: entry.trust,
            created_at: entry.created_at,
        }
    }

    fn to_wire(&self) -> FusionEntry {
        FusionEntry {
            sample_id: self.sample_id.clone(),
            session_id: self.session_id.clone(),
            label_id: self.label_id.clone(),
            feature: self.feature.to_wire(),
            stroke_count: self.stroke_count,
            physical_aspect: self.physical_aspect,
            geometry: self.geometry.to_wire(),
            standard: self.standard,
            trust: self.trust,
            created_at: self.created_at,
        }
    }
}

impl Feature {
    fn from(feature: FusionFeature) -> Self {
        Self {
            raster: bits(&feature.raster),
            projection_x: bits(&feature.projection_x),
            projection_y: bits(&feature.projection_y),
            hog: bits(&feature.hog),
            shape: bits(&feature.shape),
            holes: feature.holes,
        }
    }

    fn to_wire(&self) -> FusionFeature {
        FusionFeature {
            raster: wire_bits(&self.raster),
            projection_x: wire_bits(&self.projection_x),
            projection_y: wire_bits(&self.projection_y),
            hog: wire_bits(&self.hog),
            shape: wire_bits(&self.shape),
            holes: self.holes,
        }
    }
}

impl Geometry {
    fn from(geometry: FusionGeometry) -> Self {
        Self {
            directions: bits(&geometry.directions),
            normalized_length: geometry.normalized_length,
            closedness: geometry.closedness,
            cornerness: geometry.cornerness,
            trajectory: geometry.trajectory.iter().map(|path| bits(path)).collect(),
        }
    }

    fn to_wire(&self) -> FusionGeometry {
        FusionGeometry {
            directions: wire_bits(&self.directions),
            normalized_length: self.normalized_length,
            closedness: self.closedness,
            cornerness: self.cornerness,
            trajectory: self.trajectory.iter().map(|path| wire_bits(path)).collect(),
        }
    }
}

fn bits(values: &[u32]) -> Vec<f32> {
    values.iter().copied().map(f32::from_bits).collect()
}

fn wire_bits(values: &[f32]) -> Vec<u32> {
    values.iter().copied().map(f32::to_bits).collect()
}

impl FusionEntry {
    // serde clone comes from Clone
}
