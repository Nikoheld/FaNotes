import { useEffect, useState, type ReactNode } from 'react'
import { Compass, DraftingCompass, FlipVertical2, LocateFixed, Pin, PinOff, RotateCcw, RotateCw, Ruler, Triangle, X } from 'lucide-react'
import {
  COMPASS_ARC_PRESETS_DEG,
  COMPASS_MAX_RADIUS_MM,
  COMPASS_MIN_RADIUS_MM,
  DRAFTING_ANGLE_STEPS,
  DRAFTING_MAGNETS,
  MM_PER_INCH,
  RULER_LENGTH_PRESETS_MM,
  RULER_MAX_LENGTH_MM,
  RULER_MIN_LENGTH_MM,
  SET_SQUARE_MAX_SIZE_MM,
  SET_SQUARE_MIN_SIZE_MM,
  SET_SQUARE_SIZE_PRESETS_MM,
  asCompassPose,
  clampCompassRadius,
  clampRulerLength,
  clampSetSquareSize,
  degreesToRadians,
  formatLength,
  normalizeAngle,
  presetArcSweep,
  radiansToDegrees,
  rulerLength,
  setSquareSize,
  type CompassDrawEvent,
  type CompassPose,
  type DraftingAngleStep,
  type DraftingKind,
  type DraftingMagnet,
  type DraftingPose,
  type DraftingSettings,
  type DraftingUnit,
} from '../lib/draftingTools'

type DraftingPanelProps = {
  settings: DraftingSettings
  ruler: DraftingPose | null
  setSquare: DraftingPose | null
  compass: CompassPose | null
  className?: string
  onSettingsChange: (patch: Partial<DraftingSettings>) => void
  onPose: (kind: DraftingKind, pose: DraftingPose) => void
  onHide: (kind: DraftingKind) => void
  onRecentre: (kind: DraftingKind) => void
  onCompassDraw: (event: CompassDrawEvent) => void
  onClose: () => void
}

const ANGLE_PRESETS_DEG = [0, 30, 45, 60, 90, 135]

const angleStepLabel = (step: DraftingAngleStep) => (step === 0 ? 'frei' : `${step}°`)

const magnetLabel = (magnet: DraftingMagnet) => (
  magnet === 'off' ? 'aus' : magnet === 'soft' ? 'schwach' : magnet === 'strong' ? 'stark' : 'normal'
)

const headingDegrees = (pose: DraftingPose) => Math.round(radiansToDegrees(normalizeAngle(pose.rotation)) * 10) / 10

/** Length in the unit the panel shows: centimetres or inches. */
const toUnit = (mm: number, unit: DraftingUnit) => (unit === 'in' ? mm / MM_PER_INCH : mm / 10)

const fromUnit = (value: number, unit: DraftingUnit) => (unit === 'in' ? value * MM_PER_INCH : value * 10)

const unitSuffix = (unit: DraftingUnit) => (unit === 'in' ? 'in' : 'cm')

const formatUnitValue = (mm: number, unit: DraftingUnit) => {
  const value = toUnit(mm, unit)
  const rounded = Math.round(value * 100) / 100
  return String(rounded)
}

type NumberFieldProps = {
  label: string
  value: string
  suffix: string
  min: number
  max: number
  step: number
  title?: string
  onCommit: (value: number) => void
}

/** Numeric input that only pushes a value once it parses; typing "1," in between does not fight the pose. */
function NumberField({ label, value, suffix, min, max, step, title, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState(value)
  useEffect(() => {
    setDraft(value)
  }, [value])
  const parse = (raw: string) => {
    const parsed = Number(raw.trim().replace(',', '.'))
    return Number.isFinite(parsed) ? parsed : null
  }
  // While typing, only values already inside the range are applied ("1" on the
  // way to "16" must not shrink the ruler). Enter and blur clamp whatever is there.
  const settle = () => {
    const parsed = parse(draft)
    if (parsed === null) {
      setDraft(value)
      return
    }
    onCommit(Math.min(max, Math.max(min, parsed)))
  }
  return (
    <label className="lw-drafting-field" title={title}>
      <span>{label}</span>
      <input
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          const parsed = parse(event.target.value)
          if (parsed !== null && parsed >= min && parsed <= max) onCommit(parsed)
        }}
        onBlur={settle}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            settle()
            ;(event.target as HTMLInputElement).blur()
          }
        }}
      />
      <small>{suffix}</small>
    </label>
  )
}

type SegmentedProps<T extends string | number> = {
  label: string
  value: T
  options: Array<{ value: T; label: string; title?: string }>
  onChange: (value: T) => void
}

function Segmented<T extends string | number>({ label, value, options, onChange }: SegmentedProps<T>) {
  return (
    <div className="lw-drafting-segment" role="group" aria-label={label}>
      <span>{label}</span>
      <div className="lw-segmented">
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            className={option.value === value ? 'is-active' : ''}
            aria-pressed={option.value === value}
            title={option.title}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

type ToggleProps = {
  label: string
  checked: boolean
  title?: string
  onChange: (checked: boolean) => void
}

function Toggle({ label, checked, title, onChange }: ToggleProps) {
  return (
    <button
      type="button"
      className={`lw-drafting-toggle ${checked ? 'is-active' : ''}`}
      aria-pressed={checked}
      title={title}
      onClick={() => onChange(!checked)}
    >
      <i aria-hidden="true" />
      <span>{label}</span>
    </button>
  )
}

type ToolSectionProps = {
  icon: ReactNode
  title: string
  caption: string
  kind: DraftingKind
  pose: DraftingPose
  onPose: (kind: DraftingKind, pose: DraftingPose) => void
  onHide: (kind: DraftingKind) => void
  onRecentre: (kind: DraftingKind) => void
  children: ReactNode
}

function ToolSection({ icon, title, caption, kind, pose, onPose, onHide, onRecentre, children }: ToolSectionProps) {
  return (
    <section className={`lw-drafting-group is-${kind}`} aria-label={title}>
      <header>
        <span>{icon}</span>
        <strong>{title}</strong>
        <small>{caption}</small>
        <div className="lw-drafting-group-actions">
          <button
            type="button"
            className={`lw-draw-icon ${pose.pinned ? 'is-active' : ''}`}
            aria-pressed={Boolean(pose.pinned)}
            aria-label={pose.pinned ? 'Fixierung lösen' : 'Werkzeug fixieren'}
            title={pose.pinned ? 'Fixierung lösen: Werkzeug lässt sich wieder verschieben' : 'Fixieren: Werkzeug bleibt liegen, Zeichnen an der Kante bleibt möglich'}
            onClick={() => onPose(kind, { ...pose, pinned: !pose.pinned })}
          >
            {pose.pinned ? <Pin size={15} /> : <PinOff size={15} />}
          </button>
          <button type="button" className="lw-draw-icon" aria-label="In die Blattmitte holen" title="Werkzeug in die sichtbare Blattmitte holen und Drehung zurücksetzen" onClick={() => onRecentre(kind)}>
            <LocateFixed size={15} />
          </button>
          <button type="button" className="lw-draw-icon" aria-label="Werkzeug ausblenden" title="Werkzeug ausblenden" onClick={() => onHide(kind)}>
            <X size={15} />
          </button>
        </div>
      </header>
      <div className="lw-drafting-rows">{children}</div>
    </section>
  )
}

export function DraftingPanel({
  settings,
  ruler,
  setSquare,
  compass,
  className = '',
  onSettingsChange,
  onPose,
  onHide,
  onRecentre,
  onCompassDraw,
  onClose,
}: DraftingPanelProps) {
  const unit = settings.unit
  const lengthStep = unit === 'in' ? 0.25 : 0.5
  const angleField = (kind: DraftingKind, pose: DraftingPose) => (
    <div className="lw-drafting-row">
      <NumberField
        label={kind === 'compass' ? 'Mine bei' : 'Winkel'}
        value={String(headingDegrees(pose))}
        suffix="°"
        min={-360}
        max={720}
        step={settings.angleStep || 1}
        title={kind === 'compass' ? 'Stellung der Mine in Grad: hier beginnen Bögen' : 'Drehung der Zeichenkante in Grad'}
        onCommit={(value) => onPose(kind, { ...pose, rotation: degreesToRadians(value) })}
      />
      <div className="lw-segmented lw-drafting-presets" role="group" aria-label="Winkel-Vorgaben">
        {ANGLE_PRESETS_DEG.map((preset) => (
          <button
            key={preset}
            type="button"
            className={Math.abs(headingDegrees(pose) - preset) < 0.05 ? 'is-active' : ''}
            onClick={() => onPose(kind, { ...pose, rotation: degreesToRadians(preset) })}
          >
            {`${preset}°`}
          </button>
        ))}
      </div>
    </div>
  )

  return (
    <aside
      className={`lw-drafting-panel ${className}`}
      aria-label="Zeichenhilfen"
      data-fanotes-drawing-chrome="drafting"
      // Keys typed into the panel belong to the panel, not to the board's shortcuts.
      onKeyDown={(event) => event.stopPropagation()}
    >
      <header className="lw-drafting-panel-head">
        <span><DraftingCompass size={17} /></span>
        <div><strong>Zeichenhilfen</strong><small>Lineal, Geodreieck und Zirkel in echten Millimetern</small></div>
        <button type="button" className="lw-draw-icon" aria-label="Optionen einklappen" title="Optionen einklappen" onClick={onClose}><X size={16} /></button>
      </header>

      <section className="lw-drafting-group is-general" aria-label="Allgemein">
        <div className="lw-drafting-rows">
          <div className="lw-drafting-row">
            <Segmented<DraftingUnit>
              label="Einheit"
              value={unit}
              options={[
                { value: 'cm', label: 'cm', title: 'Zentimeter und Millimeter' },
                { value: 'in', label: 'inch', title: 'Zoll mit Sechzehnteln' },
              ]}
              onChange={(value) => onSettingsChange({ unit: value })}
            />
            <Segmented<DraftingAngleStep>
              label="Winkelraster"
              value={settings.angleStep}
              options={DRAFTING_ANGLE_STEPS.map((step) => ({
                value: step,
                label: angleStepLabel(step),
                title: step === 0 ? 'Frei drehen' : `Drehen und Zirkelbögen rasten alle ${step}°`,
              }))}
              onChange={(value) => onSettingsChange({ angleStep: value })}
            />
          </div>
          <div className="lw-drafting-row">
            <Segmented<DraftingMagnet>
              label="Magnet"
              value={settings.magnet}
              options={DRAFTING_MAGNETS.map((magnet) => ({
                value: magnet,
                label: magnetLabel(magnet),
                title: magnet === 'off' ? 'Stift rastet nicht an Kanten' : 'Wie nah der Stift an einer Kante sein muss, um daran zu zeichnen',
              }))}
              onChange={(value) => onSettingsChange({ magnet: value })}
            />
            <Toggle
              label="Durchsichtig"
              checked={settings.translucent}
              title="Werkzeuge lassen die Tinte darunter durchscheinen"
              onChange={(value) => onSettingsChange({ translucent: value })}
            />
          </div>
        </div>
      </section>

      {ruler && (
        <ToolSection
          icon={<Ruler size={15} />}
          title="Lineal"
          caption={`${formatLength(rulerLength(ruler), unit)} · beide Kanten zeichnen`}
          kind="ruler"
          pose={ruler}
          onPose={onPose}
          onHide={onHide}
          onRecentre={onRecentre}
        >
          <div className="lw-drafting-row">
            <NumberField
              label="Länge"
              value={formatUnitValue(rulerLength(ruler), unit)}
              suffix={unitSuffix(unit)}
              min={toUnit(RULER_MIN_LENGTH_MM, unit)}
              max={toUnit(RULER_MAX_LENGTH_MM, unit)}
              step={lengthStep}
              title="Länge der Zeichenkanten"
              onCommit={(value) => {
                const lengthMm = clampRulerLength(fromUnit(value, unit))
                onPose('ruler', { ...ruler, lengthMm })
                onSettingsChange({ rulerLengthMm: lengthMm })
              }}
            />
            <div className="lw-segmented lw-drafting-presets" role="group" aria-label="Längen-Vorgaben">
              {RULER_LENGTH_PRESETS_MM.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={Math.abs(rulerLength(ruler) - preset) < 0.5 ? 'is-active' : ''}
                  onClick={() => {
                    onPose('ruler', { ...ruler, lengthMm: preset })
                    onSettingsChange({ rulerLengthMm: preset })
                  }}
                >
                  {formatLength(preset, unit)}
                </button>
              ))}
            </div>
          </div>
          {angleField('ruler', ruler)}
        </ToolSection>
      )}

      {setSquare && (
        <ToolSection
          icon={<Triangle size={15} />}
          title="Geodreieck"
          caption={`${formatLength(setSquareSize(setSquare), unit)} · Skala ab Mitte, Winkelmesser 0–180°`}
          kind="setSquare"
          pose={setSquare}
          onPose={onPose}
          onHide={onHide}
          onRecentre={onRecentre}
        >
          <div className="lw-drafting-row">
            <NumberField
              label="Größe"
              value={formatUnitValue(setSquareSize(setSquare), unit)}
              suffix={unitSuffix(unit)}
              min={toUnit(SET_SQUARE_MIN_SIZE_MM, unit)}
              max={toUnit(SET_SQUARE_MAX_SIZE_MM, unit)}
              step={lengthStep}
              title="Länge der langen Kante (Hypotenuse)"
              onCommit={(value) => {
                const sizeMm = clampSetSquareSize(fromUnit(value, unit))
                onPose('setSquare', { ...setSquare, sizeMm })
                onSettingsChange({ setSquareSizeMm: sizeMm })
              }}
            />
            <div className="lw-segmented lw-drafting-presets" role="group" aria-label="Größen-Vorgaben">
              {SET_SQUARE_SIZE_PRESETS_MM.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={Math.abs(setSquareSize(setSquare) - preset) < 0.5 ? 'is-active' : ''}
                  onClick={() => {
                    onPose('setSquare', { ...setSquare, sizeMm: preset })
                    onSettingsChange({ setSquareSizeMm: preset })
                  }}
                >
                  {formatLength(preset, unit)}
                </button>
              ))}
            </div>
          </div>
          {angleField('setSquare', setSquare)}
          <div className="lw-drafting-row">
            <button
              type="button"
              className="lw-draw-subtle"
              title="Spitze auf die andere Seite der langen Kante klappen (Taste F)"
              onClick={() => onPose('setSquare', { ...setSquare, flipped: !setSquare.flipped })}
            >
              <FlipVertical2 size={14} /> <span>Spiegeln</span>
            </button>
            <Toggle
              label="Parallelen"
              checked={settings.setSquareParallels}
              title="Parallele Hilfslinien im Dreieck zum Zeichnen von Parallelen"
              onChange={(value) => onSettingsChange({ setSquareParallels: value })}
            />
            <Toggle
              label="An Lineal anlegen"
              checked={settings.attachToRuler}
              title="Kante oder Mittellinie legt sich an eine nahe Linealkante an und gleitet daran entlang (Alt beim Ziehen: nicht anlegen)"
              onChange={(value) => onSettingsChange({ attachToRuler: value })}
            />
          </div>
        </ToolSection>
      )}

      {compass && (
        <ToolSection
          icon={<Compass size={15} />}
          title="Zirkel"
          caption={`r ${formatLength(compass.radiusMm, unit)} · Ø ${formatLength(compass.radiusMm * 2, unit)}`}
          kind="compass"
          pose={compass}
          onPose={onPose}
          onHide={onHide}
          onRecentre={onRecentre}
        >
          <div className="lw-drafting-row">
            <NumberField
              label="Radius"
              value={formatUnitValue(compass.radiusMm, unit)}
              suffix={unitSuffix(unit)}
              min={toUnit(COMPASS_MIN_RADIUS_MM, unit)}
              max={toUnit(COMPASS_MAX_RADIUS_MM, unit)}
              step={unit === 'in' ? 0.05 : 0.1}
              title="Radius des Zirkels"
              onCommit={(value) => onPose('compass', asCompassPose({ ...compass, radiusMm: clampCompassRadius(fromUnit(value, unit)) }))}
            />
            <Toggle
              label="Radius sperren"
              checked={Boolean(compass.locked)}
              title="Radius festhalten, um ein Maß zu übertragen"
              onChange={(value) => onPose('compass', { ...compass, locked: value })}
            />
            <Toggle
              label="Mittelpunkt markieren"
              checked={settings.compassCentreMark}
              title="Kreise und Bögen bekommen ein kleines Kreuz im Mittelpunkt"
              onChange={(value) => onSettingsChange({ compassCentreMark: value })}
            />
          </div>
          {angleField('compass', compass)}
          <div className="lw-drafting-row">
            <div className="lw-drafting-segment" role="group" aria-label="Bogen zeichnen">
              <span>Bogen</span>
              <div className="lw-segmented lw-drafting-presets">
                {COMPASS_ARC_PRESETS_DEG.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    title={`Bogen von ${preset}° ab der Mine zeichnen`}
                    onClick={() => onCompassDraw({ type: 'arc', pose: compass, sweep: presetArcSweep(preset, settings.arcDirection) })}
                  >
                    {`${preset}°`}
                  </button>
                ))}
                <button type="button" title="Ganzen Kreis zeichnen" onClick={() => onCompassDraw({ type: 'circle', pose: compass })}>Kreis</button>
              </div>
            </div>
            <Segmented<'cw' | 'ccw'>
              label="Richtung"
              value={settings.arcDirection}
              options={[
                { value: 'cw', label: '↻', title: 'Im Uhrzeigersinn' },
                { value: 'ccw', label: '↺', title: 'Gegen den Uhrzeigersinn' },
              ]}
              onChange={(value) => onSettingsChange({ arcDirection: value })}
            />
            <span className="lw-drafting-direction-icon" aria-hidden="true">
              {settings.arcDirection === 'cw' ? <RotateCw size={14} /> : <RotateCcw size={14} />}
            </span>
          </div>
        </ToolSection>
      )}

      <footer className="lw-drafting-panel-foot">
        Pfeiltasten verschieben das zuletzt berührte Werkzeug um 1 mm (Umschalt: 10 mm), Q/E drehen es, F spiegelt das Geodreieck. Alt beim Ziehen schaltet Winkelraster und Anlegen aus.
      </footer>
    </aside>
  )
}
