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

const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8")) as { version: string };

export default defineConfig({
  base: "./",
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  worker: { format: "es" },
  plugins: [devSave()],
  // Nur der Ordner tests: Prüfskripte in .testdata (eigene Bilder, lange Laufzeit) bleiben aussen vor
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
