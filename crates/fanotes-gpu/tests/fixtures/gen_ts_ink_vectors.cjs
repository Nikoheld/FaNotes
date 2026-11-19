// Regenerates ts_ink_vectors.json from the TypeScript painter:
//   node crates/fanotes-gpu/tests/fixtures/gen_ts_ink_vectors.cjs fanotes/src/lib/inkStrokePaint.ts > crates/fanotes-gpu/tests/fixtures/ts_ink_vectors.json
const src=require("fs").readFileSync(process.argv[2],"utf8");
const body=(name)=>{const i=src.indexOf("const "+name+" = ");const s=src.slice(i);return s.slice(0,s.indexOf("\n}\n")+2)};
const pwSrc=body("pressureWidth").replace(/^export /,"").replace(/\(stroke: \{[^}]*\}, pressure: number\)/,"(stroke, pressure)");
const bpSrc=body("brushPasses").replace("(brush: string): readonly InkPaintPass[]","(brush)");
const pressureWidth=new Function(pwSrc+"\nreturn pressureWidth")();
const brushPasses=new Function("OPAQUE_PASS",bpSrc+"\nreturn brushPasses")([{widthFactor:1,alpha:1}]);
const pens=[0.5,1,2.5,3.5,6,12,48], ps=[0,0.05,0.08,0.35,0.5,0.9,1,1.25];
const widths=[];for(const b of pens)for(const p of ps)widths.push([b,true,p,pressureWidth({baseWidth:b,pressureEnabled:true},p)]);
for(const b of pens)widths.push([b,false,0.9,pressureWidth({baseWidth:b,pressureEnabled:false},0.9)]);
const brushes=["fineliner","pencil","marker","paintbrush","calligraphy","highlighter","watercolor","spray"];
const passes=Object.fromEntries(brushes.map(b=>[b,brushPasses(b).map(p=>[p.widthFactor,p.alpha,p.jitter??null])]));
process.stdout.write(JSON.stringify({source:"fanotes/src/lib/inkStrokePaint.ts: pressureWidth and brushPasses, evaluated by Node",widths,passes},null,0)+"\n");
