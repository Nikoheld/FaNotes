const words = `
aber abend acht alle allein allem allen aller alles als also alt am an andere anderen anderer anderes auch auf aus
bald bei beide beiden beim beispiel bereits besser bin bis bist bitte bleiben bleibt brauchen braucht bringen buch
da dabei dafür dagegen daher damit danach dann das dass davon dazu dein deine dem den denn der deren deshalb die
dies diese diesem diesen dieser dieses doch dort drei du durch dürfen ein eine einem einen einer eines einfach einmal
eins ende endlich er erste ersten es etwas euch euer eure fall fast finden findet fünf für ganz geben gegen geht
gemacht genau gern gestern gibt gleich gross gute guten haben hat hatte hätte heute hier hin hinter ich ihr ihre im
immer in ins ist ja jede jedem jeden jeder jedes jetzt kann keine keinem keinen keiner kleines kommen kommt können
konnte kurz lassen leben leider lernen lesen leute machen macht man mehr mein meine mensch mich mir mit morgen muss
müssen nach nächste nein neue neuen nicht nichts nie noch nun nur ob oder oft ohne paar problem richtig sagt schon
schreiben sehen sehr sein seine seit selbst sich sie sind so soll sollen sonst später stehen steht tag text tun über
um und uns unser unsere unter viel vielleicht vier vom von vor war waren warum was weg weil weiter welche welchem
welchen welcher welches welt wenn werde werden wer wie wieder will wir wird wo wohl worden würde würden zwei zwischen
arbeit auto bild browser computer danke datei daten deutsch deutschland direkt dürfen erkennen erkennung familie frage frau
freund freunde früh gehen geld geschichte hand haus herr hoch jahr jahren kind kinder klar klein land lang lange liebe
lösung mal mann minute monat möglich name neu nummer online ort person programm satz schule schön schöne schönen seite
sicher software sprache stadt stark stift stunde system tablet teil test uhr vater wasser wichtig wissen woche wort
zeit zeichen ziel zuhause zusammen notiz notizen papier abstand tabelle rechnen grenze funktion
anfang antwort brauchen diesem dinge eigentlich einfach einmal einige ersten fragen geben gemacht genau gesehen heute
immer jeder keine machen möglich müssen natürlich neuen sagen sollen unter viele vielleicht wollen
binnen bitte hallo guten morgen mittag nachmittag nacht willkommen tschüss gruss grüsse
mathe mathematik informatik physik chemie biologie wirtschaft formel gleichung aufgabe bruch wurzel summe zahl zahlen buchstabe buchstaben symbol symbole
läuft läufts funktioniert erkannt verbessert verbessern korrekt korrektur modell zeichnen falsch lokal automatisch direkt
äusserst ausserdem ändern ähnlich öffnen öffentlich grösste grösser grünen führen zurück übermorgen übung
heiss heissen weiss weisst gross grossartig strasse strassen fuss grüsse süss schön schöner schönes
`.trim().split(/\s+/)

export const GERMAN_COMMON_WORDS = new Set(words.map((word) => word.toLocaleLowerCase('de')))

export const GERMAN_COMMON_BIGRAMS = new Set(`
ch ei en er es ge ie in nd te de un st be re he an au ng le se ne it is di ic sc zu da ra
ma we si nt el li ht ig as et al ar em mi or wa ha tt ll ss nn mm tz ck pf qu ei äu eu
`.trim().split(/\s+/))

export const GERMAN_COMMON_TRIGRAMS = new Set(`
der die und ich sch ein che den ten cht ung gen ine nde ste ter ber hen ers ver end est nen
aus bei mit auf das sie ist en er ge ier lic uch kei hei sei ell nst rei eis iss tra spr
`.trim().split(/\s+/))
