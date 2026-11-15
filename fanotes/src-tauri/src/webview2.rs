//! WebView2 (Windows) counterparts of the WebKitGTK window code in `lib.rs`.
//!
//! WebView2 runs every handler and every completion on the UI thread and
//! delivers completions through that thread's message loop. Waiting for a
//! completion on the UI thread from inside a WebView2 handler deadlocks
//! (<https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/threading-model#reentrancy>),
//! and a synchronous Tauri command runs inside one. So the window commands
//! that need a result (PDF export, window image) are async commands: the
//! operation starts on the UI thread through `with_webview`, and the command
//! waits for the completion on its worker thread.
//!
//! The standalone helpers (`Standalone`) create their own hidden host window
//! and pump its messages, for `print_html_to_pdf` and `capture_html`.

use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use tauri::Emitter;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    CreateCoreWebView2EnvironmentWithOptions, ICoreWebView2, ICoreWebView2Controller,
    ICoreWebView2Environment, ICoreWebView2Environment6, ICoreWebView2EnvironmentOptions,
    ICoreWebView2Settings5, ICoreWebView2_7, COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
    COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
};
use webview2_com::{
    take_pwstr, CapturePreviewCompletedHandler, CreateCoreWebView2ControllerCompletedHandler,
    CreateCoreWebView2EnvironmentCompletedHandler, ExecuteScriptCompletedHandler,
    NavigationCompletedEventHandler, NewWindowRequestedEventHandler, PrintToPdfCompletedHandler,
    ZoomFactorChangedEventHandler,
};
use windows::core::{w, Interface, BOOL, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::System::Com::{
    CoInitializeEx, IStream, COINIT_APARTMENTTHREADED, STREAM_SEEK_END, STREAM_SEEK_SET,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Shell::{SHCreateMemStream, ShellExecuteW};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, PeekMessageW, RegisterClassW,
    ShowWindow, TranslateMessage, CW_USEDEFAULT, MSG, PM_REMOVE, SW_SHOWNOACTIVATE, SW_SHOWNORMAL,
    WINDOW_EX_STYLE, WNDCLASSW, WS_OVERLAPPEDWINDOW,
};

pub(crate) const PDF_NOT_READY: &str = "Das Fenster ist nicht bereit für den PDF-Export.";
pub(crate) const PDF_FAILED: &str = "PDF-Export fehlgeschlagen.";
pub(crate) const PDF_WRITE_FAILED: &str = "Die PDF-Datei konnte nicht geschrieben werden.";
pub(crate) const CAPTURE_INVALID: &str = "Das Fensterbild ist ungültig.";

/// A4 in inches, the page Electron's `printToPDF({ pageSize: 'A4' })` uses.
pub(crate) const A4_WIDTH_INCHES: f64 = 210.0 / 25.4;
pub(crate) const A4_HEIGHT_INCHES: f64 = 297.0 / 25.4;
/// Electron 43 `printToPDF` uses 0.4 inch for every margin edge the call omits.
pub(crate) const NOTE_PDF_MARGIN_INCHES: f64 = 0.4;

type Done<T> = Box<dyn FnOnce(Result<T, String>)>;

/// Start `start` on the UI thread and wait here for the result it sends.
///
/// The caller must not be the UI thread (see the module comment). Tauri's
/// event loop runs on the process main thread, which Rust names `main`.
pub(crate) fn on_ui_thread<T, F>(
    window: &tauri::WebviewWindow,
    timeout: Duration,
    error: &'static str,
    start: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&ICoreWebView2Controller, &ICoreWebView2Environment, Done<T>) -> Result<(), String>
        + Send
        + 'static,
{
    if std::thread::current().name() == Some("main") {
        return Err(error.to_owned());
    }
    let (sender, receiver) = mpsc::channel();
    window
        .with_webview(move |webview| {
            let failed = sender.clone();
            let done: Done<T> = Box::new(move |result| {
                let _ = sender.send(result);
            });
            if let Err(message) = start(&webview.controller(), &webview.environment(), done) {
                let _ = failed.send(Err(message));
            }
        })
        .map_err(|_| error.to_owned())?;
    receiver
        .recv_timeout(timeout)
        .map_err(|_| error.to_owned())?
}

/// Run `script` in the page and report when WebView2 finished it.
pub(crate) fn start_script(
    core: &ICoreWebView2,
    script: &str,
    error: &'static str,
    done: Done<String>,
) -> Result<(), String> {
    let handler = ExecuteScriptCompletedHandler::create(Box::new(move |result, json| {
        done(result.map(|()| json).map_err(|_| error.to_owned()));
        Ok(())
    }));
    unsafe { core.ExecuteScript(&HSTRING::from(script), &handler) }.map_err(|_| error.to_owned())
}

/// Print the page to `destination` as an A4 PDF with background graphics.
pub(crate) fn start_print(
    core: &ICoreWebView2,
    environment: &ICoreWebView2Environment,
    destination: &Path,
    done: Done<()>,
) -> Result<(), String> {
    let absolute = std::path::absolute(destination).map_err(|_| PDF_WRITE_FAILED.to_owned())?;
    if let Some(parent) = absolute.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|_| PDF_WRITE_FAILED.to_owned())?;
        }
    }
    let settings = unsafe {
        let environment: ICoreWebView2Environment6 =
            environment.cast().map_err(|_| PDF_NOT_READY.to_owned())?;
        let settings = environment
            .CreatePrintSettings()
            .map_err(|_| PDF_NOT_READY.to_owned())?;
        (|| -> windows::core::Result<()> {
            settings.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT)?;
            settings.SetPageWidth(A4_WIDTH_INCHES)?;
            settings.SetPageHeight(A4_HEIGHT_INCHES)?;
            settings.SetMarginTop(NOTE_PDF_MARGIN_INCHES)?;
            settings.SetMarginBottom(NOTE_PDF_MARGIN_INCHES)?;
            settings.SetMarginLeft(NOTE_PDF_MARGIN_INCHES)?;
            settings.SetMarginRight(NOTE_PDF_MARGIN_INCHES)?;
            settings.SetScaleFactor(1.0)?;
            settings.SetShouldPrintBackgrounds(true)?;
            settings.SetShouldPrintHeaderAndFooter(false)?;
            Ok(())
        })()
        .map_err(|_| PDF_NOT_READY.to_owned())?;
        settings
    };
    let core: ICoreWebView2_7 = core.cast().map_err(|_| PDF_NOT_READY.to_owned())?;
    let written = absolute.clone();
    let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, printed| {
        done(match result {
            Ok(()) if printed && pdf_ready(&written) => Ok(()),
            _ => Err(PDF_FAILED.to_owned()),
        });
        Ok(())
    }));
    let path = HSTRING::from(absolute.as_os_str());
    unsafe { core.PrintToPdf(&path, &settings, &handler) }.map_err(|_| PDF_FAILED.to_owned())
}

/// Capture what the view shows as PNG bytes.
pub(crate) fn start_capture(core: &ICoreWebView2, done: Done<Vec<u8>>) -> Result<(), String> {
    let stream = unsafe { SHCreateMemStream(None) }.ok_or_else(|| CAPTURE_INVALID.to_owned())?;
    let written = stream.clone();
    let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
        done(
            result
                .map_err(|_| CAPTURE_INVALID.to_owned())
                .and_then(|()| read_stream(&written)),
        );
        Ok(())
    }));
    unsafe {
        core.CapturePreview(
            COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
            &stream,
            &handler,
        )
    }
    .map_err(|_| CAPTURE_INVALID.to_owned())
}

fn read_stream(stream: &IStream) -> Result<Vec<u8>, String> {
    unsafe {
        let mut end = 0u64;
        stream
            .Seek(0, STREAM_SEEK_END, Some(&mut end))
            .map_err(|_| CAPTURE_INVALID.to_owned())?;
        stream
            .Seek(0, STREAM_SEEK_SET, None)
            .map_err(|_| CAPTURE_INVALID.to_owned())?;
        let length = usize::try_from(end).map_err(|_| CAPTURE_INVALID.to_owned())?;
        let mut bytes = vec![0u8; length];
        let mut filled = 0usize;
        while filled < length {
            let mut read = 0u32;
            let chunk = u32::try_from(length - filled).unwrap_or(u32::MAX);
            stream
                .Read(bytes[filled..].as_mut_ptr().cast(), chunk, Some(&mut read))
                .ok()
                .map_err(|_| CAPTURE_INVALID.to_owned())?;
            if read == 0 {
                break;
            }
            filled += read as usize;
        }
        bytes.truncate(filled);
        if bytes.is_empty() {
            return Err("Das Fensterbild ist leer.".to_owned());
        }
        Ok(bytes)
    }
}

pub(crate) fn pdf_ready(path: &Path) -> bool {
    std::fs::read(path)
        .ok()
        .is_some_and(|bytes| bytes.starts_with(b"%PDF-") && bytes.len() > 8)
}

/// Open an `http(s)` link in the default browser, like Electron `shell.openExternal`.
///
/// `ShellExecuteW` may block on the shell, so it runs off the UI thread.
pub(crate) fn open_in_browser(href: String) {
    std::thread::spawn(move || unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        ShellExecuteW(
            None,
            w!("open"),
            &HSTRING::from(href),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
    });
}

/// Electron `show: false` until `ready-to-show`; `did-fail-load` still shows it.
pub(crate) fn install_main_window_reveal(window: &tauri::WebviewWindow) {
    let reveal = window.clone();
    let installed = window.with_webview(move |webview| {
        if watch_first_load(&webview.controller(), reveal.clone()).is_err() {
            let _ = reveal.show();
        }
    });
    if installed.is_err() {
        let _ = window.show();
    }
}

fn watch_first_load(
    controller: &ICoreWebView2Controller,
    reveal: tauri::WebviewWindow,
) -> windows::core::Result<()> {
    unsafe {
        let core = controller.CoreWebView2()?;
        let on_complete = reveal.clone();
        let mut token = 0i64;
        core.add_NavigationCompleted(
            &NavigationCompletedEventHandler::create(Box::new(move |_, args| {
                let mut success = BOOL::from(false);
                if let Some(args) = args {
                    let _ = args.IsSuccess(&mut success);
                }
                let success = success.as_bool();
                if crate::main_window_should_reveal(0.0, success, !success) {
                    let _ = on_complete.show();
                }
                Ok(())
            })),
            &mut token,
        )?;
        // The bundle may have finished before this handler was attached. A view
        // that has not navigated yet is still on `about:blank`, which must stay
        // hidden like WebKit's fresh view at progress 0.
        let on_loaded = reveal;
        core.ExecuteScript(
            w!("location.protocol !== 'about:' && document.readyState === 'complete'"),
            &ExecuteScriptCompletedHandler::create(Box::new(move |result, json| {
                let progress = if result.is_ok() && json == "true" {
                    1.0
                } else {
                    0.0
                };
                if crate::main_window_should_reveal(progress, false, false) {
                    let _ = on_loaded.show();
                }
                Ok(())
            })),
        )?;
    }
    Ok(())
}

/// Page zoom becomes the sheet zoom, and `window.open` opens the browser.
///
/// Electron locks Chromium's visual zoom (`setVisualZoomLevelLimits(1, 1)`)
/// and forwards `zoom-changed` as `fanotes:sheet-zoom`. WebView2 is Chromium
/// as well: pinch zoom is switched off, and a zoom factor change is reset to
/// 100 % and forwarded. The WebKitGTK guard does the same with its zoom level.
pub(crate) fn install_webview_guards(window: &tauri::WebviewWindow, emit_sheet_zoom: bool) {
    let emit_window = window.clone();
    let _ = window.with_webview(move |webview| {
        let _ = guard_webview(&webview.controller(), emit_window, emit_sheet_zoom);
    });
}

fn guard_webview(
    controller: &ICoreWebView2Controller,
    emit_window: tauri::WebviewWindow,
    emit_sheet_zoom: bool,
) -> windows::core::Result<()> {
    unsafe {
        controller.SetZoomFactor(1.0)?;
        let mut token = 0i64;
        controller.add_ZoomFactorChanged(
            &ZoomFactorChangedEventHandler::create(Box::new(move |sender, _| {
                let Some(controller) = sender else {
                    return Ok(());
                };
                let mut factor = 1.0;
                controller.ZoomFactor(&mut factor)?;
                let Some(direction) = crate::sheet_zoom_direction(factor) else {
                    return Ok(());
                };
                controller.SetZoomFactor(1.0)?;
                if emit_sheet_zoom {
                    let _ = emit_window.emit("fanotes:sheet-zoom", direction);
                }
                Ok(())
            })),
            &mut token,
        )?;
        let core = controller.CoreWebView2()?;
        if let Ok(settings) = core.Settings()?.cast::<ICoreWebView2Settings5>() {
            settings.SetIsPinchZoomEnabled(false)?;
        }
        core.add_NewWindowRequested(
            &NewWindowRequestedEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                // No second app window, as with Electron's `{ action: 'deny' }`.
                args.SetHandled(true)?;
                let mut uri = PWSTR::null();
                args.Uri(&mut uri)?;
                if let Some(href) = fanotes_host::openable_http_url(&take_pwstr(uri)) {
                    open_in_browser(href);
                }
                Ok(())
            })),
            &mut token,
        )?;
    }
    Ok(())
}

/// A WebView2 in its own hidden host window, for HTML that is not the app page.
pub(crate) struct Standalone {
    window: HWND,
    controller: ICoreWebView2Controller,
    pub core: ICoreWebView2,
    pub environment: ICoreWebView2Environment,
}

impl Standalone {
    /// Load `html` into a `width` × `height` view and wait until it finished.
    pub fn load(html: &str, width: i32, height: i32, error: &'static str) -> Result<Self, String> {
        unsafe {
            // A thread that already joined another apartment keeps it; WebView2
            // only needs a single-threaded apartment, which tests and Tauri use.
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        }
        let window = create_host_window(width, height).map_err(|_| error.to_owned())?;
        let built = (|| {
            let environment = create_environment(error)?;
            let controller = create_controller(&environment, window, error)?;
            Ok::<_, String>((environment, controller))
        })();
        let (environment, controller) = match built {
            Ok(parts) => parts,
            Err(message) => {
                unsafe {
                    let _ = DestroyWindow(window);
                }
                return Err(message);
            }
        };
        let view = (|| unsafe {
            controller.SetBounds(RECT {
                left: 0,
                top: 0,
                right: width,
                bottom: height,
            })?;
            controller.SetIsVisible(true)?;
            controller.CoreWebView2()
        })();
        let core = match view {
            Ok(core) => core,
            Err(_) => {
                unsafe {
                    let _ = controller.Close();
                    let _ = DestroyWindow(window);
                }
                return Err(error.to_owned());
            }
        };
        let standalone = Self {
            window,
            controller,
            core,
            environment,
        };
        let (loaded, loaded_rx) = mpsc::channel();
        let mut token = 0i64;
        unsafe {
            standalone
                .core
                .add_NavigationCompleted(
                    &NavigationCompletedEventHandler::create(Box::new(move |_, _| {
                        let _ = loaded.send(());
                        Ok(())
                    })),
                    &mut token,
                )
                .map_err(|_| error.to_owned())?;
            standalone
                .core
                .NavigateToString(&HSTRING::from(html))
                .map_err(|_| error.to_owned())?;
        }
        pump_until(&loaded_rx, Duration::from_secs(15)).ok_or_else(|| error.to_owned())?;
        Ok(standalone)
    }

    /// Run an operation started with one of the `start_*` helpers to its end.
    pub fn finish<T: 'static>(
        &self,
        timeout: Duration,
        error: &'static str,
        start: impl FnOnce(&Self, Done<T>) -> Result<(), String>,
    ) -> Result<T, String> {
        let (sender, receiver) = mpsc::channel();
        start(
            self,
            Box::new(move |result| {
                let _ = sender.send(result);
            }),
        )?;
        pump_until(&receiver, timeout).ok_or_else(|| error.to_owned())?
    }
}

impl Drop for Standalone {
    fn drop(&mut self) {
        unsafe {
            let _ = self.controller.Close();
            let _ = DestroyWindow(self.window);
        }
    }
}

fn create_environment(error: &'static str) -> Result<ICoreWebView2Environment, String> {
    // The default profile folder sits next to the executable. Tests and the
    // standalone print use a temporary one instead.
    let folder = std::env::temp_dir().join(format!("fanotes-webview2-{}", std::process::id()));
    let folder = HSTRING::from(folder.as_os_str());
    let (sender, receiver) = mpsc::channel();
    let handler = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(
        move |result, environment| {
            let _ = sender.send(result.ok().and(environment));
            Ok(())
        },
    ));
    unsafe {
        CreateCoreWebView2EnvironmentWithOptions(
            PCWSTR::null(),
            &folder,
            None::<&ICoreWebView2EnvironmentOptions>,
            &handler,
        )
    }
    .map_err(|_| error.to_owned())?;
    pump_until(&receiver, Duration::from_secs(30))
        .flatten()
        .ok_or_else(|| error.to_owned())
}

fn create_controller(
    environment: &ICoreWebView2Environment,
    window: HWND,
    error: &'static str,
) -> Result<ICoreWebView2Controller, String> {
    let (sender, receiver) = mpsc::channel();
    let handler = CreateCoreWebView2ControllerCompletedHandler::create(Box::new(
        move |result, controller| {
            let _ = sender.send(result.ok().and(controller));
            Ok(())
        },
    ));
    unsafe { environment.CreateCoreWebView2Controller(window, &handler) }
        .map_err(|_| error.to_owned())?;
    pump_until(&receiver, Duration::from_secs(30))
        .flatten()
        .ok_or_else(|| error.to_owned())
}

fn create_host_window(width: i32, height: i32) -> windows::core::Result<HWND> {
    unsafe extern "system" fn host_window_proc(
        window: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        unsafe { DefWindowProcW(window, message, wparam, lparam) }
    }
    unsafe {
        let instance = GetModuleHandleW(None)?;
        let class = w!("FaNotesWebView2Host");
        let description = WNDCLASSW {
            lpfnWndProc: Some(host_window_proc),
            hInstance: instance.into(),
            lpszClassName: class,
            ..Default::default()
        };
        // A second registration of the same class fails harmlessly.
        RegisterClassW(&description);
        let window = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class,
            w!("FaNotes"),
            WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            width,
            height,
            None,
            None,
            Some(instance.into()),
            None,
        )?;
        // WebView2 does not paint into a hidden host, so the capture would be
        // empty. The WebKitGTK path shows its window for the same reason.
        let _ = ShowWindow(window, SW_SHOWNOACTIVATE);
        Ok(window)
    }
}

/// Dispatch this thread's window messages until `receiver` has a value.
fn pump_until<T>(receiver: &mpsc::Receiver<T>, timeout: Duration) -> Option<T> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(value) = receiver.try_recv() {
            return Some(value);
        }
        if Instant::now() >= deadline {
            return None;
        }
        unsafe {
            let mut message = MSG::default();
            while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
