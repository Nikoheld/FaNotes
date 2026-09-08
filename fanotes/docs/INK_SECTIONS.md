# Einklappbare Abschnitte in der Handschrift

Ein Abschnitt gliedert eine handgeschriebene Seite: eine **Kopfzeile** (72 Blatt‑px, ≈ 17 mm), in die der Titel von Hand geschrieben wird, und darunter ein **Inhalt**, der bis zur nächsten Kopfzeile reicht — beim letzten Abschnitt bis zum Seitenende. Der Pfeil am linken Rand klappt den Inhalt ein und aus.

## Bedienung

| Aktion | Wie |
| --- | --- |
| Abschnitt einfügen | Stiftmodus → „Abschnitt“ in der Stiftleiste → auf das Blatt tippen. Die Kopfzeile wird an der getippten Stelle *eingefügt*: alles darunter rückt um die Kopfzeile nach unten, nichts wird überdeckt. Liegt direkt darunter schon ein Titel, bekommt der neue Inhalt mindestens 144 px Platz. Esc bricht ab. |
| Titel | Von Hand in die Kopfzeile schreiben; solange sie leer ist, steht dort blass „Titel“. |
| Unendlich schreiben | Wer im Inhalt bis auf 108 px an den nächsten Titel schreibt, schiebt ihn samt allem Folgenden nach unten (`planBodyRoom`). Der letzte Abschnitt wächst einfach mit der Seite. |
| Einklappen / Ausklappen | Pfeil in der Kopfzeile. Eingeklappt: die Tinte des Inhalts verschwindet, der Rest der Seite rückt um die Inhaltshöhe nach oben, die Seite wird kürzer, die Kopfzeile zeigt „Eingeklappt“. Ausklappen stellt exakt die alte Lage wieder her. |
| Auflösen | × in der Kopfzeile. Nur die Kopfzeile verschwindet; die Tinte bleibt liegen (ein eingeklappter Inhalt wird vorher ausgeklappt). |

Rückgängig/Wiederholen bleiben beim Einfügen und beim Wachsen erhalten (die Striche werden in place verschoben, auch die in Verlaufsschnappschüssen). Ein‑ und Ausklappen setzen den Verlauf zurück: ein Schnappschuss von vorher würde die versteckten Striche an einer Stelle zurückbringen, die es im aktuellen Layout nicht gibt.

PDF‑Notizen bieten keine Abschnitte (`sectionsEnabled={!isPdfActive}` in `App.tsx`): ihre Tinte gehört zur PDF‑Seite darunter. Auf Textnotizen bewegen Abschnitte nur die Handschrift, nicht den getippten Text — gedacht sind sie für handgeschriebene Seiten (Aufgaben, Übungen, Rechenwege).

## Modell (`src/lib/inkSections.ts`)

Die Tinte bleibt eine flache Liste von Strichen in 0–1 des Blatts. Abschnitte verändern nur *wo* Striche liegen; Malen, Radieren, Auswahl, Fenster‑Slicing und Speichern sehen immer das aktuelle Layout.

```ts
type InkSection = {
  id: string
  top: StrokePoint      // Oberkante der Kopfzeile, 0–1
  bodyTop: StrokePoint  // Unterkante der Kopfzeile = Beginn des Inhalts, 0–1
  collapsed: boolean
  hidden: { widthPx, heightPx, strokes } | null  // Inhalt im eingeklappten Zustand
}
```

- **Kanten sind `StrokePoint`s.** `forEachTrackedPoint` in `DrawingBoard` besucht sie wie Strichpunkte; jede Vergrößerung, Randauffüllung oder Neuskalierung des Blatts (`setPageExtent`, `scaleNormalizedSpace`) nimmt die Bänder deshalb automatisch mit.
- **Zugehörigkeit** eines Strichs entscheidet sein höchster Punkt (`strokeTop`): in der Kopfzeile → Titel, im Inhalt → wird mit eingeklappt, darunter → wird verschoben.
- **Verschieben** (`shiftFrom`) läuft über *alle* vom Board gehaltenen Striche (`forEachTrackedStroke`: live, Undo/Redo, Gestenkopien) und verschiebt jeden Punkt genau einmal, auch wenn Schnappschüsse ihn teilen.
- **Versteckte Tinte** ist auf ihren eigenen Kasten normiert (Breite × Höhe in Blatt‑px zum Zeitpunkt des Einklappens). Eine spätere Blattänderung kann sie nicht veralten lassen; beim Ausklappen wird sie auf das dann aktuelle Blatt umgerechnet.
- **Reihenfolge der Schritte** ist entscheidend, weil die Seite beim Größenwechsel alle Punkte auf Pixeltreue neu normiert: *Einfügen/Wachsen/Ausklappen* wachsen zuerst (`growSheetBy` → `setPageExtent`) und verschieben danach auf dem gewachsenen Blatt; *Einklappen* verschiebt zuerst und schrumpft danach. Grenzen kommen immer aus den mitgeführten Kantenpunkten, nie aus zurückgerechneten Pixeln.
- **Nahtstelle:** Nach dem Einklappen liegt die nächste Kopfzeile exakt (nicht bis auf einen Rundungsfehler) auf `bodyTop`; das Ausklappen verschiebt ab genau dieser Kante.

Gespeichert werden Abschnitte im Tintendokument (`DrawingDocument.sections`, `serializeSections` / `deserializeSections`), also in der `.famd`‑Begleiterdatei; Dokumente ohne Abschnitte bleiben unverändert.

## Oberfläche

`.lw-ink-sections` liegt in der Zeichenfläche und ist um `--paper-scroll-room` eingerückt, deckt also genau das Blatt ab (wie `.lw-drafting-layer`). Kopfzeilen und Schienen sind in Prozent des Blatts positioniert; die Bänder lassen Stifteingaben durch (`pointer-events: none`), nur Pfeil und × sind klickbar (`.lw-ink-section-control`, das `hitTestChrome` vor dem Flächentest erkennt). Im Tastaturmodus sind die Bänder sichtbar, aber wie die ganze Stiftebene nicht anklickbar.

## Prüfung

`npm run check:ink-sections` — Einfügen (auch gegen einen Titel direkt darunter), Wachsen mit Schreibrand, Einklappen mit exakter Nahtstelle, Ausklappen auf die alten Pixel (inklusive Strichen, die nur im Verlauf leben), letzter Abschnitt, leerer Abschnitt, Persistenz‑Roundtrip und die Verdrahtung im Board.
