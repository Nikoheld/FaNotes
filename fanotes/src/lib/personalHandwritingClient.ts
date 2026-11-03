import type { PersonalModel } from './personalHandwriting.mjs'
export type LearningState = { vaultId?: string; model: PersonalModel; pageCount: number; observationCount: number; unitCount: number; busy: boolean; enabled: boolean; error: string | null }
export type LearningSnapshot = Omit<LearningState, 'model'> & { model: PersonalModel | null; unchanged?: boolean }
export const learningStatus = (state: LearningState) => state.error ?? (state.busy
  ? 'Learning from your handwritten notes…'
  : state.observationCount ? `${state.pageCount} handwritten pages · ${state.unitCount ? 'Personal trajectories and style available' : 'Personal style available; letter shapes use available samples'}`
    : 'Write notes as usual. FaNotes learns locally; missing shapes use the school script.')
