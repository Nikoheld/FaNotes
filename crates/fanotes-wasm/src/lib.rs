//! Browser and Electron entry for the paper reducer.
//!
//! `DrawingBoard` calls these for page grow and for the keep-on-page remap.
//! The objects use the same camelCase fields as `fanotes/src/lib/noteCanvas.ts`.

use fanotes_paper::{
    apply_stay_put_op, grow_page_from_mark, keep_mark_on_page, Mark, PageExtent, Painted,
    SheetShift, StayPutOp, StayPutState,
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

fn rejected(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct StayPutStateIn {
    paper_x: f64,
    paper_y: f64,
    cam_x: f64,
    cam_y: f64,
    width: f64,
    height: f64,
    origin_x: f64,
    origin_y: f64,
    editor_x: f64,
    editor_y: f64,
}

impl From<StayPutStateIn> for StayPutState {
    fn from(value: StayPutStateIn) -> Self {
        Self {
            paper_x: value.paper_x,
            paper_y: value.paper_y,
            cam_x: value.cam_x,
            cam_y: value.cam_y,
            width: value.width,
            height: value.height,
            origin_x: value.origin_x,
            origin_y: value.origin_y,
            editor_x: value.editor_x,
            editor_y: value.editor_y,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StayPutStateOut {
    paper_x: f64,
    paper_y: f64,
    cam_x: f64,
    cam_y: f64,
    width: f64,
    height: f64,
    origin_x: f64,
    origin_y: f64,
    editor_x: f64,
    editor_y: f64,
}

impl From<StayPutState> for StayPutStateOut {
    fn from(value: StayPutState) -> Self {
        Self {
            paper_x: value.paper_x,
            paper_y: value.paper_y,
            cam_x: value.cam_x,
            cam_y: value.cam_y,
            width: value.width,
            height: value.height,
            origin_x: value.origin_x,
            origin_y: value.origin_y,
            editor_x: value.editor_x,
            editor_y: value.editor_y,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SheetShiftIn {
    x: Option<f64>,
    y: Option<f64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct StayPutOpIn {
    cam_x: Option<f64>,
    cam_y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
    pad_x: Option<f64>,
    pad_y: Option<f64>,
    editor_x: Option<f64>,
    editor_y: Option<f64>,
    sheet_shift: Option<SheetShiftIn>,
    painted_width: Option<f64>,
    painted_height: Option<f64>,
    lock_editor: bool,
}

impl From<StayPutOpIn> for StayPutOp {
    fn from(value: StayPutOpIn) -> Self {
        Self {
            cam_x: value.cam_x,
            cam_y: value.cam_y,
            width: value.width,
            height: value.height,
            pad_x: value.pad_x,
            pad_y: value.pad_y,
            editor_x: value.editor_x,
            editor_y: value.editor_y,
            sheet_shift: value.sheet_shift.map(|shift| SheetShift {
                x: shift.x,
                y: shift.y,
            }),
            painted_width: value.painted_width,
            painted_height: value.painted_height,
            lock_editor: value.lock_editor,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ExtentIn {
    width: f64,
    height: f64,
    origin_x: Option<f64>,
    origin_y: Option<f64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct MarkIn {
    x: Option<f64>,
    y: Option<f64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PaintedIn {
    width: Option<f64>,
    height: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GrownOut {
    width: f64,
    height: f64,
    pad_x: f64,
    pad_y: f64,
}

/// Same contract as `applyStayPutOp` in `noteCanvas.ts`.
#[wasm_bindgen(js_name = applyStayPutOp)]
pub fn apply_stay_put_op_js(state: JsValue, op: JsValue) -> Result<JsValue, JsValue> {
    let state = serde_wasm_bindgen::from_value::<StayPutStateIn>(state).map_err(rejected)?;
    let op = serde_wasm_bindgen::from_value::<StayPutOpIn>(op).map_err(rejected)?;
    let next = apply_stay_put_op(state.into(), op.into());
    serde_wasm_bindgen::to_value(&StayPutStateOut::from(next)).map_err(rejected)
}

/// Same contract as `growPageFromMark` in `noteCanvas.ts`.
#[wasm_bindgen(js_name = growPageFromMark)]
pub fn grow_page_from_mark_js(
    extent: JsValue,
    mark: JsValue,
    painted: JsValue,
) -> Result<JsValue, JsValue> {
    let extent = serde_wasm_bindgen::from_value::<ExtentIn>(extent).map_err(rejected)?;
    let mark = serde_wasm_bindgen::from_value::<MarkIn>(mark).map_err(rejected)?;
    let painted = serde_wasm_bindgen::from_value::<PaintedIn>(painted).map_err(rejected)?;
    let grown = grow_page_from_mark(
        PageExtent {
            width: extent.width,
            height: extent.height,
            origin_x: extent.origin_x.unwrap_or(0.0),
            origin_y: extent.origin_y.unwrap_or(0.0),
        },
        Mark {
            x: mark.x,
            y: mark.y,
        },
        Painted {
            width: painted.width,
            height: painted.height,
        },
    );
    serde_wasm_bindgen::to_value(&GrownOut {
        width: grown.width,
        height: grown.height,
        pad_x: grown.pad_x,
        pad_y: grown.pad_y,
    })
    .map_err(rejected)
}

/// Same contract as `keepMarkOnPage` in `noteCanvas.ts`.
#[wasm_bindgen(js_name = keepMarkOnPage)]
pub fn keep_mark_on_page_js(value: f64, prev_extent: f64, next_extent: f64, min_pad: f64) -> f64 {
    keep_mark_on_page(value, prev_extent, next_extent, min_pad)
}
