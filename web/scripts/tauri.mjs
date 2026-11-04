// Startet die Tauri-CLI mit passender Umgebung (npm run app:dev / app:build).
//
// Windows: Ordner unter "Dokumente" tragen oft das Attribut "schreibgeschützt", das neue
// Unterordner erben. Einige Rust-Build-Skripte (autocfg) halten sie dann für nicht beschreibbar.
// Deshalb liegt das Build-Zwischenergebnis unter %LOCALAPPDATA%\astrotool-build.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const env = { ...process.env };
if (process.platform === "win32") {
  if (!env.CARGO_TARGET_DIR) env.CARGO_TARGET_DIR = join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "astrotool-build");
  // Direkt nach der Rust-Installation fehlt cargo noch im PATH dieses Terminals
  const cargoBin = join(homedir(), ".cargo", "bin");
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  if (!(env[pathKey] ?? "").toLowerCase().includes(cargoBin.toLowerCase())) env[pathKey] = `${cargoBin};${env[pathKey] ?? ""}`;
}

const child = spawn("npx", ["tauri", ...process.argv.slice(2)], { stdio: "inherit", env, shell: true });
child.on("exit", (code) => process.exit(code ?? 1));
