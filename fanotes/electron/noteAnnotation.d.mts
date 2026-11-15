export type StampDef = { id: string; glyph: string; label: string; color: string }
export type AnnotationBase = { id: string; page: number }
export type CalloutAnnotation = AnnotationBase & { kind: 'callout'; ax: number; ay: number; lx: number; ly: number; text: string; color: string; num?: number }
export type StampAnnotation = AnnotationBase & { kind: 'stamp'; x: number; y: number; stamp: string; size: number }
export type LegendAnnotation = AnnotationBase & { kind: 'legend'; x: number; y: number; names: Record<string, string> }
export type ImageAnnotation = AnnotationBase & { kind: 'image'; x: number; y: number; w: number; aspect: number; opacity: number; locked: boolean; src: string; title: string }
export type StrokeAnnotation = AnnotationBase & { kind: 'stroke'; pts: Array<[number, number]>; color: string; width: number; opacity: number }
export type MeasureAnnotation = AnnotationBase & { kind: 'measure'; mode: 'angle' | 'distance'; pts: Array<[number, number]>; color: string }
export type TermsAnnotation = { kind: 'terms'; id: 'terms'; list: string[] }
export type NoteAnnotation = CalloutAnnotation | StampAnnotation | LegendAnnotation | ImageAnnotation | StrokeAnnotation | MeasureAnnotation | TermsAnnotation
export type AnnotationHistory = { past: NoteAnnotation[][]; future: NoteAnnotation[][]; limit: number }
export type LegendRow = { key: string; glyph: string; color: string; label: string }

export const ANNOTATION_LIMIT: number
export const ANNOTATION_IMAGE_LIMIT: number
export const ANNOTATION_IMAGE_MAX_CHARS: number
export const STAMPS: StampDef[]
export function stampById(id: string): StampDef | null
export function newAnnotationId(): string
export function sanitizeAnnotation(value: unknown): NoteAnnotation | null
export function parseAnnotations(value: unknown): NoteAnnotation[]
export function annotationsHaveContent(list: readonly NoteAnnotation[] | null | undefined): boolean
export function angleAt(vertex: readonly number[], a: readonly number[], b: readonly number[]): number
export function angleBetweenLines(a1: readonly number[], a2: readonly number[], b1: readonly number[], b2: readonly number[]): number
export function distanceOf(a: readonly number[], b: readonly number[], pageSize: { width: number; height: number }): number
export function measureValue(item: MeasureAnnotation, pageSize: { width: number; height: number }): number
export function formatMeasure(item: MeasureAnnotation, value: number): string
export function nextCalloutNumber(list: readonly NoteAnnotation[]): number
export function renumberCallouts(list: readonly NoteAnnotation[]): NoteAnnotation[]
export function legendRows(list: readonly NoteAnnotation[], names?: Record<string, string>): LegendRow[]
export function termsFromText(raw: string): string[]
export function createAnnotationHistory(limit?: number): AnnotationHistory
export function pushAnnotationHistory(history: AnnotationHistory, snapshot: NoteAnnotation[]): AnnotationHistory
export function undoAnnotations(history: AnnotationHistory, current: NoteAnnotation[]): { history: AnnotationHistory; list: NoteAnnotation[] } | null
export function redoAnnotations(history: AnnotationHistory, current: NoteAnnotation[]): { history: AnnotationHistory; list: NoteAnnotation[] } | null
