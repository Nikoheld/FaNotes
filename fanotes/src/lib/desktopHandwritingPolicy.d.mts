import type { TrajectoryUnit } from './personalHandwriting.mjs'
export type LearningPolicy = { tag: string; pages: number; observations: number; joins: number; units: number; unitPoints: number; pagePoints: number; candidates: number; recognitionPoints: number; strokePoints: number; hotPoints: number; snapshotPoints: number; snapshotUnits: number; variants: number; motions: number; beamWidth: number; heapMb?: number }
export const TABLET_LEARNING_POLICY: LearningPolicy
export function desktopLearningPolicy(hardware?: { cores?: number; memoryBytes?: number }): LearningPolicy
export function selectDiverseUnits(units: TrajectoryUnit[], options: { maxUnits: number; pointBudget: number; variants?: number }): TrajectoryUnit[]
