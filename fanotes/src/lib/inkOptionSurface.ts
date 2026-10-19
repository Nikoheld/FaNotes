/** Marker and Textmarker share the writing pen's inline strip. Other brushes keep the studio card. */
export const PEN_STRIP_BRUSHES = ['marker', 'highlighter'] as const

export type PenStripBrush = (typeof PEN_STRIP_BRUSHES)[number]

export const usesPenStrip = (brush: string) =>
  (PEN_STRIP_BRUSHES as readonly string[]).includes(brush)

/** The large Zeichenstudio card stays closed for Marker and Textmarker. */
export const artStudioOpenForBrush = (brush: string, panelRequested: boolean) =>
  panelRequested && !usesPenStrip(brush)
