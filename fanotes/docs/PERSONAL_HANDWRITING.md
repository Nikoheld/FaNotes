# Local personal handwriting, engine 2

Implemented for the **Linux desktop and Android tablet app**. Windows and Web keep their existing synthesis route. No release, update feed, website, or server deployment is part of this change.

## What changed and why

The fallback also now preserves original glyph aspect ratios instead of forcing all letters into square proportions. The previous engine selected isolated glyphs independently, displaced their baselines by up to 22% of an em, added arbitrary sinusoidal deformation/pressure, chose entry/exit anchors from either end of a stroke, and painted a separate cubic connector. The anchor choice could reverse the intended pen direction. A visually touching connector still represented a separate pen-down event, with different width and timing. Android's school-script recognition also depended on the old connector point count.

Engine 2 models reusable **pen trajectories**, with complete words and context fragments ahead of isolated-letter fallbacks. It learns geometry independently of labels, preserves source pen lifts, and splices feasible letter bodies into one editable stroke. It does not claim to recover unknown letter identities from unlabeled cursive.

## Ordinary-page learning

The source is `payload.ink` in current `.famd` companions, including the existing packed codec. Historical `.md` / `.markdown` notes with a live `fanotes-ink` reference can supply their `.fanotes/assets/<id>.json` ink. Companions take precedence, so clearing a current page does not resurrect its older asset. Linux also walks configured folder locations. Deleted notes' orphan assets, history snapshots, trash, art symbols, figure stamps, and generated strokes do not supply training data.

Points remain native normalized x/y coordinates on disk. Extraction converts them to **page pixels before measuring distance, slope, line membership, or curvature**. This prevents rectangular-page distortion. Delayed dots and crossbars attach geometrically; stroke order, timing, tilt, and pressure remain available. Explicit drawing tools are excluded, as are isolated straight marks and small isolated loops. The geometric text/drawing filter is conservative, not a semantic diagram recognizer.

Every discovered page gets its own replaceable contribution and source identity. Page edits replace that contribution; copies of identical stroke geometry get one vote; deletion retracts it after a complete collection listing. A malformed or unavailable page keeps its last good checkpoint and is retried. Android saves persist explicit dirty paths as well as using mtime/size, so a provider with coarse timestamps cannot hide an equal-size edit.

Two learning objectives are independent:

1. **Without transcripts:** learn slant, writing height distribution, nib/height ratio, empirical pressure, baseline displacement, intra-word and inter-word spacing, speed, and evidence of connected versus lifted writing. Short rightward baseline movements supply actual joining-motion exemplars without assigning characters.
2. **With strong local shape evidence:** compare geometrically segmented ink against trusted local letter trajectories using arc-length resampling. Every cluster must have normalized RMS error at most `0.035` and an error margin of at least `0.025` against a different label. These are geometric errors, **not calibrated OCR probabilities**. Ambiguous labels reject the word. The accepted word supplies complete trajectories, pairs, triplets, and neighboring-character context. Arbitrary search transcripts, page Markdown, dictionary guesses, and earlier automatic context samples are not ground truth.

Imported GlyphenWerk strokes and explicit corrections remain useful but are optional. There is no alphabet-writing or labeling requirement in the normal workflow.

## Generation and connections

A longest-matching trajectory is preferred, with context-specific variants when available. A word that exceeds the writable width falls back to smaller fragments before layout, rather than clipping a long trajectory. Known word geometry preserves proportions, pen lifts, and source pressure. Unknown shapes use the bundled school script, adapted to learned style. `äöü`, capitals, numbers, punctuation, and `ß` / `ẞ` are supported; synthesis preserves the requested sharp-s rather than applying the editor's Swiss spelling preference. Canonically equivalent input is normalized to NFC.

An isolated-letter fallback uses the directed longest pen-down body. It never reverses a stroke to select a convenient anchor. A quintic Hermite splice matches endpoint velocity directions and estimated accelerations. A compatible observed joining motion adds a bounded cubic B-spline residual with zero position, first derivative, and second derivative at the splice endpoints. Thus the learned motion does not undo the endpoint constraints. The sampled output is still a finite polyline, not an analytic spline renderer.

Backward-facing endpoints, excessive gaps, large vertical displacement, overshoot, or excessive transition length cause a **pen lift**. A printing style is allowed to stay printed. Feasible bodies merge into one stroke; delayed marks remain separate. No overlay connector or straight bridge is added. Final timestamps use arc length, bounded source timing, and smoothed velocity. Native source boundaries stored in synthesis metadata let Android's school matcher inspect merged geometry without reading any text labels.

Variation comes from alternative trajectories and correlated empirical style observations. Shape, width, and pressure already present in personal samples are retained. The new engine does not inject unconstrained per-point noise. With no relevant observations or alternative samples, regenerating may produce the same shapes; the UI does not promise otherwise.

## Bounded model and update validation

A page keeps at most 48 style observations, 32 joining motions, and 16 labeled units; a labeled unit has at most 768 points. Complete words take priority over redundant short fragments. Extraction bounds individual stroke sampling and skips files over 32 MiB. These limits affect the learning cache, never the user's original ink.

All page summaries inform the dominant style center. Copies share one vote. A deterministic reservoir of at most 48 distinct pages provides the heavier trajectory/style variants; full per-page checkpoints stay on disk. This bounds active model memory while allowing the collection to grow. Summaries are recomputed in batches, and unchanged pages skip extraction and matching.

When there are at least two independent held-out pages and five training pages, an update's style-center reconstruction error is checked against the previous center on the held-out pages. A worse center is rejected while new data remains available for later updates. This evaluates **geometry**, not spelling, legibility, or perceptual identity. Smaller collections do not display or fabricate a validation score. Recognition ambiguity checks, finite geometry checks, version checks, and bounded sample counts apply before checkpoint promotion. Deletion recomputes the remaining population rather than retaining a deleted page's center.

## Background execution, persistence, privacy

- Linux: one Node worker thread, deferred startup, a 120-second discovery interval, and a coalesced delay after saves. The renderer uses a separate module worker for preview/generation. Status polls omit unchanged models, and typed preview requests reuse cached model/library data rather than recopying it on every keystroke. Vault changes terminate the previous learner. Per-vault cache: `<userData>/personal-handwriting-v2/<SHA-256 of vault path>/`.
- Android: WorkManager 2.11.2, unique work after 25 seconds of quiet plus a six-hour periodic discovery pass, with battery-not-low and storage-not-low constraints. Saves and incoming sync changes schedule local learning. A coroutine mutex serializes workers and startup loading. Cancellation is checked between pages and before commit. Private cache: `<filesDir>/personal-handwriting-v2/<vaultId>/`.
- Each page checkpoint is written to a temporary file, synced, and renamed atomically where supported. Interrupted temporary files do not replace the previous checkpoint. Corrupt derived cache files can be rebuilt from the source notes. Model format is versioned independently of the note format.
- Disabling automatic learning is persisted and leaves the last model usable. Generation and learning perform no network requests and require no API keys, downloads, or paid services. The model is outside the synced vault. An already configured note-sync service remains separate from this feature.

The only additional ink metadata is optional `synthesis` provenance. Existing readers preserve/ignore it. It survives the real desktop parser, packed FAMD storage, native save/open, undo/redo snapshots, and coordinate transforms. It prevents training feedback from generated output. Existing notes and imported training are not migrated or rewritten by the learner.

## UI and integration

The existing text/paste, size, spacing, placement, fit, preview, regeneration, and native-stroke insertion workflow remains. The main additions are automatic-learning opt-out and factual availability/processing status. No model-quality percentages are shown. Imported training stays optional. Both previews run off the UI thread and reject stale results; desktop insertion rescales from the preview's source extent if the page grew meanwhile. Android insertion continues to use one undo step and preserve existing page pixels.

## Reproduce the checks

From the repository root:

```sh
npm --prefix fanotes run typecheck
npm --prefix fanotes run check:text-to-handwriting
npm --prefix fanotes run check:personal-handwriting

# Real Linux worker/preview UI, including paste, sliders, opt-out, and insertability
FANOTES_TTH_LINUX=1 npm --prefix fanotes run check:tth-dialog
# Existing Windows/Web dialog path
npm --prefix fanotes run check:tth-dialog

# Frontend bundle (not a release package)
(cd fanotes && node_modules/.bin/vite build)

cd android
./gradlew :core:test :app:assembleDebug
```

The browser check needs Chromium. The Android build needs the SDK described in `android/README.md`. On the development host `/tmp` exhausted its inodes; an alternate `TMPDIR` and `JAVA_TOOL_OPTIONS=-Djava.io.tmpdir=<writable-dir>` were needed. That host issue is separate from the app.

To regenerate the committed evaluation artifacts:

```sh
FANOTES_HANDWRITING_ARTIFACTS="$PWD/fanotes/docs/handwriting-evaluation" \
  npm --prefix fanotes run check:personal-handwriting
```

The fixture suite checks real unlabeled IAM ink, ambiguity rejection, whole-fragment reuse, duplicate/changed/deleted pages, corrupt pages, interruption/restart, model persistence, bounded large collections, held-out geometry rejection, monotonic timing, feasible/infeasible joins, wrapping, page growth, special characters, provenance, and native editable-stroke undo/save/reload. Legacy synthesis remains separately regression-tested.

`handwriting-evaluation/metrics.json`, the SVGs, and the synthetic cursive fixture are reproducible examples. The cursive fixture has 9 continuous joins across 3 words and 3 pen-down trajectories, replacing separate glyph/connector strokes. The endpoint test has approximately 1.22 degrees of finite-sampling tangent error. The real IAM fixture yields style and joining motions with **no transcript supplied**. The synthetic cursive example is not presented as real user handwriting or as a recognition accuracy benchmark.

## Genuine remaining limits

This is a local hybrid trajectory engine, not a writer-conditioned neural sequence model. Arbitrary cursive cannot reliably acquire letter identities from the recognizer bundled in Android. Unrecognized notes still teach geometry and joining motions; unknown letters retain fallback shapes. The Linux implementation deliberately does not turn the existing recognition pipeline's heuristic confidence values into verified synthesis labels. General cursive pseudo-labeling would need a calibrated offline recognizer plus trustworthy stroke/text alignment and independent writer-held-out evaluation.

No real-user indistinguishability result or character-error rate is claimed. Geometry tests and synthetic comparisons cannot establish that. Distinctive letter shapes require reliable corresponding examples; highly mixed styles, diagrams drawn with the writing pen, sparse samples, and absent pressure/timing reduce personalization. Physical tablet battery/latency and human legibility testing remain necessary before making stronger quality claims.

Sequence-model research considered: [Graves, Generating Sequences With Recurrent Neural Networks](https://arxiv.org/abs/1308.0850). Its text-conditioned synthesis objective is not supervision supplied by unlabeled pages alone. Background-work behavior follows the [Android WorkManager documentation](https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work) and [verified AndroidX releases](https://developer.android.com/jetpack/androidx/releases/work). No inference-only framework is represented as an on-device training system here.
