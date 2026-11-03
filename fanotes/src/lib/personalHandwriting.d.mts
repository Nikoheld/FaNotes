import type { Sample, Stroke, StrokePoint } from '../../../src/types'
export type StyleObservation = { height: number; slant: number; pressure: number; pressureSpread: number; nibRatio: number; baseline: number; joinRate: number; gap: number; wordGap: number; speed: number }
export type TrajectoryUnit = Pick<Sample, 'id' | 'label' | 'labelId' | 'sessionId' | 'bbox' | 'strokes'> & { sourceCanvas: { width: number; height: number }; baseline: number; context: string }
export type JoiningMotion = { points: StrokePoint[]; entry: [number, number]; exit: [number, number] }
export type PageContribution = { fingerprint: string; observations: StyleObservation[]; units: TrajectoryUnit[]; joins?: JoiningMotion[] }
export type PersonalModel = { version: number; revision: number; pages: Record<string, PageContribution>; population?: StyleObservation | null }
export const MODEL_VERSION: number
export const MAX_PAGE_OBSERVATIONS: number
export function median(values: number[], fallback?: number): number
export function fingerprint(value: unknown): string
export function bounds(strokes: Stroke[]): [number, number, number, number]
export function emptyPersonalModel(): PersonalModel
export function validModel(value: unknown): value is PersonalModel
export function learnPage(document: { sourceWidth: number; sourceHeight: number; strokes: Stroke[] }, library?: Sample[]): PageContribution
export function updatePersonalPage(model: PersonalModel, id: string, contribution: PageContribution | null): PersonalModel
export function personalStyle(model?: PersonalModel): { observations: StyleObservation[]; units: TrajectoryUnit[]; joins: JoiningMotion[]; pageCount: number }
export function spliceTrajectories(left: StrokePoint[], right: StrokePoint[], em: number, motions?: JoiningMotion[]): StrokePoint[] | null
