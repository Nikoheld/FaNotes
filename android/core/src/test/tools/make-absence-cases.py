# Generates ../resources/schulnetz/absence-points-cases.json (synthetic data): python3 make-absence-cases.py > ../resources/schulnetz/absence-points-cases.json
import json, sys
SLOTS = {1: ("08:00", "08:45"), 2: ("08:45", "09:30"), 3: ("09:45", "10:30"), 4: ("10:30", "11:15"), 5: ("11:25", "12:10"),
         6: ("13:15", "14:00"), 7: ("14:00", "14:45"), 8: ("15:00", "15:45")}
n = [0]
def lesson(day, slot, course, status=""):
    n[0] += 1
    f, t = SLOTS[slot]
    return {"id": str(4000 + slot), "start": f"{day}T{f}:00", "end": f"{day}T{t}:00", "text": course, "comment": "", "room": "B12",
            "teachers": [], "courseId": str(1000 + slot), "courseName": course, "status": status, "eventType": "0_stp", "color": "", "timetableText": course}
def exam(day, slot, course):
    f, t = SLOTS[slot]
    return {"id": f"exam-{day}-{slot}", "start": f"{day}T{f}:00", "end": f"{day}T{t}:00", "text": f"{course} Prüfung Kapitel 4", "comment": "", "room": "",
            "teachers": [], "courseId": "", "courseName": f"{course} Prüfung Kapitel 4", "status": "", "eventType": "exam", "color": "", "timetableText": f"{course} Prüfung Kapitel 4"}
def appointment(day, text):
    return {"id": f"trm-{day}", "start": f"{day}T00:00:00", "end": f"{day}T00:00:00", "text": text, "comment": "", "room": "", "teachers": [], "courseId": "",
            "courseName": text, "status": "", "eventType": "5_trm", "color": "", "timetableText": text}
def swiss(day):
    y, m, d = day.split("-"); return f"{d}.{m}.{y}"
def report(id, day, slot=None, course="geo 2.3", span=None):
    f, t = (SLOTS[slot] if slot else ("", ""))
    if span: f, t = span
    return {"id": id, "dateFrom": swiss(day), "dateTo": swiss(day), "hourFrom": f, "hourTo": t, "subject": course, "reason": "",
            "excused": False, "acknowledged": False, "status": "offen", "pending": True}
def booked(id, day, points, reason="Krankheit"):
    return {"id": id, "dateFrom": swiss(day), "dateTo": swiss(day), "hourFrom": "", "hourTo": "", "subject": "", "reason": reason,
            "excused": False, "acknowledged": True, "status": "gebucht", "points": points}
def day_lessons(day, slots, course="geo 2.3", other="mat 2.1"):
    return [lesson(day, s, course if s in (1, 2) else other) for s in slots]

MON, TUE, WED, THU, FRI, NEXT_MON = "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09"
week = day_lessons(MON, [1, 2, 6, 7]) + day_lessons(WED, [1, 2]) + day_lessons(FRI, [1, 2])
cases = []
def case(name, absences, events, expect, exams=(), quota=30, remaining=30):
    snap = {"absences": absences, "events": events, "exams": list(exams), "absenceParser": 2}
    if quota is not None: snap["absenceQuota"] = quota
    if remaining is not None: snap["absenceRemaining"] = remaining
    cases.append({"name": name, "snapshot": snap, "expect": expect})

case("single lesson: 1 + 1 = 2", [report("a1", TUE, 3, "bio 2.1")], week + day_lessons(TUE, [1, 2, 3, 4]),
     {"estimated": 2, "booked": 0, "remaining": 28, "points": {"a1": 2}, "rules": {"a1": "lessons"}, "blocks": [["a1"]]})
case("double lesson reported as two rows: 2 + 1 = 3", [report("a1", TUE, 1), report("a2", TUE, 2)], week + day_lessons(TUE, [1, 2, 3, 4]),
     {"estimated": 3, "booked": 0, "remaining": 27, "points": {"a1": 3, "a2": 3}, "rules": {"a1": "lessons", "a2": "lessons"}, "blocks": [["a1", "a2"]]})
case("double lesson reported as one row", [report("a1", TUE, span=("08:00", "09:30"))], week + day_lessons(TUE, [1, 2, 3, 4]),
     {"estimated": 3, "booked": 0, "remaining": 27, "points": {"a1": 3}, "rules": {"a1": "lessons"}, "blocks": [["a1"]]})
case("a free period in the timetable is no interruption", [report("a1", TUE, 2), report("a2", TUE, 4, "mat 2.1")], week + day_lessons(TUE, [1, 2, 4]),
     {"estimated": 3, "booked": 0, "remaining": 27, "points": {"a1": 3, "a2": 3}, "rules": {"a1": "lessons", "a2": "lessons"}, "blocks": [["a1", "a2"]]})
case("an attended lesson in between makes two blocks", [report("a1", TUE, 1), report("a2", TUE, 3, "mat 2.1")], week + day_lessons(TUE, [1, 2, 3]),
     {"estimated": 4, "booked": 0, "remaining": 26, "points": {"a1": 2, "a2": 2}, "rules": {"a1": "lessons", "a2": "lessons"}, "blocks": [["a1"], ["a2"]]})
case("a cancelled lesson in between is no interruption", [report("a1", TUE, 1), report("a2", TUE, 3, "mat 2.1")],
     week + [lesson(TUE, 1, "geo 2.3"), lesson(TUE, 2, "eng 2.2", status="cancelled"), lesson(TUE, 3, "mat 2.1")],
     {"estimated": 3, "booked": 0, "remaining": 27, "points": {"a1": 3, "a2": 3}, "rules": {"a1": "lessons", "a2": "lessons"}, "blocks": [["a1", "a2"]]})
case("the night is no interruption", [report("a1", MON, 7, "mat 2.1"), report("a2", TUE, 1)], week + day_lessons(TUE, [1, 2, 3]),
     {"estimated": 3, "booked": 0, "remaining": 27, "points": {"a1": 3, "a2": 3}, "rules": {"a1": "lessons", "a2": "lessons"}, "blocks": [["a1", "a2"]]})
case("before and after a weekend count separately", [report("a1", FRI, 2), report("a2", NEXT_MON, 1)], week + day_lessons(NEXT_MON, [1, 2]),
     {"estimated": 4, "booked": 0, "remaining": 26, "points": {"a1": 2, "a2": 2}, "rules": {"a1": "lessons", "a2": "lessons"}, "blocks": [["a1"], ["a2"]]})
case("an announced exam in the block costs 10 flat", [report("a1", TUE, 1), report("a2", TUE, 2)], week + day_lessons(TUE, [1, 2, 3, 4]),
     {"estimated": 10, "booked": 0, "remaining": 20, "points": {"a1": 10, "a2": 10}, "rules": {"a1": "exam", "a2": "exam"}, "blocks": [["a1", "a2"]]},
     exams=[exam(TUE, 2, "geo 2.3")])
case("an exam in another slot that day does not count", [report("a1", TUE, 1), report("a2", TUE, 2)], week + day_lessons(TUE, [1, 2, 3, 4]),
     {"estimated": 3, "booked": 0, "remaining": 27, "points": {"a1": 3, "a2": 3}, "rules": {"a1": "lessons", "a2": "lessons"}, "blocks": [["a1", "a2"]]},
     exams=[exam(TUE, 4, "mat 2.1")])
case("at most 10 exam points per day", [report("a1", TUE, 1), report("a2", TUE, 4, "mat 2.1")], week + day_lessons(TUE, [1, 2, 3, 4]),
     {"estimated": 10, "booked": 0, "remaining": 20, "points": {"a1": 10, "a2": 0}, "rules": {"a1": "exam", "a2": "exam"}, "blocks": [["a1"], ["a2"]]},
     exams=[exam(TUE, 1, "geo 2.3"), exam(TUE, 4, "mat 2.1")])
case("an instrumental lesson alone costs 3", [report("a1", WED, 4, "IU Klavier")],
     week + [lesson(WED, 3, "mus 2.1"), lesson(WED, 4, "Instrumentalunterricht Klavier"), lesson(WED, 5, "mat 2.1")],
     {"estimated": 3, "booked": 0, "remaining": 27, "points": {"a1": 3}, "rules": {"a1": "instrument"}, "blocks": [["a1"]]})
case("an instrumental lesson in a chain is an ordinary lesson", [report("a1", WED, 3, "mus 2.1"), report("a2", WED, 4, "IU Klavier"), report("a3", WED, 5, "mat 2.1")],
     week + [lesson(WED, 3, "mus 2.1"), lesson(WED, 4, "Instrumentalunterricht Klavier"), lesson(WED, 5, "mat 2.1")],
     {"estimated": 4, "booked": 0, "remaining": 26, "points": {"a1": 4, "a2": 4, "a3": 4}, "rules": {"a1": "lessons", "a2": "lessons", "a3": "lessons"}, "blocks": [["a1", "a2", "a3"]]})
case("a booked entry replaces the estimate for its day", [booked("b1", "2026-10-27", 3), report("a1", "2026-10-27", 1), report("a2", TUE, 1)],
     week + day_lessons("2026-10-27", [1, 2]) + day_lessons(TUE, [1, 2]),
     {"estimated": 2, "booked": 3, "remaining": 25, "points": {"a1": 0, "a2": 2}, "rules": {"a1": "booked", "a2": "lessons"}, "blocks": [["a2"]]}, remaining=27)
case("without a timetable or a time each report is 1 + 1 = 2", [report("a1", "2026-11-17", 1), report("a2", TUE)], week,
     {"estimated": 4, "booked": 0, "remaining": 26, "points": {"a1": 2, "a2": 2}, "rules": {"a1": "fallback", "a2": "fallback"}, "blocks": [["a2"], ["a1"]]})
case("a half special day costs 5", [report("a1", THU, course="Sporttag", span=("08:00", "11:15"))], week + [appointment(THU, "Sporttag")],
     {"estimated": 5, "booked": 0, "remaining": 25, "points": {"a1": 5}, "rules": {"a1": "special"}, "blocks": [["a1"]]})
case("a full special day costs 9", [report("a1", THU, course="Exkursion", span=("08:00", "12:00")), report("a2", THU, course="Exkursion", span=("13:30", "16:00"))], week,
     {"estimated": 9, "booked": 0, "remaining": 21, "points": {"a1": 9, "a2": 9}, "rules": {"a1": "special", "a2": "special"}, "blocks": [["a1", "a2"]]})
case("without a shown remainder the quota minus booked rows counts", [booked("b1", "2026-10-27", 4), report("a1", TUE, 3, "bio 2.1")], week + day_lessons(TUE, [1, 2, 3]),
     {"estimated": 2, "booked": 4, "remaining": 24, "points": {"a1": 2}, "rules": {"a1": "lessons"}, "blocks": [["a1"]]}, remaining=None)
case("without a quota there is no remainder", [report("a1", TUE, 3, "bio 2.1")], week + day_lessons(TUE, [1, 2, 3]),
     {"estimated": 2, "booked": 0, "remaining": None, "points": {"a1": 2}, "rules": {"a1": "lessons"}, "blocks": [["a1"]]}, quota=None, remaining=None)
def row(id, day, hf, ht, subject, reason, status, pending=False, points=None):
    out = {"id": id, "dateFrom": day, "dateTo": day, "hourFrom": hf, "hourTo": ht, "subject": subject, "reason": reason, "status": status, "pending": pending}
    if points is not None: out["points"] = points
    return out
fixtures = {
    "absenzen-aksa-open.html": {"quota": 30, "remaining": 30, "absences": [
        row("abs-open-c6cb4d50", "03.11.2026", "08:00", "08:45", "geo 2.3", "", "offen", pending=True),
        row("abs-open-17bdab9a", "03.11.2026", "08:45", "09:30", "geo 2.3", "", "offen", pending=True)]},
    "absenzen-aksa-booked.html": {"quota": 30, "remaining": 27, "absences": [
        row("abs-2191f926", "27.10.2026", "", "", "", "Krankheit", "gebucht", points=3),
        row("abs-open-a259ae00", "05.11.2026", "10:30", "11:15", "mat 2.1", "", "offen", pending=True)]},
}
json.dump({"note": "Synthetic. Shared by AbsencePointsTest.kt and fanotes-site/absence-points.test.mjs.", "fixtures": fixtures, "cases": cases}, sys.stdout, ensure_ascii=False, indent=1)
