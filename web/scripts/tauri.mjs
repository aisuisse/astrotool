// Startet die Tauri-CLI mit passender Umgebung (npm run app:dev / app:build).
//
// Windows: Ordner unter "Dokumente" tragen oft das Attribut "schreibgeschützt", das neue
// Unterordner erben. Einige Rust-Build-Skripte (autocfg) halten sie dann für nicht beschreibbar.
// Deshalb liegt das Build-Zwischenergebnis unter %LOCALAPPDATA%\astrotool-build.
//
// Pfade des Rechners (Benutzername!) sollen nicht in der .exe landen: Rust schreibt die Quellpfade der
// Bibliotheken in Fehlermeldungen. --remap-path-prefix ersetzt sie durch neutrale Platzhalter.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const env = { ...process.env };
if (process.platform === "win32") {
  if (!env.CARGO_TARGET_DIR) env.CARGO_TARGET_DIR = join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "astrotool-build");
  // Direkt nach der Rust-Installation fehlt cargo noch im PATH dieses Terminals
  const cargoBin = join(homedir(), ".cargo", "bin");
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  if (!(env[pathKey] ?? "").toLowerCase().includes(cargoBin.toLowerCase())) env[pathKey] = `${cargoBin};${env[pathKey] ?? ""}`;
}

{
  const cargoHome = env.CARGO_HOME ?? join(homedir(), ".cargo");
  const rustupHome = env.RUSTUP_HOME ?? join(homedir(), ".rustup");
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  // bei mehreren Treffern gilt die letzte Angabe – darum das Allgemeine (Benutzerordner) zuerst
  const remap = [[homedir(), "/home"], [cargoHome, "/cargo"], [rustupHome, "/rustup"], [repo, "/astrotool"]];
  if (env.CARGO_TARGET_DIR) remap.push([env.CARGO_TARGET_DIR, "/target"]);
  // CARGO_ENCODED_RUSTFLAGS: Trennzeichen 0x1f, damit auch Pfade mit Leerzeichen gehen
  const flags = remap.map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
  const old = env.CARGO_ENCODED_RUSTFLAGS ?? (env.RUSTFLAGS ? env.RUSTFLAGS.split(" ").filter(Boolean).join("\x1f") : "");
  env.CARGO_ENCODED_RUSTFLAGS = [old, ...flags].filter(Boolean).join("\x1f");
  delete env.RUSTFLAGS;
}

const child = spawn("npx", ["tauri", ...process.argv.slice(2)], { stdio: "inherit", env, shell: true });
child.on("exit", (code) => process.exit(code ?? 1));
