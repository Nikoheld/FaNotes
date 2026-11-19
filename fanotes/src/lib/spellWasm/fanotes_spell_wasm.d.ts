/* tslint:disable */
/* eslint-disable */

/**
 * Builds the n-gram index of a loaded language (once). Returns the word count.
 */
export function buildContext(language_code: string): number;

export function contextIsExtendedWord(language_code: string, word: string): boolean;

/**
 * All dictionary words within `maximum_distance` edits as `[[word, distance], ...]`, ordered by
 * distance then code unit order. The caller applies the collation sort and the limit.
 */
export function contextNearest(language_code: string, source: string, maximum_distance: number, same_length_only: boolean): string;

export function contextSequenceScore(language_code: string, word: string): number;

export function contextSubwordScore(language_code: string, word: string): number;

export function contextWordsOfLength(language_code: string, length: number): string;

/**
 * Index of the suggestion that is safe to apply while typing, or -1.
 */
export function decideAutocorrect(typed: string, suggestions_json: string, language_code: string, sentence_start: boolean, is_proper_name: boolean): number;

export function loadBloom(language_code: string, bytes: Uint8Array, bit_count: number, hashes: number): void;

/**
 * Validates and installs an exact word list. Returns the number of words.
 */
export function loadWords(language_code: string, bytes: Uint8Array, expected_size: number, expected_count: number): number;

/**
 * `normalizeWord` of `spelling.ts`, exposed for the parity check.
 */
export function normalizeWord(word: string, language_code: string): string;

/**
 * Replaces the words the user vouched for. `json` is an array of normalised words.
 */
export function setUserWords(json: string): void;

/**
 * Every correction candidate for `typed`, sorted by score (ties by an approximate collation).
 * `languages_json` is an array of language codes; the caller applies `limit` after re-sorting ties.
 */
export function suggestAll(typed: string, languages_json: string, max_distance: number): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly buildContext: (a: number, b: number) => [number, number, number];
    readonly contextIsExtendedWord: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly contextNearest: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly contextSequenceScore: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly contextSubwordScore: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly contextWordsOfLength: (a: number, b: number, c: number) => [number, number, number, number];
    readonly decideAutocorrect: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly loadBloom: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly loadWords: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly normalizeWord: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly setUserWords: (a: number, b: number) => [number, number];
    readonly suggestAll: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
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
