// Regenerates the synthetic Schulnetz HTML fixtures.
// Every name, grade, amount, date, room and class code below is invented.
// Run from the repository root: node android/core/src/test/tools/make-fixtures.mjs

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'schulnetz')

const TEACHERS = [
  ['EX01', 'Mira Holm'],
  ['EX02', 'Leo Nord'],
  ['EX03', 'Pia Kern'],
  ['EX04', 'Quinn Salt'],
  ['EX05', 'Rita Berg'],
  ['EX06', 'Uwe Feld'],
  ['EX07', 'Wera Glas'],
  ['EX08', 'Yann Igel'],
  ['EX09', 'Anja Bode'],
  ['EX10', 'Ciro Dahl'],
]

const lehrerliste = `var lehrerliste=${JSON.stringify(TEACHERS.map(([kuerzel, name], index) => ({
  key: String(index + 1),
  label: `${name.split(' ')[1]}, ${name.split(' ')[0]}`,
  status: 'active',
  name,
  kuerzel,
})))};`

const page = (body) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Synthetic</title></head>
<body><main>
${body}
</main></body></html>
`

const zurichEpoch = (isoLocal) => Date.parse(`${isoLocal}+01:00`)

const lesson = (id, startLocal, endLocal, room, text, teacher) => {
  const start = zurichEpoch(startLocal)
  const end = zurichEpoch(endLocal)
  const clock = startLocal.slice(11, 16)
  const endClock = endLocal.slice(11, 16)
  return `<div class="dhx_cal_event" event_id="${id}" data-bar-start="${start}" data-bar-end="${end}" title="Lehrperson: ${teacher}"><div class="stpt_event_text">${text}</div><div class="stpt_event_date">${clock} - ${endClock} / ${room}</div></div>`
}

// Schulnetz 5.14.1 page shape (anonymized): every page prints a fresh transid into its links and its
// own scheduler call; the semester range appears in the grid view, the date templates, the
// Folgesemester guard and the Wochenplan inputs, never as limit_start/limit_end.
const SESSION = 'f1a2b3c4d5e6f708'
const PRINTED = { '22202': 'a1b2c3', '21312': 'b2c3d4', '22108': 'c3d4e5' }
const menu = (transid) => ['1', '21311', '21111', '21200', '22206', '22202', '22108', '21312']
  .map((id) => `<a href="index.php?pageid=${id}&amp;id=${SESSION}&amp;transid=${transid}">Seite ${id}</a>`).join('\n')
const semesterScript = (pageId, ansicht, extra) => `<script>
scheduler.createGridView({name:"grid",fields:[{id:"start_date",label:"<span id='von_spalte'>Von</span>&nbsp;",align:'left',width:145},{id:"text",label:"Fach",align:'left'}],from:new Date("2026-08-10"),to:new Date("2027-01-30")});
scheduler.templates.wp_date=function(start,end){if(scheduler.getState().mode=="wochenplan")return scheduler.templates.day_date(new Date("2026-08-10"))+" &ndash; "+scheduler.templates.day_date(scheduler.date.add(new Date("2027-01-30"),-1,"day"));else return week_date_default(start,end)};
scheduler.templates.grid_date=function(start,end){return scheduler.templates.day_date(new Date("2026-08-10"))+" &ndash; "+scheduler.templates.day_date(scheduler.date.add(new Date("2027-01-30"),-1,"day"))};
function loadStundenplanReal(scheduler){showExportLoader();var state=scheduler.getState();scheduler.clearAll();var dateToString=scheduler.date.date_to_str("%Y-%m-%d");var view=state.mode;var curr_date=dateToString(state.date);var min_date=dateToString(state.min_date);var max_date=dateToString(state.max_date);if('2027-01-30'<max_date)
alert('Der Stundenplan wurde vom Stundenplaner für das Folgesemester noch nicht freigegeben!');let url="scheduler_processor.php?view="+view+"&curr_date="+curr_date+"&min_date="+min_date+"&max_date="+max_date+"&ansicht=${ansicht}${extra}&id=${SESSION}&transid=${PRINTED[pageId]}&pageid=${pageId}";callback=null;try{scheduler.load(url,callback)}catch(error){hideExportLoader()}}
</script>`

const files = {
  'noten.html': page(`
<a href="index.php?pageid=21311">Noten</a>
<table>
  <tr><td><b>Chemie-K26A-1</b></td><td>5.0</td></tr>
  <tr><td colspan="2"><table>
    <tr><td>03.03.2026</td><td>Laborbericht</td><td>5.5</td><td>1</td></tr>
  </table></td></tr>
  <tr><td><b>MATH-K26A-1</b></td><td>4.0</td></tr>
  <tr><td colspan="2"><table>
    <tr><td>04.04.2026</td><td>Aufgabenblatt</td><td>4.5</td><td>1</td></tr>
  </table></td></tr>
</table>`),
  'absenzen.html': page(`
<a href="index.php?pageid=21111">Absenzen</a>
<table>
  <tr><td>Datum von</td><td>Datum bis</td><td>Grund</td><td>Lektionen</td><td>Fach</td><td>Status</td><td>Entschuldigt</td><td>Bemerkung</td><td>Erfasst</td><td>Von</td><td>Quittiert</td></tr>
</table>`),
  'kontoauszug.html': page(`
<a href="index.php?pageid=21411">Konto</a>
<table>
${Array.from({ length: 11 }, (_, index) => {
    const day = String(index + 1).padStart(2, '0')
    const amount = index === 0 ? '-12.50' : (index % 2 === 0 ? '-3.00' : '5.00')
    const balance = index === 10 ? '88.00' : `${100 - index}.00`
    return `  <tr><td>${day}.02.2026</td><td>Klassenkasse Posten ${index + 1}</td><td>${amount}</td><td>${balance}</td></tr>`
  }).join('\n')}
</table>`),
  'terminliste.html': page(`
<a href="index.php?pageid=22108">Termine</a>
<span>von 40</span>
<a href="index.php?pageid=22108&amp;sRow=25">weiter</a>
<table class="tblTerminliste">
  <tr><th>Datum von</th><th>Bezeichnung</th><th>Raum</th></tr>
${Array.from({ length: 25 }, (_, index) => {
    const title = index === 0 ? 'Probenkonzert' : `Probenstunde ${index + 1}`
    const day = String((index % 27) + 1).padStart(2, '0')
    return `  <tr><td>${day}.06.2026</td><td>${title}</td><td>A${index + 1}</td></tr>`
  }).join('\n')}
</table>`),
  'stundenplan.html': page(`
<a href="index.php?pageid=22202">Stundenplan</a>
<script>${lehrerliste}</script>
${[
    lesson('syn-1', '2026-11-02T07:45:00', '2026-11-02T08:30:00', 'A12', 'Deutsch Holm', 'Mira Holm'),
    lesson('syn-2', '2026-11-02T08:35:00', '2026-11-02T09:20:00', 'B04', 'Mathematik Nord', 'Leo Nord'),
    lesson('syn-3', '2026-11-02T09:40:00', '2026-11-02T10:25:00', 'C11', 'Chemie Kern', 'Pia Kern'),
    lesson('syn-4', '2026-11-02T10:30:00', '2026-11-02T11:15:00', 'D02', 'Geschichte Salt', 'Quinn Salt'),
  ].join('\n')}
`),
  'pruefungsplan.html': page(`
<a href="index.php?pageid=21312">Pruefungen</a>
<h1>Prüfungsplan</h1>
<div id="scheduler"></div>
<script>${lehrerliste}</script>
`),
  'stundenplan-5141.html': page(`
<h1>Schülerinnen- und Schülerplan</h1>
${menu(PRINTED['22202'])}
<div class="dhx_cal_tab" name="week_tab">Woche</div>
<div class="dhx_cal_tab" name="grid_tab" title="Semester als Liste">Liste</div>
<div class="dhx_cal_tab" name="wochenplan_tab" title="Semester als Wochenplan">Wochenplan</div>
<script>${lehrerliste}</script>
${semesterScript('22202', 'schueleransicht', '')}
<form onsubmit="xajax_save_wochenplan_dates($('zeitraum_von').value, $('zeitraum_bis').value); return false;">
<input type="text" name="zeitraum_von" id="zeitraum_von" class="mdl-textfield__input" value="10.08.2026">
<input type="text" name="zeitraum_bis" id="zeitraum_bis" class="mdl-textfield__input" value="29.01.2027">
</form>
${[
    lesson('syn-1', '2026-11-02T07:45:00', '2026-11-02T08:30:00', 'A12', 'Deutsch Holm', 'Mira Holm'),
    lesson('syn-2', '2026-11-02T08:35:00', '2026-11-02T09:20:00', 'B04', 'Mathematik Nord', 'Leo Nord'),
    lesson('syn-3', '2026-11-03T09:40:00', '2026-11-03T10:25:00', 'C11', 'Chemie Kern', 'Pia Kern'),
  ].join('\n')}
`),
  'pruefungsplan-5141.html': page(`
<h1>Prüfungsplan</h1>
${menu(PRINTED['21312'])}
<div id="scheduler"></div>
<script>${lehrerliste}</script>
${semesterScript('21312', 'klassenuebersicht', '&showOnlyThisClass=-1')}
`),
  'terminliste-alle.html': page(`
<h1>Terminliste</h1>
${menu(PRINTED['22108'])}
<table class="tblTerminliste" id="tblTerminliste">
  <tr><th>Datum von</th><th>Bezeichnung</th><th>Raum</th></tr>
${Array.from({ length: 40 }, (_, index) => {
    const day = new Date(Date.UTC(2026, 10, 2 + index * 2))
    const text = `${String(day.getUTCDate()).padStart(2, '0')}.${String(day.getUTCMonth() + 1).padStart(2, '0')}.${day.getUTCFullYear()}`
    return `  <tr><td>${text}</td><td>Schulanlass ${index + 1}</td><td>Aula</td></tr>`
  }).join('\n')}
</table>`),
  'start.html': page(`
<a href="index.php?pageid=1">Start</a>
<div>
  <h2>Letzten Noten</h2>
  <table>
    <tr><td>DEU-K26A-1</td><td>Lesetest</td><td>02.02.2026</td><td>5.5</td></tr>
    <tr><td>MAT_ALG-K26A-1</td><td>Aufgabenblatt</td><td>03.03.2026</td><td>4.5</td></tr>
    <tr><td>Chemie-K26A-1</td><td>Laborbericht</td><td>04.04.2026</td><td>5.0</td></tr>
  </table>
</div>
<div>
  <h2>Termine</h2>
  <table>
    <tr><td>05.05.2026</td><td>06.05.2026</td><td>Aula</td><td>Probenkonzert</td></tr>
  </table>
</div>
`),
  'agenda.html': page(`
<a href="index.php?pageid=21200">Agenda</a>
<p>Synthetic agenda for class K26A. Contact the fixture maintainer at desk@example.org.</p>
`),
}

await mkdir(root, { recursive: true })
for (const [name, html] of Object.entries(files)) {
  await writeFile(join(root, name), `${html.trim()}\n`, 'utf8')
}
console.log(`wrote ${Object.keys(files).length} synthetic fixtures`)
