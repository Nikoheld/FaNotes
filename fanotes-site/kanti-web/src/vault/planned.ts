import { useMemo } from 'react'
import { useKanti } from '../state'
import { provisionalTally, type ProvisionalTally } from './school'
import { useVault } from './store'

/** The absence points with the planned absences counted as open reports (the app's provisionalTally). */
export const useProvisional = (today: string): ProvisionalTally => {
  const { data } = useKanti()
  const { own } = useVault()
  return useMemo(() => provisionalTally(data.snapshot, own.planned, today), [data.snapshot, own.planned, today])
}
