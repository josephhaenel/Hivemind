/**
 * Tiny dependency-free JSON file persistence with debounced, atomic writes.
 * Good enough for the MVP's low-frequency durable state (decisions + identity);
 * swap for SQLite later if write volume grows.
 */
import fs from "node:fs";
import path from "node:path";

export class JsonFilePersistence {
  private timer: NodeJS.Timeout | null = null;
  private pending: unknown = null;

  constructor(private readonly filePath: string, private readonly debounceMs = 250) {}

  load<T>(): T | null {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, "utf8")) as T;
    } catch {
      return null;
    }
  }

  scheduleSave(data: unknown): void {
    this.pending = data;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending === null) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.pending));
    fs.renameSync(tmp, this.filePath); // atomic replace (Node maps to MoveFileEx on Windows)
    this.pending = null;
  }
}
