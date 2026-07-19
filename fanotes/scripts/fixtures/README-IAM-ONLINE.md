# IAM-OnDB runtime fixture

`iam-online-a01-001z-01.json` contains normalized pen coordinates from the
public example line `a01-001z-01.xml` linked by the IAM On-Line Handwriting
Database documentation. The transcription is `By Trevor Williams. A move`.

The fixture is used only by the recognition test suite and is not included in
FaNotes application packages. Coordinates are rounded and timestamps are
replaced by monotonic test values; the handwriting itself is otherwise
unchanged.

Source: https://fki.tic.heia-fr.ch/DBs/iamOnDB/a01-001z-01.xml

Database documentation:
https://fki.tic.heia-fr.ch/databases/iam-on-line-handwriting-database
