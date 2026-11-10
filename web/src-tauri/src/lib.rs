// Astrotool – Desktop-App (Tauri 2): Windows, experimentell auch macOS und Linux.
// Die Oberfläche ist dieselbe Web-App wie im Browser. Nativ kommen nur hinzu:
//  - tools_status: prüft, welche Hilfsprogramme installiert sind
//  - install_tool: installiert ein Hilfsprogramm per winget – nur aus einer festen Liste, nur unter Windows
//  - hevc_*: H.265/HEVC-Kodierung über das lokale FFmpeg (WebView2 kann kein HEVC)

mod hevc;

use serde::Serialize;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Erlaubte Programme: (winget-ID, Befehl zum Prüfen)
const TOOLS: &[(&str, &str)] = &[
    ("Gyan.FFmpeg", "ffmpeg"),
    ("OpenJS.NodeJS.LTS", "node"),
    ("Git.Git", "git"),
];

pub(crate) fn command(program: &str) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

/// Sucht ein Programm im PATH und in den üblichen Ablagen (winget, Homebrew).
pub(crate) fn find_program(name: &str) -> Option<String> {
    let finder = if cfg!(windows) { "where" } else { "which" };
    if let Ok(out) = command(finder).arg(name).output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Some(l) = s.lines().next() {
                return Some(l.trim().to_string());
            }
        }
    }
    // macOS/Linux: Aus dem Finder gestartete Apps haben einen kurzen PATH (ohne Homebrew).
    if !cfg!(windows) {
        for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
            let p = std::path::Path::new(dir).join(name);
            if p.exists() {
                return Some(p.to_string_lossy().into_owned());
            }
        }
    }
    // Direkt nach einer winget-Installation ist der PATH dieses Prozesses noch alt.
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let links = std::path::Path::new(&local).join("Microsoft").join("WinGet").join("Links").join(format!("{name}.exe"));
        if links.exists() {
            return Some(links.to_string_lossy().into_owned());
        }
    }
    None
}

#[derive(Serialize)]
struct ToolStatus {
    id: String,
    command: String,
    installed: bool,
    path: Option<String>,
    /// Kann die App das Programm selbst installieren? (nur Windows, per winget)
    #[serde(rename = "canInstall")]
    can_install: bool,
}

#[tauri::command]
fn tools_status() -> Vec<ToolStatus> {
    TOOLS
        .iter()
        .map(|(id, cmd)| {
            let path = find_program(cmd);
            ToolStatus { id: id.to_string(), command: cmd.to_string(), installed: path.is_some(), path, can_install: cfg!(windows) }
        })
        .collect()
}

#[derive(Serialize)]
struct InstallResult {
    ok: bool,
    output: String,
}

/// Installiert ein Programm per winget. Nur IDs aus TOOLS sind erlaubt.
#[tauri::command]
async fn install_tool(id: String) -> Result<InstallResult, String> {
    if !TOOLS.iter().any(|(t, _)| *t == id) {
        return Err(format!("not allowed: {id}"));
    }
    if !cfg!(windows) {
        return Err("winget is only available on Windows".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let out = command("winget")
            .args([
                "install", "--id", &id, "--exact", "--source", "winget",
                "--accept-source-agreements", "--accept-package-agreements", "--disable-interactivity",
            ])
            .output()
            .map_err(|e| format!("winget: {e}"))?;
        let mut output = String::from_utf8_lossy(&out.stdout).into_owned();
        output.push_str(&String::from_utf8_lossy(&out.stderr));
        // winget meldet "bereits installiert" mit eigenem Code – das zählt als Erfolg
        let already = output.contains("already installed") || output.contains("bereits installiert");
        Ok(InstallResult { ok: out.status.success() || already, output: output.trim().to_string() })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(hevc::HevcState::default())
        .invoke_handler(tauri::generate_handler![tools_status, install_tool, hevc::hevc_begin, hevc::hevc_frame, hevc::hevc_finish])
        .run(tauri::generate_context!())
        .expect("error while running Astrotool");
}
