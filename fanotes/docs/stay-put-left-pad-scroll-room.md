# Stay-put: left-edge pad and camera-room jump

Linux 2026.9.3 report `1788376550462` (“IT STILL MOVES AROUND”) wrote near the left of a new markdown note. The write page grew by `WRITE_MARGIN_X` (padX 108, 2186→2294) and the camera panned by that pad. The next samples then sat in a box that was the page plus `2*SCROLL_ROOM` (2294+1120=3414, 1408+1120=2528) with the same cumulative pad and `jump: true`.

2026.9.4 keeps typed text and existing ink on the same paper pixels through that sequence:

- Origin pad in bug-report frames is cumulative. The live path applies only the new pad (`originPadDelta`), offsets markdown in CSS px (`textOriginCssPx`), and pans the camera by that same pad (`paperOriginScrollDelta`).
- A painted box that is exactly the write page plus `2*SCROLL_ROOM` is extra pan paper, not a max-edge grow (`writePageStayExtent`). Overlay 0–1 samples are lifted onto the write page (`overlaySampleOntoWritePage`) so the jump filter does not drop the stroke.

Gating check: `npm run check:stay-put` (`scripts/check-stay-put.mjs`) drives report `1788376550462`.
