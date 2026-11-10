// The part of the server's schulnetz-logic.mjs the browser uses. The browser imports that file
// itself (see vite.config.ts), so these are its real implementations, typed here.
declare module '@shared/schulnetz-logic' {
  import type { AgendaEvent, SchoolAbsence, SchoolGrade, Snapshot } from '../types'
  export interface AbsenceEstimate { points: number; lessons: number; reports: number; rule: 'lessons' | 'exam' | 'instrument' | 'special' | 'fallback' | 'booked'; block: number; first: boolean }
  export interface AbsenceTally { quota: number | null; booked: number; estimated: number; remaining: number | null; total: number; openReports: number; estimates: Record<string, AbsenceEstimate> }
  export function absenceTally(snapshot: Partial<Snapshot> | null | undefined): AbsenceTally
  export function absenceNoticeBody(absence: SchoolAbsence, tally: AbsenceTally): string
  export interface Mark { mark: number; weight: number }
  export interface WishResult { achievable: boolean; alreadyMet: boolean; needed: number | null; neededHalf?: number }
  export function isLesson(event: Partial<AgendaEvent>): boolean
  export function isExamLike(event: Partial<AgendaEvent>): boolean
  export function isCancelled(event: Partial<AgendaEvent>): boolean
  export function isSubstitution(event: Partial<AgendaEvent>): boolean
  export function eventLabel(event: Partial<AgendaEvent>): string
  export function eventDate(start: string): string
  export function weekMonday(iso: string): string
  export function weekMondayKey(start: string): string
  export function addDays(iso: string, days: number): string
  export function zurichToday(now?: Date): string
  export function zurichClock(now?: Date): string
  export function schulnetzClock(raw: string): string
  export function cleanSchulnetzText(raw: unknown): string
  export function weightedAverage(marks: Mark[]): number | null
  export function roundToHalf(value: number): number
  export function isSportCourse(name: string): boolean
  export function promotionPoints(zeugnis: number): number | null
  export function wunschnote(current: Mark[], target: number, nextWeight: number): WishResult
  export function isSummaryGrade(grade: Partial<SchoolGrade>): boolean
  export function looksLikeCourseCode(value: string): boolean
}
