// Typen für totality-model.mjs (Testdaten-Generator)
export interface Geometry { sx: number; sy: number; mx: number; my: number; R: number; Rm?: number }
export function rng(seed: number): () => number;
export interface Sky { sky?: number; skyGrad?: [number, number]; skyCurve?: number; skyTint?: [number, number, number] }
export function totalityRadiance(w: number, h: number, g: Geometry & Sky): Float32Array;
export function expose(rad: Float32Array, w: number, h: number, e: number, seed?: number): Uint8Array<ArrayBuffer>;
export function partialImage(w: number, h: number, g: Geometry, seed?: number): Uint8Array<ArrayBuffer>;
export function exifApp1(o: { date: string; subSec?: string; exposure: number; fNumber?: number; iso?: number; model?: string }): Uint8Array<ArrayBuffer>;
export function withExif(jpeg: Uint8Array | null, exif: Uint8Array): Uint8Array<ArrayBuffer>;
