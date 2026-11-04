// Ziel für Ausgabedateien (SER, ZIP): entweder im Speicher (am Ende ein Blob zum Herunterladen) oder direkt auf
// die Festplatte, während verarbeitet wird – dann gibt es keine Grössengrenze durch den Arbeitsspeicher.
// write() hängt an, writeAt() überschreibt bereits Geschriebenes (z. B. die Bildzahl im SER-Kopf am Schluss).
// Der Aufrufer wartet nach jedem Bild auf drain(), damit sich nicht mehr ansammelt, als die Platte schreiben kann.

export interface ByteSink {
  /** bisher geschriebene Bytes (Position für das nächste write) */
  readonly size: number;
  write(data: Uint8Array): void;
  writeAt(position: number, data: Uint8Array): void;
  drain(): Promise<void>;
  /** abschliessen; im Speicher: der Blob, auf der Platte: null */
  close(type?: string): Promise<Blob | null>;
  /** verwerfen (Abbruch, Fehler): keine halbe Datei zurücklassen */
  abort(): Promise<void>;
}

/** Sammelt alles im Speicher. */
export class MemorySink implements ByteSink {
  private parts: Uint8Array[] = [];
  size = 0;

  write(data: Uint8Array): void {
    this.parts.push(data.slice());
    this.size += data.length;
  }

  writeAt(position: number, data: Uint8Array): void {
    if (position + data.length > this.size) throw new Error("writeAt beyond end");
    let off = 0;
    for (const p of this.parts) {
      const a = Math.max(position, off), b = Math.min(position + data.length, off + p.length);
      if (a < b) p.set(data.subarray(a - position, b - position), a - off);
      off += p.length;
      if (off >= position + data.length) break;
    }
  }

  async drain(): Promise<void> {}

  toBlob(type = "application/octet-stream"): Blob {
    return new Blob(this.parts as BlobPart[], { type });
  }

  async close(type?: string): Promise<Blob> {
    return this.toBlob(type);
  }

  async abort(): Promise<void> {
    this.parts = [];
  }
}

/** Das Nötige von FileSystemWritableFileStream (auch für Tests mit Node nachbildbar). */
export interface WritableFile {
  write(op: { type: "write"; position: number; data: Uint8Array }): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

/**
 * Schreibt gepuffert (16 MB) in eine Datei. Die Schreibaufträge laufen nacheinander im Hintergrund;
 * drain() wartet, bis höchstens ein Puffer unterwegs ist.
 */
export class FileSink implements ByteSink {
  size = 0;
  private buf: Uint8Array;
  private used = 0;
  private bufStart = 0;
  private chain: Promise<void> = Promise.resolve();
  /** noch nicht fertige Schreibaufträge, älteste zuerst */
  private pending: Promise<void>[] = [];
  private failed: unknown = null;

  constructor(private readonly file: WritableFile, private readonly bufferSize = 16 << 20) {
    this.buf = new Uint8Array(bufferSize);
  }

  private enqueue(position: number, data: Uint8Array): void {
    const job = this.chain.then(async () => {
      try {
        if (!this.failed) await this.file.write({ type: "write", position, data });
      } catch (e) {
        this.failed = e;
      }
    });
    this.chain = job;
    this.pending.push(job);
    void job.then(() => this.pending.splice(this.pending.indexOf(job), 1));
  }

  private flushBuffer(): void {
    if (!this.used) return;
    this.enqueue(this.bufStart, this.buf.slice(0, this.used));
    this.bufStart += this.used;
    this.used = 0;
  }

  write(data: Uint8Array): void {
    if (data.length >= this.bufferSize) {
      // grosse Blöcke (ganze Bilder) direkt schreiben, ohne Umweg über den Puffer
      this.flushBuffer();
      this.enqueue(this.bufStart, data.slice());
      this.bufStart += data.length;
    } else {
      if (this.used + data.length > this.bufferSize) this.flushBuffer();
      this.buf.set(data, this.used);
      this.used += data.length;
    }
    this.size += data.length;
  }

  writeAt(position: number, data: Uint8Array): void {
    if (position + data.length > this.size) throw new Error("writeAt beyond end");
    // noch im Puffer: dort ändern, sonst gezielt in die Datei
    const a = Math.max(position, this.bufStart), b = position + data.length;
    if (a < b) this.buf.set(data.subarray(a - position), a - this.bufStart);
    if (position < this.bufStart) this.enqueue(position, data.slice(0, Math.min(data.length, this.bufStart - position)));
  }

  async drain(): Promise<void> {
    // höchstens ein Auftrag darf noch laufen, während das nächste Bild entsteht
    while (this.pending.length > 1) await this.pending[0];
    if (this.failed) throw this.failed;
  }

  async close(): Promise<null> {
    this.flushBuffer();
    await this.chain;
    if (this.failed) {
      await this.file.abort().catch(() => {});
      throw this.failed;
    }
    await this.file.close();
    return null;
  }

  async abort(): Promise<void> {
    this.used = 0;
    await this.chain.catch(() => {});
    await this.file.abort().catch(() => {});
  }
}
