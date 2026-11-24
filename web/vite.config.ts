import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { defineConfig, type Plugin } from "vite";

/**
 * Nur im Entwicklungsserver: POST /__dev-save?name=datei.mp4 schreibt nach web/.testdata/exports/.
 * Damit lassen sich Testergebnisse aus dem Browser automatisch ablegen. Im fertigen Build nicht enthalten.
 */
function devSave(): Plugin {
  return {
    name: "astrotool-dev-save",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__dev-save", (req, res) => {
        const host = req.headers.host ?? "";
        if (req.method !== "POST" || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
          res.statusCode = 403;
          res.end();
          return;
        }
        const name = basename(new URL(req.url ?? "", "http://x").searchParams.get("name") ?? "export.bin").replace(/[^\w.-]/g, "_");
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const dir = join(__dirname, ".testdata", "exports");
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, name), Buffer.concat(chunks));
          res.end(JSON.stringify({ saved: join(dir, name) }));
        });
      });
    },
  };
}

/**
 * Web-Version ohne Internet: schreibt beim Bauen sw.js mit der Liste aller Dateien der App. Der Service Worker legt
 * sie beim ersten Besuch im Browser ab und liefert sie danach von dort – am Beobachtungsort gibt es oft kein Netz.
 * Die Kennung ändert sich mit jedem geänderten Build; der Browser holt dann die neue Fassung und räumt die alte weg.
 * In der Desktop-App wird sw.js nicht benutzt (siehe main.ts).
 */
function offline(version: string): Plugin {
  return {
    name: "astrotool-offline",
    apply: "build",
    generateBundle(_options, bundle) {
      const built = Object.keys(bundle).filter((f) => f !== "index.html" && f !== "sw.js" && !f.endsWith(".map")).sort();
      const files = ["./", ...built.map((f) => `./${f}`), "./manifest.webmanifest", "./icon-32.png", "./icon-192.png", "./icon-256.png", "./icon-512.png"];
      const id = createHash("sha256").update(version).update(files.join("|")).update(readFileSync(join(__dirname, "index.html"))).digest("hex").slice(0, 12);
      const source = `// Astrotool ${version} – erzeugt beim Bauen (vite.config.ts), nicht von Hand ändern
const CACHE = "astrotool-${id}";
const FILES = ${JSON.stringify(files)};
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("astrotool-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  // erst der Vorrat (die Seite selbst auch mit Zusätzen wie ?v=1), sonst das Netz. ignoreVary: der Server
  // antwortet mit "Vary" (Origin, Accept-Encoding) – ohne das fände der Vorrat Skript und Stil der Seite nicht wieder.
  e.respondWith(
    caches.open(CACHE).then((c) => c.match(e.request, { ignoreSearch: e.request.mode === "navigate", ignoreVary: true })).then((hit) => hit ?? fetch(e.request)),
  );
});
`;
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8")) as { version: string };

export default defineConfig({
  base: "./",
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  worker: { format: "es" },
  plugins: [devSave(), offline(pkg.version)],
  // Nur der Ordner tests: Prüfskripte in .testdata (eigene Bilder, lange Laufzeit) bleiben aussen vor
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
