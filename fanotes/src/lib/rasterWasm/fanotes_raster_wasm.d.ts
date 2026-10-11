/* tslint:disable */
/* eslint-disable */

export class InkRaster {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Registers an art stamp (SVG paths in a 24 × 24 box). Returns its index.
     */
    addSymbol(paths: string[]): number;
    clearDirty(): void;
    /**
     * `[x, y, width, height]` of the viewport bitmap that changed since `clearDirty`, or `[]`.
     */
    dirtyRegion(scale: number, dpr: number, origin_x: number, origin_y: number, width: number, height: number): Int32Array;
    /**
     * Zoom bucket the last paint used, or 0 when it painted at the exact scale.
     */
    lastBucket(): number;
    lastTilesRendered(): number;
    constructor();
    /**
     * Straight RGBA of one region of the viewport bitmap.
     */
    paint(scale: number, dpr: number, origin_x: number, origin_y: number, x: number, y: number, width: number, height: number): Uint8Array;
    /**
     * Replaces the page with packed strokes. Returns whether any committed pixel may have changed.
     */
    setScene(layout_width: number, layout_height: number, smoothing: number, header: Float64Array, points: Float64Array): boolean;
    tileCount(): number;
}

export function pressureWidth(base_width: number, pressure_enabled: boolean, pressure: number): number;

export function tileBudget(): number;

export function tilePx(): number;

/**
 * Tile bucket for a camera zoom, or 0 when the viewport is painted at the exact scale.
 */
export function zoomBucket(zoom: number): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_inkraster_free: (a: number, b: number) => void;
    readonly inkraster_addSymbol: (a: number, b: number, c: number) => number;
    readonly inkraster_clearDirty: (a: number) => void;
    readonly inkraster_dirtyRegion: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly inkraster_lastBucket: (a: number) => number;
    readonly inkraster_lastTilesRendered: (a: number) => number;
    readonly inkraster_new: () => number;
    readonly inkraster_paint: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number];
    readonly inkraster_setScene: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
    readonly inkraster_tileCount: (a: number) => number;
    readonly pressureWidth: (a: number, b: number, c: number) => number;
    readonly tileBudget: () => number;
    readonly tilePx: () => number;
    readonly zoomBucket: (a: number) => number;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_alloc: () => number;
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
