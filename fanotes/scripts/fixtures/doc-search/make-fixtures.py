#!/usr/bin/env python3
"""Synthetic documents for document-search tests. All content is made up.

usage: make-fixtures.py OUTDIR
Needs Pillow, DejaVu fonts and qpdf. Writes:
  text-de.pdf        3 pages with a text layer (umlauts, ß, hyphenation)
  scan-de.pdf        3 image-only pages (OCR needed), page 2 blank
  mixed.pdf          text pages + scanned pages
  rotated-page.pdf   scanned page stored with /Rotate 90 (viewer shows it upright)
  rotated-image.pdf  scanned page whose picture itself is turned 90 degrees
  encrypted.pdf      password protected
  large-300.pdf      300 text pages with unique page markers
  worksheet.png      an image worksheet
"""
import os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
SANS = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'

def esc(text):
    return text.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')

def text_pdf(path, pages):
    """Minimal PDF with Helvetica/WinAnsi text so pdf.js extracts real text."""
    objects = []
    def add(body):
        objects.append(body)
        return len(objects)
    font = add(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
    pages_id = len(objects) + 1 + 2 * len(pages)
    kids = []
    for lines in pages:
        stream = 'BT /F1 13 Tf 60 780 Td 18 TL\n' + '\n'.join(f'({esc(line)}) Tj T*' for line in lines) + '\nET'
        data = stream.encode('cp1252')
        content = add(b'<< /Length %d >>\nstream\n' % len(data) + data + b'\nendstream')
        kids.append(add(b'<< /Type /Page /Parent %d 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>' % (pages_id, font, content)))
    assert add(b'<< /Type /Pages /Kids [' + b' '.join(b'%d 0 R' % k for k in kids) + b'] /Count %d >>' % len(kids)) == pages_id
    catalog = add(b'<< /Type /Catalog /Pages %d 0 R >>' % pages_id)
    body = b'%PDF-1.4\n'
    offsets = []
    for index, obj in enumerate(objects, 1):
        offsets.append(len(body))
        body += b'%d 0 obj\n' % index + obj + b'\nendobj\n'
    xref = len(body)
    body += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objects) + 1)
    body += b''.join(b'%010d 00000 n \n' % offset for offset in offsets)
    body += b'trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objects) + 1, catalog, xref)
    open(path, 'wb').write(body)

def scan_page(lines, size=30):
    image = Image.new('L', (1240, 1754), 255)
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(SANS, size)
    y = 140
    for line in lines:
        draw.text((110, y), line, font=font, fill=25)
        y += int(size * 1.9)
    return image

def scans_pdf(path, pages):
    images = [page.convert('RGB') for page in pages]
    images[0].save(path, save_all=True, append_images=images[1:], resolution=150)

text_pdf(f'{out}/text-de.pdf', [
    ['Kapitel 1: Energie', 'Die Lageenergie hängt von der Höhe ab.', 'Übungsaufgabe zur Straßenbahn und Größe.'],
    ['Kapitel 2: Bewegung', 'Die Bewegungsenergie wächst mit dem Quadrat', 'der Geschwindigkeit. Integral-', 'rechnung folgt später.'],
    ['Kapitel 3: Wärme', 'Reibung erzeugt Wärme im Getriebe.'],
])
scans_pdf(f'{out}/scan-de.pdf', [
    scan_page(['Arbeitsblatt Fotosynthese', 'Pflanzen brauchen Licht und Wasser.', 'Chlorophyll macht die Blätter grün.']),
    Image.new('L', (1240, 1754), 255),
    scan_page(['Seite drei der Kopie', 'Die Zellatmung findet in Mitochondrien statt.']),
])
scans_pdf(f'{out}/scan-tail.pdf', [scan_page(['Gemischtes Dokument', 'Die Nahrungskette beginnt bei Pflanzen.', 'Räuber fressen Beutetiere.'])])
subprocess.run(['qpdf', '--empty', '--pages', f'{out}/text-de.pdf', '1-2', f'{out}/scan-tail.pdf', '--', f'{out}/mixed.pdf'], check=True)
# Stored turned 90 degrees counter-clockwise; /Rotate 90 makes viewers show it upright.
scans_pdf(f'{out}/rotated-base.pdf', [scan_page(['Gedrehte Seite', 'Vulkane stoßen Lava und Asche aus.']).rotate(90, expand=True)])
subprocess.run(['qpdf', f'{out}/rotated-base.pdf', '--rotate=+90:1', f'{out}/rotated-page.pdf'], check=True)
scans_pdf(f'{out}/rotated-image.pdf', [scan_page(['Quer eingescannt', 'Gletscher formen Täler im Gebirge.', 'Moränen bleiben liegen.']).rotate(90, expand=True)])
subprocess.run(['qpdf', '--encrypt', 'schule', 'schule-owner', '256', '--', f'{out}/text-de.pdf', f'{out}/encrypted.pdf'], check=True)
text_pdf(f'{out}/large-300.pdf', [[f'Lehrbuch Seite {n}', f'Seitenmarke{n}x Abschnitt über Geschichte und Demokratie.', 'Revolution, Verfassung und Wahlen im Überblick.'] for n in range(1, 301)])
scan_page(['Arbeitsblatt Vokabeln', 'Schmetterling heißt butterfly.']).save(f'{out}/worksheet.png')
for name in ['rotated-base.pdf', 'scan-tail.pdf']:
    os.remove(f'{out}/{name}')
print('\n'.join(sorted(os.listdir(out))))
