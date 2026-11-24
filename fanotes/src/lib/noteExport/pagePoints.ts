/** PDF points per page size (portrait). */
export const NOTE_EXPORT_PAGE_POINTS = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
} as const

/** Margin in PDF points. */
export const NOTE_EXPORT_MARGIN_POINTS = { narrow: 28, normal: 48, wide: 72 } as const
