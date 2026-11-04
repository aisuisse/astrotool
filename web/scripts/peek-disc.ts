// Zeigt die Sonnenrand-Anpassung für ein Bild: npx vite-node scripts/peek-disc.ts -- <bild.jpg> <ausgabe.png>
import { readFileSync, writeFileSync } from "node:fs";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { toLum, cropOrigin } from "../src/engine/image";
import { fitSunDisc } from "../src/engine/limb";
const [inp, out] = process.argv.slice(2).filter((a) => a !== "--");
const img = jpeg.decode(readFileSync(inp), { useTArray: true, maxMemoryUsageInMB: 2048 });
const data = new Uint8Array(img.width * img.height * 3);
for (let i = 0; i < img.width * img.height; i++) { data[i*3]=img.data[i*4]; data[i*3+1]=img.data[i*4+1]; data[i*3+2]=img.data[i*4+2]; }
const lum = toLum({ width: img.width, height: img.height, planes: 3, bitDepth: 8, colorId: 100, data });
const f = fitSunDisc(lum);
console.log(JSON.stringify({ cx: f.cx.toFixed(1), cy: f.cy.toFixed(1), r: f.r.toFixed(1), vis: f.visibleLimb.toFixed(2), rms: f.rms.toFixed(2) }));
const S = 900, [x0, y0] = cropOrigin(f.cx, f.cy, S, S, 100), p = new PNG({ width: S / 2, height: S / 2 });
for (let y = 0; y < S / 2; y++) for (let x = 0; x < S / 2; x++) {
  const sx = x0 + 2 * x, sy = y0 + 2 * y; const v = sx >= 0 && sy >= 0 && sx < img.width && sy < img.height ? lum.data[sy * img.width + sx] : 0;
  const o = (y * S / 2 + x) * 4; p.data[o] = p.data[o + 1] = p.data[o + 2] = Math.min(255, v * 255 * 1.0); p.data[o + 3] = 255;
  const d = Math.hypot(sx - f.cx, sy - f.cy); if (Math.abs(d - f.r) < 1.5) { p.data[o] = 0; p.data[o + 1] = 200; p.data[o + 2] = 255; }
}
writeFileSync(out, PNG.sync.write(p));
