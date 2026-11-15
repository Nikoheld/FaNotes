import { type StudyKind } from './blocks'
import { defaultKeyData, parseKeyData } from './keyTree'
import { defaultSortData, parseSortData } from './sortBoard'
import { defaultMapData, parseMapData } from './conceptMap'
import { defaultPlateData, defaultTermData, parsePlateData, parseTermData } from './cardsModels'
import { renderStudyHtml, type StudyAnyData } from './render'

export const parseStudyData = (kind: StudyKind, body: string): StudyAnyData => {
  switch (kind) {
    case 'key': return parseKeyData(body)
    case 'sort': return parseSortData(body)
    case 'map': return parseMapData(body)
    case 'plate': return parsePlateData(body)
    case 'term': return parseTermData(body)
  }
}

export const defaultStudyData = (kind: StudyKind): StudyAnyData => {
  switch (kind) {
    case 'key': return defaultKeyData()
    case 'sort': return defaultSortData()
    case 'map': return defaultMapData()
    case 'plate': return defaultPlateData()
    case 'term': return defaultTermData()
  }
}

/** Safe HTML for a block body, used by the editor widget and the preview. */
export const renderStudyBlockHtml = (kind: StudyKind, body: string) => renderStudyHtml(kind, parseStudyData(kind, body))
