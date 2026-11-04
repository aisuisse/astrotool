// Zuletzt geöffnete Dateien: Datei-Handles (File System Access) in IndexedDB – so lassen sich Dateien später ohne
// Suchen wieder öffnen. Nur wo der Browser bzw. die Windows-App showOpenFilePicker kennt (Chrome, Edge, WebView2).
// Ein Eintrag ist eine Aufnahme: eine SER/ein Video oder eine ganze Bildserie.

type Handle = FileSystemFileHandle & {
  queryPermission?(o: { mode: "read" }): Promise<PermissionState>;
  requestPermission?(o: { mode: "read" }): Promise<PermissionState>;
};

export interface RecentEntry {
  id?: number;
  /** Anzeige: Dateiname bzw. erste – letzte Datei der Serie */
  label: string;
  count: number;
  time: number;
  handles: Handle[];
}

const DB_NAME = "astrotool", STORE = "recent", MAX = 8;

export const recentSupported = typeof window !== "undefined" && "showOpenFilePicker" in window && "indexedDB" in window;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** Neueste zuerst */
export async function recentList(): Promise<RecentEntry[]> {
  if (!recentSupported) return [];
  try {
    const all = await tx<RecentEntry[]>("readonly", (s) => s.getAll() as IDBRequest<RecentEntry[]>);
    return all.sort((a, b) => b.time - a.time);
  } catch {
    return [];
  }
}

function labelOf(handles: Handle[]): string {
  const names = handles.map((h) => h.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return names.length === 1 ? names[0] : `${names[0]} – ${names[names.length - 1]}`;
}

/** Aufnahme merken (gleiche Dateien rücken nach oben); höchstens MAX Einträge */
export async function rememberRecent(handles: Handle[]): Promise<void> {
  if (!recentSupported || !handles.length) return;
  try {
    const list = await recentList();
    for (const e of list) {
      const same = e.count === handles.length && e.label === labelOf(handles) && (await e.handles[0].isSameEntry(handles[0]).catch(() => false));
      if (same) await tx("readwrite", (s) => s.delete(e.id!));
    }
    await tx("readwrite", (s) => s.add({ label: labelOf(handles), count: handles.length, time: Date.now(), handles }));
    const rest = (await recentList()).slice(MAX);
    for (const e of rest) await tx("readwrite", (s) => s.delete(e.id!));
  } catch {
    /* Merken ist eine Bequemlichkeit – Fehler stören das Öffnen nicht */
  }
}

export async function forgetRecent(id: number): Promise<void> {
  await tx("readwrite", (s) => s.delete(id)).catch(() => undefined);
}

/**
 * Dateien eines Eintrags lesen. Nach einem Neustart fragt der Browser einmal nach der Leseerlaubnis (muss in einem
 * Klick-Ereignis aufgerufen werden). Fehlt eine Datei, gibt es einen Fehler.
 */
export async function filesOf(e: RecentEntry): Promise<File[]> {
  const files: File[] = [];
  for (const h of e.handles) {
    if (h.queryPermission && (await h.queryPermission({ mode: "read" })) !== "granted" && h.requestPermission) {
      if ((await h.requestPermission({ mode: "read" })) !== "granted") throw new Error("permission");
    }
    files.push(await h.getFile());
  }
  return files;
}
