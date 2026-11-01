/* tslint:disable */
/* eslint-disable */

export function decodeCtc(probabilities: Float32Array, time_steps: number, classes: number, characters: string[], language: string): string;

/**
 * Personal prototype fusion for entries that already have features. The TypeScript builder
 * stays available; callers switch only after the published model matches.
 */
export function fuseRecognitionModel(payload: string): string;

/**
 * CTC loss (nats) of `labels` under `[frames, classes]` logits; `+∞` when the line is too short.
 */
export function inkCtcLoss(logits: Float32Array, classes: number, labels: Uint32Array): number;

/**
 * Decodes `[frames, classes]` logits with the language model and lexicon of `language`.
 */
export function inkDecode(logits: Float32Array, classes: number, alphabet: string, language: string, options_json: string): string;

/**
 * Packed strokes are `pointCount, x, y, x, y, …` per stroke in page pixels. Returns the lines
 * as JSON, top to bottom.
 */
export function inkGroupLines(packed: Float64Array): string;

/**
 * `[width, height, …pixels]` of the model image (`1` paper, `0` ink), or empty without ink.
 */
export function inkLineImage(packed: Float64Array, ref_height: number, pen_width: number, extra_shear: number, scale: number): Float32Array;

/**
 * Page-space boxes `[minX, minY, maxX, maxY]` of the ink under each frame span
 * (`start, end` pairs). A span without ink gets `NaN`s.
 */
export function inkSpanBoxes(packed: Float64Array, ref_height: number, pen_width: number, extra_shear: number, scale: number, spans: Uint32Array): Float64Array;

/**
 * Packed strokes: for each stroke, `baseWidth`, `pointCount`, then that many `x, y` page coordinates.
 * Ratios are `NaN` when the caller wants the default crop.
 */
export function lineTensor(min_x: number, min_y: number, max_x: number, max_y: number, source_width: number, source_height: number, margin_x_ratio: number, margin_y_ratio: number, ink_scale: number, packed: Float64Array): Float32Array;

export function setInkLanguageModel(language: string, bytes: Uint8Array): void;

/**
 * Installs the spelling Bloom filter of `language` as the decoder's word lexicon.
 */
export function setInkLexicon(language: string, bloom: Uint8Array, bit_count: number): void;

/**
 * Replaces the personal vocabulary (lower-case words) of `language`.
 */
export function setInkPersonalWords(language: string, words: string[]): void;

/**
 * Remembers the spelling candidates for one language. Called once, when handwriting recognition
 * loads that language, so a line decode does not copy the list again.
 */
export function setLexicon(language: string, words: string[]): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly decodeCtc: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly fuseRecognitionModel: (a: number, b: number) => [number, number, number, number];
    readonly inkCtcLoss: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly inkDecode: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number, number];
    readonly inkGroupLines: (a: number, b: number) => [number, number, number, number];
    readonly inkLineImage: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly inkSpanBoxes: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly lineTensor: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number, number];
    readonly setInkLanguageModel: (a: number, b: number, c: number, d: number) => [number, number];
    readonly setInkLexicon: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly setInkPersonalWords: (a: number, b: number, c: number, d: number) => void;
    readonly setLexicon: (a: number, b: number, c: number, d: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_alloc: () => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
