// Menü "Tools & Setup": System-Check des Browsers und Installation der lokalen Hilfsprogramme.
// Eine Webseite darf nichts installieren – sie zeigt die Befehle und bietet ein Setup-Skript an.
// In der späteren Windows-App (Tauri) führt derselbe Dialog die Installation direkt aus.
import { t, type I18nKey, type Lang } from "./i18n";

interface Check {
  key: I18nKey;
  ok: boolean;
  hint: I18nKey;
}

interface LocalTool {
  name: string;
  purpose: I18nKey;
  need: "optional" | "dev";
  winget?: string;
  link: string;
}

const LOCAL_TOOLS: LocalTool[] = [
  { name: "FFmpeg", purpose: "tools.ffmpeg", need: "optional", winget: "Gyan.FFmpeg", link: "https://ffmpeg.org/download.html" },
  { name: "SER Player", purpose: "tools.serplayer", need: "optional", link: "https://github.com/cgarry/ser-player/releases" },
  { name: "Node.js LTS", purpose: "tools.node", need: "dev", winget: "OpenJS.NodeJS.LTS", link: "https://nodejs.org/" },
  { name: "Git", purpose: "tools.git", need: "dev", winget: "Git.Git", link: "https://git-scm.com/" },
];

async function encodeSupported(codec: string, hardware: HardwareAcceleration = "no-preference"): Promise<boolean> {
  if (typeof VideoEncoder === "undefined") return false;
  try {
    const r = await VideoEncoder.isConfigSupported({ codec, width: 1080, height: 1080, bitrate: 4_000_000, framerate: 30, hardwareAcceleration: hardware });
    return !!r.supported;
  } catch {
    return false;
  }
}

async function runChecks(): Promise<Check[]> {
  const hevc = (await encodeSupported("hvc1.1.6.L120.B0", "prefer-hardware")) || (await encodeSupported("hvc1.1.6.L120.B0"));
  return [
    { key: "tools.chk.worker", ok: typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined", hint: "tools.hint.browser" },
    { key: "tools.chk.webcodecs", ok: typeof VideoEncoder !== "undefined", hint: "tools.hint.browser" },
    { key: "tools.chk.hevc", ok: hevc, hint: "tools.hint.hevc" },
    { key: "tools.chk.h264", ok: await encodeSupported("avc1.640028"), hint: "tools.hint.browser" },
    { key: "tools.chk.folder", ok: "showDirectoryPicker" in window, hint: "tools.hint.folder" },
  ];
}

/** Läuft Astrotool als Windows-App (Tauri)? Dann kann das Menü wirklich installieren. */
export const isDesktopApp = () => "__TAURI_INTERNALS__" in window;

interface NativeStatus { id: string; command: string; installed: boolean; path: string | null; canInstall?: boolean }

async function nativeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function initTools(getLang: () => Lang) {
  const dialog = document.getElementById("toolsDialog") as HTMLDialogElement;
  const body = document.getElementById("toolsBody")!;
  let checks: Check[] | null = null;
  const app = isDesktopApp();
  let native: NativeStatus[] | null = null;
  const installing = new Set<string>();
  const installLog = new Map<string, { ok: boolean; output: string }>();
  const loadNative = async () => {
    if (app) native = await nativeInvoke<NativeStatus[]>("tools_status").catch(() => null);
  };

  const render = () => {
    const lang = getLang();
    const L = (k: I18nKey, ...a: (string | number)[]) => t(lang, k, ...a);
    const checkRows = checks
      ? checks.map((c) => `<li class="${c.ok ? "ok" : "bad"}"><span>${c.ok ? "✓" : "✗"}</span><div><strong>${esc(L(c.key))}</strong>${c.ok ? "" : `<small>${esc(L(c.hint))}</small>`}</div></li>`).join("")
      : `<li><small>${esc(L("tools.checking"))}</small></li>`;
    // Desktop-App auf macOS oder Linux: Dort kann die App nichts installieren
    const other = app && !!native?.length && native.every((n) => n.canInstall === false);
    const toolRows = LOCAL_TOOLS.map((tool) => {
      const cmd = tool.winget ? `winget install --id ${tool.winget} -e` : "";
      const st = native?.find((n) => n.id === tool.winget);
      const log = tool.winget ? installLog.get(tool.winget) : undefined;
      let action: string;
      if (app && st && (st.installed || st.canInstall !== false)) {
        action = st.installed
          ? `<span class="okText">✓ ${esc(L("tools.installed"))}</span>${st.path ? `<br><small class="tag">${esc(st.path)}</small>` : ""}`
          : installing.has(st.id)
            ? `<span>${esc(L("tools.installing"))}</span>`
            : `<button class="btn primary tiny" data-install="${esc(st.id)}">${esc(L("tools.install"))}</button>`;
        if (log && !log.ok) action += `<details><summary class="error">${esc(L("tools.installFailed"))}</summary><pre>${esc(log.output.slice(-1500))}</pre></details>`;
      } else if (other) {
        // macOS/Linux: kein winget – auf die Download-Seite verweisen
        action = `<a href="${tool.link}" target="_blank" rel="noopener">${esc(L("tools.download"))}</a>`;
      } else {
        action = cmd ? `<code>${esc(cmd)}</code> <button class="btn tiny" data-copy="${esc(cmd)}">${esc(L("tools.copy"))}</button>` : `<a href="${tool.link}" target="_blank" rel="noopener">${esc(L("tools.download"))}</a>`;
      }
      return `<tr>
        <td><a href="${tool.link}" target="_blank" rel="noopener">${esc(tool.name)}</a><br><small class="tag">${esc(L(tool.need === "dev" ? "tools.needDev" : "tools.needOptional"))}</small></td>
        <td><small>${esc(L(tool.purpose))}</small></td>
        <td>${action}</td>
      </tr>`;
    }).join("");
    const runCmd = "powershell -ExecutionPolicy Bypass -File .\\setup-windows.ps1";
    body.innerHTML = `
      <p>${esc(L(other ? "tools.introAppOther" : app ? "tools.introApp" : "tools.intro"))}</p>
      <h3>${esc(L("tools.browserTitle"))}</h3>
      <ul class="checks">${checkRows}</ul>
      <h3>${esc(L("tools.localTitle"))}</h3>
      <p><small>${esc(L(other ? "tools.localIntroOther" : app ? "tools.localIntroApp" : "tools.localIntro"))}</small></p>
      <div class="tablewrap"><table class="tools"><tbody>${toolRows}</tbody></table></div>
      ${app ? "" : `<h3>${esc(L("tools.scriptTitle"))}</h3>
      <p><small>${esc(L("tools.scriptIntro"))}</small></p>
      <p><a class="btn primary" href="./setup-windows.ps1" download="setup-windows.ps1">${esc(L("tools.scriptDownload"))}</a></p>
      <p><small>${esc(L("tools.scriptRun"))}</small><br><code>${esc(runCmd)}</code> <button class="btn tiny" data-copy="${esc(runCmd)}">${esc(L("tools.copy"))}</button><br>
      <small>${esc(L("tools.scriptDev"))}</small> <code>-Dev</code></p>`}`;
  };

  body.addEventListener("click", async (e) => {
    const inst = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-install]");
    if (inst) {
      const id = inst.dataset.install!;
      installing.add(id);
      render();
      try {
        const r = await nativeInvoke<{ ok: boolean; output: string }>("install_tool", { id });
        installLog.set(id, r);
      } catch (err) {
        installLog.set(id, { ok: false, output: String(err) });
      }
      installing.delete(id);
      await loadNative();
      render();
      return;
    }
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-copy]");
    if (!btn) return;
    try {
      await navigator.clipboard.writeText(btn.dataset.copy!);
      btn.textContent = t(getLang(), "tools.copied");
    } catch { /* Zwischenablage nicht erlaubt – Text bleibt markierbar */ }
  });

  document.getElementById("toolsBtn")!.addEventListener("click", async () => {
    render();
    dialog.showModal();
    if (!checks) {
      checks = await runChecks();
      await loadNative();
      render();
    }
  });
  document.getElementById("toolsClose")!.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close(); // Klick auf den Hintergrund
  });

  return {
    refresh() {
      if (dialog.open) render();
    },
  };
}
