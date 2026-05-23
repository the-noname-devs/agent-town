import { watch, type FSWatcher } from "chokidar";
import { EventEmitter } from "node:events";
import { relative } from "node:path";

export interface FileEvent {
  path: string;
  action: "edit" | "write" | "delete";
}

export class FileWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private basePath: string;

  constructor(basePath: string) {
    super();
    this.basePath = basePath;
  }

  start(watchPaths?: string[]): void {
    const paths = watchPaths ?? [this.basePath];

    this.watcher = watch(paths, {
      ignored: [
        "**/node_modules/**",
        "**/.git/**",
        "**/dist/**",
        "**/.next/**",
        "**/.turbo/**",
        "**/.pnpm-store/**",
        "**/build/**",
        "**/.cache/**",
      ],
      persistent: true,
      ignoreInitial: true,
      depth: 15,
    });

    this.watcher.on("error", (error) => {
      // Silently handle EMFILE — file watching is best-effort
      if ((error as NodeJS.ErrnoException).code !== "EMFILE") {
        console.error("FileWatcher error:", error);
      }
    });

    this.watcher.on("change", (filePath) => {
      this.emit("file", {
        path: relative(this.basePath, filePath as string),
        action: "edit",
      } satisfies FileEvent);
    });

    this.watcher.on("add", (filePath) => {
      this.emit("file", {
        path: relative(this.basePath, filePath as string),
        action: "write",
      } satisfies FileEvent);
    });

    this.watcher.on("unlink", (filePath) => {
      this.emit("file", {
        path: relative(this.basePath, filePath as string),
        action: "delete",
      } satisfies FileEvent);
    });
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}
