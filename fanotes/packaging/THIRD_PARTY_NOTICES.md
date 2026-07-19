FaNotes – Third-Party Notices

Hershey Roman Simplex vector font data and the “hershey” JavaScript package
are used by the offline standard handwriting recognizer.

Hershey font acknowledgements
==============================
The Hershey Fonts were originally created by Dr. A. V. Hershey while working
at the U. S. National Bureau of Standards.

The format of the font data in this distribution was originally created by:
James Hurt
Cognition, Inc.
900 Technology Park Drive
Billerica, MA 01821
(mit-eddie!ci-dandelion!hurt)

The font data may be used by anyone for any purpose, commercial or otherwise.
It may be converted into any format except the format distributed by the U.S.
NTIS. This distribution is not in the NTIS format.

hershey JavaScript package
==========================
MIT License

Copyright (c) 2019 Ben Nortier

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Bundled handwriting fonts
==========================
The zero-training recognizer embeds Caveat, Kalam and Dancing Script through
Fontsource. Caveat is Copyright 2014 The Caveat Project Authors. Kalam is
Copyright (c) 2014 Indian Type Foundry. Dancing Script is Copyright 2016 The
Dancing Script Project Authors and reserves the font name “Dancing Script”.
All three fonts are licensed under the SIL Open Font License 1.1. The complete
license is shipped as `LICENSE-OFL-1.1.txt`.

Sources: https://fontsource.org/fonts/caveat,
https://fontsource.org/fonts/kalam and
https://fontsource.org/fonts/dancing-script

HASYv2 generic symbol prototypes
================================
FaNotes includes compact, quantized class prototypes derived from HASYv2 by
Martin Thoma. The application does not contain the source PNG collection or
individual contributor samples. Prototype construction excludes a
deterministic contributor-disjoint holdout set, limits the influence of each
remaining contributor per class, and stores the aggregate holdout report in
the generated model metadata.

HASYv2 is made available under the Open Data Commons Open Database License
1.0 (ODbL-1.0). The derived prototype database remains subject to that
license. A copy or the canonical license text is available at
https://opendatacommons.org/licenses/odbl/1-0/. Attribution: Martin Thoma,
“The HASYv2 dataset”, DOI 10.5281/zenodo.259444.

Source: https://doi.org/10.5281/zenodo.259444

Local neural handwriting recognition
====================================
FaNotes includes `FaNotes_TrOCR_DE_EN`, a local German/English handwriting
recognition model fine-tuned from Microsoft's TrOCR Small Handwritten model.
TrOCR and the Microsoft UniLM project are licensed under the MIT License; the
complete upstream license is shipped as `LICENSE-TROCR-MIT.txt`.

The upstream handwriting checkpoint uses the IAM Handwriting Database. IAM is
provided for non-commercial research use and requests citation of U. Marti and
H. Bunke, “The IAM-database: An English Sentence Database for Off-line
Handwriting Recognition”, IJDAR 5 (2002), 39–46. The German fine-tuning data is
the ScaDS.AI German Line- and Word-Level Handwriting Dataset version 1.0 by
Thomas Burghardt and Ahmad Alzin, licensed under CC BY 4.0, DOI
10.5281/zenodo.18301532. `FaNotes_TrOCR_DE_EN` is a derived model component and
is not relicensed by FaNotes' application-code MIT license.

Inference uses Transformers.js 3.8.1 by Hugging Face under the Apache License
2.0 and ONNX Runtime Web by Microsoft Corporation under the MIT License. The
complete licenses are shipped as `LICENSE-TRANSFORMERS-APACHE-2.0.txt` and
`LICENSE-ONNXRUNTIME-MIT.txt`. All inference runs locally in a sandboxed Web
Worker; handwriting images are not sent to Hugging Face, Microsoft, or another
recognition service.

Sources: https://github.com/microsoft/unilm/tree/master/trocr,
https://fki.tic.heia-fr.ch/databases/iam-handwriting-database,
https://doi.org/10.5281/zenodo.18301532,
https://github.com/huggingface/transformers.js and
https://github.com/microsoft/onnxruntime

PyLaia fallback recognizer
--------------------------
FaNotes includes the PyLaia IAM handwriting-recognition model published by
Teklia and converted from the official PyTorch checkpoint to ONNX. The model
was trained on the RWTH split of the IAM handwriting database and recognizes
complete text lines locally without contacting a remote service. The model
card and PyLaia are provided under the MIT License. The complete license is
shipped as `ocr/LICENSE-PYLAIA-MIT.txt`.

Web inference uses ONNX Runtime Web 1.22.0 and desktop inference uses the
CPU-only x64 distribution of ONNX Runtime Node 1.21.0, both by Microsoft
Corporation and licensed under the MIT License. The complete license is
shipped as `ocr/LICENSE-ONNXRUNTIME-MIT.txt`. FaNotes does not package the
CUDA, TensorRT or DirectML providers; the native CPU runtime dispatches to the
instruction set supported by the installed Intel or AMD processor.

Sources: https://huggingface.co/Teklia/pylaia-iam,
https://gitlab.teklia.com/atr/pylaia and
https://github.com/microsoft/onnxruntime

FaNotes local spelling filters
==============================
The compact German and English Bloom filters shipped with FaNotes are derived
at build time from dictionary-de 3.0.0, dictionary-en 4.0.0 and
dictionary-en-gb 3.0.0. nspell 2.1.5 expands the Hunspell word forms.
SUBTLEXus frequencies, distributed through subtlex-word-frequencies 2.0.0,
keep corpus-unsupported supplementary forms out of the OCR replacement prior;
none of these build tools is loaded by FaNotes at runtime.

German word forms (dictionary-de / igerman98)
----------------------------------------------
Copyright (C) 1999-2016 Björn Jacke <bjoern@j3e.de>.

Licensed under the GNU General Public License, version 2 or version 3. FaNotes
distributes this derived filter under GPL version 3. The complete license and
upstream notice are installed beside the filter as
`spell/LICENSE-GPL-3.0.txt` and `spell/NOTICE-dictionary-de.txt`.

Source: https://www.npmjs.com/package/dictionary-de

English word forms (dictionary-en / SCOWL en_US)
-------------------------------------------------
The data contains material under several permissive and public-domain terms,
including SCOWL, Ispell, 12dicts, ENABLE, MWords, UKACD and VarCon. The complete
upstream attribution and redistribution terms are installed verbatim as
`spell/LICENSE-dictionary-en.txt`.

Source: https://www.npmjs.com/package/dictionary-en

British English word forms (dictionary-en-gb / SCOWL en_GB)
------------------------------------------------------------
The data is distributed under the same permissive and public-domain SCOWL
family of terms. The complete upstream attribution and redistribution terms
are installed verbatim as `spell/LICENSE-dictionary-en-gb.txt`.

Source: https://www.npmjs.com/package/dictionary-en-gb

SUBTLEX word frequencies
------------------------
The OCR candidate filter uses word counts derived from the 51-million-token
SUBTLEXus subtitle corpus via subtlex-word-frequencies 2.0.0. The packaged
frequency list is Copyright (c) Zeke Sikelianos and licensed under ISC. The
complete license is installed as
`spell/LICENSE-SUBTLEX-WORD-FREQUENCIES-ISC.txt`.

Sources: https://www.ugent.be/pp/experimentele-psychologie/en/research/documents/subtlexus
and https://www.npmjs.com/package/subtlex-word-frequencies

nspell build tool
-----------------
Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com>.
Licensed under the MIT License. The complete license is installed as
`spell/LICENSE-nspell.txt`.

Source: https://www.npmjs.com/package/nspell

OneNote import components
=========================
FaNotes uses one2html 1.3.1 and onenote_parser 1.1.1 only after the user
explicitly starts a Microsoft OneNote import. The platform binaries are copied
from the signed GitHub release archives whose SHA-256 digests are verified by
the FaNotes release process. Version 1.3.1 includes the fixes for
CVE-2026-22810 and GHSA-4j5m-wc25-pvh7.

one2html 1.3.1
--------------
Copyright (c) Markus Siemens and contributors.
Licensed under the MIT License. The complete license is embedded beside the
import component as `resources/onenote/LICENSE-one2html.txt`.

Source: https://github.com/msiemens/one2html

onenote_parser 1.1.1
---------------------
Copyright (c) Markus Siemens and contributors.
Licensed under the Mozilla Public License 2.0. The complete license is
embedded as `resources/onenote/LICENSE-onenote-parser.txt`.

Source: https://github.com/msiemens/onenote.rs

7zip-bin 5.2.0
--------------
The platform archive helper is distributed by the 7zip-bin package under the
MIT License. The complete package license is embedded as
`resources/onenote/LICENSE-7zip-bin.txt`. 7-Zip itself contains components under the GNU
LGPL and BSD licenses; its full upstream notices are available from 7-zip.org.

Source: https://www.npmjs.com/package/7zip-bin

The bundled 7za executables are parts of 7-Zip and are distributed primarily
under the GNU LGPL, with the upstream BSD and unRAR notices reproduced in
`resources/onenote/LICENSE-7zip.txt`. The corresponding source is available at
https://www.7-zip.org/.
