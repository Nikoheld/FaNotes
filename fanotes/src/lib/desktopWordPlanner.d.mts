import type { Sample, Stroke } from '../../../src/types'
import type { TrajectoryUnit } from './personalHandwriting.mjs'
export type WordCandidate = { text: string; sample: Pick<Sample,'id'|'label'|'labelId'|'sessionId'|'bbox'|'strokes'> & {sourceCanvas:{width:number;height:number}}; unit?: TrajectoryUnit; diacritic?: 'umlaut'; width: number; height: number; top: number }
export type WordSelection = WordCandidate & {position:number;cost:number;geometry:ReturnType<typeof trajectoryDescriptor>}
export function primaryTrajectory(strokes: Stroke[], width?:number,height?:number):number
export function trajectoryDescriptor(candidate:WordCandidate):{entry:{x:number;y:number};exit:{x:number;y:number};incoming:number[];outgoing:number[]}|null
export function wordTransitionCost(left:WordSelection|undefined,right:WordSelection,connect?:boolean,gap?:number):number
export function planDesktopWord(word:string,candidatesAt:(position:number)=>WordCandidate[],options?:{random?:()=>number;beamWidth?:number;variants?:number;connect?:boolean;gap?:number}):WordSelection[]
