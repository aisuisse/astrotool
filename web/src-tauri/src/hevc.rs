// H.265/HEVC-Kodierung über das lokale FFmpeg.
// WebView2 kann (anders als Chrome) kein HEVC kodieren. Die App rendert die Zeitraffer-Bilder wie
// gewohnt und reicht sie hier roh (RGBA) an FFmpeg weiter; heraus kommt ein MP4 zum Teilen.
//
// Ablauf aus der Oberfläche: hevc_begin → hevc_frame (je Bild, mit Wiederholungszahl) → hevc_finish.

use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};

use crate::{command, find_program};

/// Kandidaten in Reihenfolge der Bevorzugung, mit Qualitätseinstellungen für "sehr gut, trotzdem kompakt".
fn encoder_args(name: &str) -> Vec<&'static str> {
    match name {
        "libx265" => vec!["-c:v", "libx265", "-preset", "medium", "-crf", "21", "-x265-params", "log-level=error"],
        "hevc_amf" => vec!["-c:v", "hevc_amf", "-quality", "quality", "-rc", "cqp", "-qp_i", "20", "-qp_p", "22"],
        "hevc_nvenc" => vec!["-c:v", "hevc_nvenc", "-preset", "p6", "-rc", "vbr", "-cq", "22"],
        "hevc_qsv" => vec!["-c:v", "hevc_qsv", "-global_quality", "22"],
        "hevc_videotoolbox" => vec!["-c:v", "hevc_videotoolbox", "-b:v", "8M"],
        _ => vec!["-c:v", "hevc_mf", "-b:v", "8M"],
    }
}
const CANDIDATES: &[&str] = &["libx265", "hevc_videotoolbox", "hevc_amf", "hevc_nvenc", "hevc_qsv", "hevc_mf"];

/// Erstes Encoder, das auf diesem Rechner wirklich funktioniert (einmal ermittelt).
fn working_encoder(ffmpeg: &str) -> Option<&'static str> {
    static FOUND: OnceLock<Option<&'static str>> = OnceLock::new();
    *FOUND.get_or_init(|| {
        CANDIDATES.iter().copied().find(|enc| {
            let mut args = vec!["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=256x256:d=0.2"];
            args.extend(encoder_args(enc));
            args.extend(["-f", "null", "-"]);
            command(ffmpeg).args(&args).stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
        })
    })
}

struct Session {
    child: Child,
    stdin: Option<ChildStdin>,
    output: PathBuf,
    log: PathBuf,
    frame_bytes: usize,
}

#[derive(Default, Clone)]
pub struct HevcState(Arc<Mutex<Option<Session>>>);

#[derive(Serialize)]
pub struct BeginResult {
    encoder: String,
}

fn temp_path(ext: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    std::env::temp_dir().join(format!("astrotool-{}-{stamp}.{ext}", std::process::id()))
}

#[tauri::command]
pub async fn hevc_begin(
    state: tauri::State<'_, HevcState>,
    width: u32,
    height: u32,
    fps: u32,
    title: Option<String>,
    date: Option<String>,
) -> Result<BeginResult, String> {
    if width == 0 || height == 0 || width % 2 != 0 || height % 2 != 0 || width > 8192 || height > 8192 {
        return Err(format!("invalid size {width}x{height}"));
    }
    let fps = fps.clamp(1, 120);
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ffmpeg = find_program("ffmpeg").ok_or("ffmpeg not found")?;
        let enc = working_encoder(&ffmpeg).ok_or("no working HEVC encoder in ffmpeg")?;
        let output = temp_path("mp4");
        let log = temp_path("log");
        let size = format!("{width}x{height}");
        let rate = fps.to_string();
        let mut args: Vec<String> = ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", &size, "-r", &rate, "-i", "-"]
            .iter().map(|s| s.to_string()).collect();
        args.extend(encoder_args(enc).iter().map(|s| s.to_string()));
        args.extend(["-pix_fmt", "yuv420p", "-tag:v", "hvc1", "-movflags", "+faststart", "-an", "-r", &rate].iter().map(|s| s.to_string()));
        if let Some(t) = title.filter(|t| !t.is_empty()) {
            args.push("-metadata".into());
            args.push(format!("title={t}"));
        }
        if let Some(d) = date.filter(|d| !d.is_empty()) {
            args.push("-metadata".into());
            args.push(format!("creation_time={d}"));
        }
        args.push(output.to_string_lossy().into_owned());

        let mut child = command(&ffmpeg)
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::from(File::create(&log).map_err(|e| e.to_string())?))
            .spawn()
            .map_err(|e| format!("ffmpeg: {e}"))?;
        let stdin = child.stdin.take();
        let mut guard = st.0.lock().map_err(|e| e.to_string())?;
        if let Some(mut old) = guard.take() {
            let _ = old.child.kill();
        }
        *guard = Some(Session { child, stdin, output, log, frame_bytes: (width * height * 4) as usize });
        Ok(BeginResult { encoder: enc.to_string() })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Ein Bild (RGBA, roh im Body); Header "repeat" = wie oft es hintereinander gezeigt wird.
#[tauri::command]
pub async fn hevc_frame(state: tauri::State<'_, HevcState>, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else { return Err("expected raw frame data".into()) };
    let bytes = bytes.clone();
    let repeat: usize = request.headers().get("repeat").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).unwrap_or(1).clamp(1, 10_000);
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = st.0.lock().map_err(|e| e.to_string())?;
        let s = guard.as_mut().ok_or("no encoding session")?;
        if bytes.len() != s.frame_bytes {
            return Err(format!("frame has {} bytes, expected {}", bytes.len(), s.frame_bytes));
        }
        let stdin = s.stdin.as_mut().ok_or("encoder input closed")?;
        for _ in 0..repeat {
            stdin.write_all(&bytes).map_err(|e| format!("ffmpeg stopped: {e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Beendet die Kodierung und liefert die fertige MP4-Datei als Bytes.
#[tauri::command]
pub async fn hevc_finish(state: tauri::State<'_, HevcState>) -> Result<Response, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = st.0.lock().map_err(|e| e.to_string())?.take().ok_or("no encoding session")?;
        drop(s.stdin.take()); // Ende der Eingabe signalisieren
        let status = s.child.wait().map_err(|e| e.to_string())?;
        let result = if status.success() {
            std::fs::read(&s.output).map(Response::new).map_err(|e| e.to_string())
        } else {
            let log = std::fs::read_to_string(&s.log).unwrap_or_default();
            Err(format!("ffmpeg failed: {}", log.lines().rev().take(5).collect::<Vec<_>>().join(" | ")))
        };
        let _ = std::fs::remove_file(&s.output);
        let _ = std::fs::remove_file(&s.log);
        result
    })
    .await
    .map_err(|e| e.to_string())?
}
