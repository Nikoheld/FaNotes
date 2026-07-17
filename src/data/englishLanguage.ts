const words = `
a about above after again against all almost along already also always am among an and another any anyone anything
are around as ask at away back be because become been before being below between big both but by call came can
cannot change child children class come could course day did different do does done down during each early end enough
even ever every example fact family far feel few find first five following for form found four from full get give go
good got great group had hand has have he head help her here high him his home house how however i idea if important
in into is it its just keep kind know large last later learn leave left less let life like line little long look made
make man many may me mean might more most mother much must my name need never new next night no not now number of off
often old on once one only open or other our out over own page part people place point problem program put question
read really right said same say school see seem sentence set she should show side since small so some something sound
start state still stop student study such system take tell text than that the their them then there these they thing
think this those three through time to together too try two under understand up us use very want was water way we well
were what when where which while who why will with word work world would write year yes yet you young your
answer book browser chapter computer correct data desktop document drawing editor english exercise file folder
handwriting hello history homework language local markdown mathematics note notes paper paragraph recognition science
software subject tablet teacher test training welcome
`.trim().split(/\s+/)

export const ENGLISH_COMMON_WORDS = new Set(words.map((word) => word.toLocaleLowerCase('en')))

export const ENGLISH_COMMON_BIGRAMS = new Set(`
th he in er an re on at en nd ti es or te of ed is it al ar st to nt ng se ha as ou io le ve co me de
hi ri ro ic ne ea ra ce li ch ll be ma si om ur ca el ta la ns di fo ho pe ec pr no ct us ac ot il tr ly
`.trim().split(/\s+/))

export const ENGLISH_COMMON_TRIGRAMS = new Set(`
the and ing her ere ent tha nth was eth for dth hat she ion tio ver est ers ati his all ith hes ter ect rea
con not you are thi wit but had one our out eve pro com ive lin res sta ter use wor sch stu lea wri rea
`.trim().split(/\s+/))
