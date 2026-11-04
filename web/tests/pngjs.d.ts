// Nur was der PNG-Test von pngjs und Node braucht (ohne @types/node, @types/pngjs)
declare module "pngjs" {
  export const PNG: { sync: { read(data: Uint8Array, options?: { skipRescale?: boolean }): { width: number; height: number; data: Uint8Array | Uint16Array } } };
}
declare const Buffer: { from(data: Uint8Array): Uint8Array };
