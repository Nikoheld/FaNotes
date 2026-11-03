import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { primaryTrajectory } from '../src/lib/desktopWordPlanner.mjs'
import { createServer } from 'vite'
import { desktopLearningPolicy, TABLET_LEARNING_POLICY, selectDiverseUnits } from '../src/lib/desktopHandwritingPolicy.mjs'
import { spliceTrajectories, optimizeDesktopSplice, trajectoryJoinEnergy, learnPage } from '../src/lib/personalHandwriting.mjs'
const expanded = desktopLearningPolicy({cores:8,memoryBytes:16*1024**3}), balanced = desktopLearningPolicy({cores:2,memoryBytes:4*1024**3})
assert(expanded.pages > TABLET_LEARNING_POLICY.pages)
assert(expanded.units >= TABLET_LEARNING_POLICY.units*6)
assert(expanded.unitPoints > TABLET_LEARNING_POLICY.unitPoints*2)
assert(expanded.recognitionPoints > TABLET_LEARNING_POLICY.recognitionPoints*2)
assert(expanded.beamWidth > balanced.beamWidth && balanced.beamWidth > 1)
assert(expanded.heapMb <= 512 && balanced.hotPoints < expanded.hotPoints)
const server = await createServer({appType:'custom',logLevel:'error',optimizeDeps:{noDiscovery:true},server:{middlewareMode:true}})
const point=(x,y,t=0)=>({x,y,t,pressure:.45,tiltX:0,tiltY:0,pointerType:'pen'})
try {
  const {synthesizeHandwriting:generate} = await server.ssrLoadModule('/src/lib/textToHandwriting.ts')
  const {schoolScript} = await server.ssrLoadModule('/src/lib/schoolScript.mjs')
  const good=JSON.parse(await fs.readFile(new URL('./fixtures/cursive-synthesis.json',import.meta.url))).samples[0]
  const backward={...good,id:'backward-e',strokes:good.strokes.map(s=>({...s,points:s.points.slice().reverse()}))}
  const options={fontSize:42,lineSpacing:1.4,variation:0,connectLetters:true,color:'#202333',baseWidth:3.5,pressureEnabled:true,seed:7}
  const compact=generate('eeee eeee',[good,backward],options)
  const desktop=generate('eeee eeee',[good,backward],{...options,desktopQuality:true})
  assert.equal(desktop.connectionCount,6,'word search selects compatible pen directions for all letters')
  assert.equal(desktop.strokes.length,2,'coherent words remain single continuous pen-down strokes')
  assert.deepEqual(desktop.usedSampleIds,[good.id])
  assert(desktop.connectionCount > compact.connectionCount,'desktop search must improve actual synthesis over independent choices')
  const dwell = { ...good.strokes[0], points: Array.from({length:500},(_,i)=>point(.4+(i%2)*.0001,.05,i)) }
  assert.equal(primaryTrajectory([dwell,good.strokes[0]],65,100),1,'a stationary stylus dwell must not replace the main trajectory just because it has more samples')
  assert.deepEqual(desktop,generate('eeee eeee',[good,backward],{...options,desktopQuality:true}))

  let improvements=0, worstRatio=0
  for(const dy of [-6,-3,0,3,6]) for(const slope of [-.4,0,.4]) {
    const left=[point(0,0),point(3,-3*slope),point(6,0)], right=[point(14,dy),point(17,dy+3*slope),point(20,dy)]
    const old=spliceTrajectories(left,right,42), next=optimizeDesktopSplice(left,right,42)
    if(!old) continue
    assert(next)
    const before=trajectoryJoinEnergy(old,left.length,right.length,42)
    assert(next.energy<=before+1e-10,'optimization may never increase measured bending/curvature variation')
    if(next.energy<before*.99) improvements++
    worstRatio=Math.max(worstRatio,next.energy/before)
    assert.deepEqual(next.points.slice(0,left.length),left)
    assert.deepEqual(next.points.slice(-right.length),right)
  }
  assert(improvements>=5,'extra desktop computation must improve representative joins, not just run more loops')
  assert.equal(optimizeDesktopSplice([point(0,0),point(3,0),point(6,0)],[point(100,0),point(103,0),point(106,0)],42),null)

  // More evidence retained, without lowering recognition thresholds.
  const page=generate('he sch nr '.repeat(30),schoolScript,options,{width:1800,height:1273})
  const document={sourceWidth:page.pageWidth,sourceHeight:page.pageHeight,strokes:page.strokes.map(s=>{const human={...s};delete human.synthesis;return human})}
  const small=learnPage(document,schoolScript), large=learnPage(document,schoolScript,expanded)
  assert(large.observations.length>small.observations.length)
  assert(large.units.length>small.units.length)
  assert(large.units.reduce((n,u)=>n+u.strokes.reduce((m,s)=>m+s.points.length,0),0)<=expanded.pagePoints)
  const ambiguity=schoolScript.flatMap(s=>[s,{...s,id:s.id+'-ambiguous',label:'¤'}])
  assert.equal(learnPage(document,ambiguity,expanded).units.length,0)
  const selected=selectDiverseUnits(large.units,{maxUnits:10,pointBudget:300,variants:2})
  assert(selected.length<=10)
  assert(selected.reduce((n,u)=>n+u.strokes.reduce((m,s)=>m+s.points.length,0),0)<=300)

  const result={compactJoins:compact.connectionCount,desktopJoins:desktop.connectionCount,compactStrokes:compact.strokes.length,desktopStrokes:desktop.strokes.length,joinCasesImproved:improvements,worstEnergyRatio:worstRatio,tabletUnitsPerPage:small.units.length,desktopUnitsPerPage:large.units.length,tabletObservations:small.observations.length,desktopObservations:large.observations.length,expandedPolicy:expanded,balancedPolicy:balanced}
  const output=path.resolve(process.env.FANOTES_HANDWRITING_ARTIFACTS||'../.scratch/handwriting-evaluation')
  await fs.mkdir(output,{recursive:true})
  await fs.writeFile(path.join(output,'desktop-quality-metrics.json'),JSON.stringify(result,null,2)+'\n')
  const svg=r=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="60 65 250 80">${r.strokes.map(s=>`<polyline fill="none" stroke="#202333" stroke-width="${s.baseWidth}" stroke-linecap="round" stroke-linejoin="round" points="${s.points.map(p=>`${p.x*r.pageWidth},${p.y*r.pageHeight}`).join(' ')}"/>`).join('')}</svg>`
  await fs.writeFile(path.join(output,'desktop-word-before.svg'),svg(compact))
  await fs.writeFile(path.join(output,'desktop-word-after.svg'),svg(desktop))
  const html=`<!doctype html><html lang="en"><meta charset="utf-8"><title>FaNotes desktop trajectory search</title><style>body{margin:36px;font:17px system-ui;color:#202333;background:#f5f4ef}h1{font-size:26px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}section{padding:24px;background:white;border:1px solid #ddd;border-radius:12px}img{width:100%}p{line-height:1.5}</style><h1>Linux and Windows: whole-word trajectory search</h1><p>The same synthetic letter has forward and backward variants. The compact route selects letters independently; desktop searches compatible pen movements across the complete word.</p><div class="grid"><section><h2>Compact selection</h2><img src="desktop-word-before.svg"><p>${compact.connectionCount} joins; ${compact.strokes.length} pen-down strokes.</p></section><section><h2>Desktop word search</h2><img src="desktop-word-after.svg"><p>${desktop.connectionCount} continuous joins; ${desktop.strokes.length} word trajectories.</p></section></div><p>Curve optimization lowers measured bending/curvature energy in ${improvements} of 15 transition fixtures. It never increases the metric in this sweep. Expanded desktop retains ${large.units.length} trajectory units from the same page versus ${small.units.length} in the compact profile.</p><p>These are reproducible synthetic regression tests. They do not establish real-writer recognition accuracy, legibility, or indistinguishability. See PERSONAL_HANDWRITING.md for data and hardware limits.</p></html>`
  await fs.writeFile(path.join(output,'desktop-comparison.html'),html)
  console.log(JSON.stringify(result))
} finally {await server.close()}
