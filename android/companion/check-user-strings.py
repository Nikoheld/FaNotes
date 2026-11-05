#!/usr/bin/env python3
"""Fail when Kanti+ UI copy is hardcoded or the German catalog drifts from English.

Runs from the Android project on preBuild, including CI assembleDebug.
Swiss German uses ss, never the sharp s. Both catalogs must share every key,
plural quantity, and placeholder token.
"""

import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

COMPANION = Path(__file__).resolve().parent
SRC = COMPANION / "src" / "main"
VALUES = SRC / "res" / "values" / "strings.xml"
VALUES_DE = SRC / "res" / "values-de" / "strings.xml"

PLACEHOLDER = re.compile(r"%(?:\d+\$)?[sd]")
VERSION_LINE = "Kanti+ · %1$s"

UI_FUNCS = {
    "Text", "SectionLabel", "SettingRow", "ToggleRow", "EmptyState", "InfoBanner",
    "ConfirmDialog", "LoadingState", "SheetTitle", "ActionIcon", "Tag", "SearchField",
    "ChoiceRow", "OutlinedTextField", "TextField", "BasicText", "BasicTextField",
    "setTextViewText", "DiagnosticLine", "NameDialog", "DateControl", "TimeControl",
    "Icon", "Image", "SchoolLoading", "ExpandableRecord", "shareFile", "makeText",
    "perform", "contentDescription", "stateDescription",
}

# Stored Schulnetz, sync, and route text. Display goes through shownText or a code mapper.
PROTOCOL = {
    "Bei Schulnetz neu anmelden",
    "Die Microsoft-Anmeldung ist abgelaufen. In Kanti+ neu anmelden.",
    "Die Schulnetz-Sitzung ist abgelaufen.",
    "Blockiert: ${redactSchulnetzSecrets(url)}",
    "Laden fehlgeschlagen",
    "Stundenplan: Seite geladen, aber nicht lesbar",
    "Mitteilung",
    "Termin",
    "Anfrage fehlgeschlagen ($code).",
    "Anfrage fehlgeschlagen ($status).",
    "Diese Schulnetz-Anmeldung ist nicht erlaubt.",
    "Schulnetz hat die Anmeldung abgelehnt ($reason).",
    "Schulnetz hat kein Refresh-Token geliefert.",
    "Schulnetz nicht erreichbar",
    "Tippen zum Aufdecken",
    "einem Fach",
    "${shown.linkIds().size} neue Noten – tippen zum Aufdecken",
    "Neue Schulnetz-Meldung",
    "Instant via push",
    "Fallback",
    "Overdue",
    "Today",
    "Upcoming",
    "Completed",
    "No due date",
    "(leer)\n",
}

ASSIGN = re.compile(
    r"\b(?:message|loadError|searchError|pageError|formError|contentDescription|stateDescription)\s*(?:\?\.|\.)?=\s*$"
)
COMPARE = re.compile(r"(?:==|!=)\s*$")
WHEN_ARROW = re.compile(r"^\s*->")
TO_RESOURCE = re.compile(r"^\s*to\s+R\.")
TO_PAIR = re.compile(r"^\s+to\b")
DATE_PATTERN = re.compile(r"^[dMyEHhmsSaz \-./:,·']+$")
TECH_TOKEN = re.compile(r"^[a-z0-9_.:/@+-]+$", re.I)
RESOURCE_REF = re.compile(r"\bR\.(string|plurals)\.([A-Za-z0-9_]+)")


def unescape(value):
    return (value or "").replace("\\'", "'").replace("\\n", "\n").replace("\\t", "\t").replace('\\"', '"')


def catalog(path):
    root = ET.parse(path).getroot()
    strings = {}
    plurals = {}
    for child in root:
        name = child.attrib.get("name")
        if child.tag == "string":
            strings[name] = unescape(child.text)
        elif child.tag == "plurals":
            plurals[name] = {item.attrib.get("quantity"): unescape(item.text) for item in child}
    return strings, plurals


def placeholders(text):
    return PLACEHOLDER.findall(text or "")


def check_catalogs(errors):
    en_s, en_p = catalog(VALUES)
    de_s, de_p = catalog(VALUES_DE)
    if set(en_s) != set(de_s):
        errors.append(f"string keys differ: only-en={sorted(set(en_s) - set(de_s))} only-de={sorted(set(de_s) - set(en_s))}")
    if set(en_p) != set(de_p):
        errors.append(f"plural keys differ: only-en={sorted(set(en_p) - set(de_p))} only-de={sorted(set(de_p) - set(en_p))}")
    for name in sorted(set(en_p) & set(de_p)):
        if set(en_p[name]) != set(de_p[name]):
            errors.append(f"plural quantities differ for {name}: en={sorted(en_p[name])} de={sorted(de_p[name])}")
        for quantity in sorted(set(en_p[name]) & set(de_p[name])):
            if placeholders(en_p[name][quantity]) != placeholders(de_p[name][quantity]):
                errors.append(f"plural placeholders differ for {name}/{quantity}")
    for name in sorted(set(en_s) & set(de_s)):
        if placeholders(en_s[name]) != placeholders(de_s[name]):
            errors.append(f"placeholders differ for {name}: en={placeholders(en_s[name])} de={placeholders(de_s[name])}")
    if en_s.get("version_line") != VERSION_LINE or de_s.get("version_line") != VERSION_LINE:
        errors.append(f"version_line must stay {VERSION_LINE!r}")
    german = VALUES_DE.read_text(encoding="utf-8")
    if "ß" in german or "ẞ" in german:
        errors.append("values-de contains the sharp s character; use ss")
    return en_s, en_p


def literal_words(text):
    """Drop interpolations and printf tokens so only typed copy is judged."""
    out = []
    i = 0
    while i < len(text):
        if text.startswith("${", i):
            depth = 0
            j = i + 1
            while j < len(text):
                if text[j] == "{":
                    depth += 1
                elif text[j] == "}":
                    depth -= 1
                    if depth == 0:
                        j += 1
                        break
                j += 1
            i = j
            continue
        out.append(text[i])
        i += 1
    visible = re.sub(r"%(?:\d+\$)?[0-9.]*[sd]", "", "".join(out))
    return visible


def skip_string(source, start, end, text):
    if text in PROTOCOL:
        return True
    before = source[max(0, start - 80):start]
    after = source[end:end + 24]
    if COMPARE.search(before) or WHEN_ARROW.match(after) or TO_RESOURCE.match(after):
        return True
    if TO_PAIR.match(after) and " " not in text:
        return True
    if ASSIGN.search(before) is None and enclosing_call(source, start) not in UI_FUNCS:
        return True
    visible = literal_words(text)
    if not any(ch.isalpha() for ch in visible):
        return True
    if DATE_PATTERN.fullmatch(visible.strip()):
        return True
    if TECH_TOKEN.fullmatch(visible.strip()) and " " not in visible:
        return True
    if text.startswith("http://") or text.startswith("https://"):
        return True
    return False


def string_spans(source):
    spans = []
    i = 0
    n = len(source)
    while i < n:
        if source.startswith("//", i):
            i = source.find("\n", i)
            if i < 0:
                break
            continue
        if source.startswith("/*", i):
            end = source.find("*/", i + 2)
            i = n if end < 0 else end + 2
            continue
        if source.startswith('"""', i):
            end = source.find('"""', i + 3)
            if end < 0:
                break
            spans.append((i, end + 3, source[i + 3:end]))
            i = end + 3
            continue
        if source[i] == '"':
            j = i + 1
            while j < n:
                if source[j] == "\\":
                    j += 2
                    continue
                if source[j] == '"':
                    spans.append((i, j + 1, decode_string(source[i + 1:j])))
                    i = j + 1
                    break
                j += 1
            else:
                break
            continue
        i += 1
    return spans


def decode_string(raw):
    return raw.replace(r"\n", "\n").replace(r"\t", "\t").replace(r"\"", '"').replace(r"\'", "'")


def enclosing_call(source, index):
    depth = 0
    i = index - 1
    while i >= 0:
        ch = source[i]
        if ch == '"':
            if source.startswith('"""', max(0, i - 2)):
                start = source.rfind('"""', 0, i - 2)
                i = 0 if start < 0 else start - 1
                continue
            j = i - 1
            while j >= 0:
                if source[j] == '"' and (j == 0 or source[j - 1] != "\\"):
                    i = j - 1
                    break
                if source[j] == "\\":
                    j -= 1
                j -= 1
            else:
                return ""
            continue
        if ch == ")":
            depth += 1
        elif ch == "(":
            if depth == 0:
                j = i - 1
                while j >= 0 and source[j].isspace():
                    j -= 1
                end = j + 1
                while j >= 0 and (source[j].isalnum() or source[j] == "_"):
                    j -= 1
                return source[j + 1:end]
            depth -= 1
        i -= 1
    return ""


def line_of(source, index):
    return source.count("\n", 0, index) + 1


def check_kotlin(errors, strings, plurals):
    for path in sorted((SRC / "java").rglob("*.kt")):
        source = path.read_text(encoding="utf-8")
        for kind, name in RESOURCE_REF.findall(source):
            if kind == "string" and name not in strings:
                errors.append(f"{path.name}: missing string {name}")
            if kind == "plurals" and name not in plurals:
                errors.append(f"{path.name}: missing plural {name}")
        for start, end, text in string_spans(source):
            if skip_string(source, start, end, text):
                continue
            if " " not in text and not text.endswith((".", "!", "?", "…")) and len(text) < 4:
                continue
            rel = path.relative_to(COMPANION)
            errors.append(f"{rel}:{line_of(source, start)}: hardcoded UI string {text!r}")


def check_layouts(errors):
    for path in sorted((SRC / "res").rglob("*.xml")):
        if path.name == "strings.xml":
            continue
        text = path.read_text(encoding="utf-8")
        for match in re.finditer(r'android:(?:text|contentDescription|hint|label)="([^"]*)"', text):
            value = match.group(1)
            if value == "" or value.startswith("@string/") or value.startswith("@android:string/"):
                continue
            errors.append(f"{path.relative_to(COMPANION)}: android text must be a string resource ({value!r})")


def main():
    errors = []
    strings, plurals = check_catalogs(errors)
    check_kotlin(errors, strings, plurals)
    check_layouts(errors)
    if errors:
        print("\n".join(errors))
        return 1
    print(f"user strings ok: {len(strings)} strings, {len(plurals)} plurals")
    return 0


if __name__ == "__main__":
    sys.exit(main())
