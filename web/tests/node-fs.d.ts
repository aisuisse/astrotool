// Nur die Node-Funktionen, die Tests mit lokalen Testdateien brauchen (ohne @types/node)
declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function readdirSync(path: string): string[];
  export function openAsBlob(path: string): Promise<Blob>;
}
