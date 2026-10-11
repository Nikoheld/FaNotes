/* tslint:disable */
/* eslint-disable */

export function decodeCtc(probabilities: Float32Array, time_steps: number, classes: number, characters: string[], language: string): string;

/**
 * Packed strokes: for each stroke, `baseWidth`, `pointCount`, then that many `x, y` page coordinates.
 * Ratios are `NaN` when the caller wants the default crop.
 */
export function lineTensor(min_x: number, min_y: number, max_x: number, max_y: number, source_width: number, source_height: number, margin_x_ratio: number, margin_y_ratio: number, ink_scale: number, packed: Float64Array): Float32Array;

/**
 * Remembers the spelling candidates for one language. Called once, when handwriting recognition
 * loads that language, so a line decode does not copy the list again.
 */
export function setLexicon(language: string, words: string[]): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly decodeCtc: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly lineTensor: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number, number];
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
