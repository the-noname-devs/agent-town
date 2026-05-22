import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileWatcher, type FileEvent } from "../file-watcher.js";

describe("FileWatcher", () => {
  let watcher: FileWatcher;

  afterEach(() => {
    watcher?.stop();
  });

  it("should detect file creation", async () => {
    const testDir = join(tmpdir(), `ab-test-create-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    watcher = new FileWatcher(testDir);

    const eventPromise = new Promise<FileEvent>((resolve) => {
      watcher.on("file", resolve);
    });

    watcher.start([testDir]);
    await new Promise((r) => setTimeout(r, 500));

    writeFileSync(join(testDir, "new-file.txt"), "hello");

    const event = await eventPromise;
    expect(event.path).toBe("new-file.txt");
    expect(event.action).toBe("write");
  });

  it("should detect file changes", async () => {
    const testDir = join(tmpdir(), `ab-test-change-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    const testFile = join(testDir, "change-test.txt");
    writeFileSync(testFile, "initial");

    watcher = new FileWatcher(testDir);

    const eventPromise = new Promise<FileEvent>((resolve) => {
      watcher.on("file", resolve);
    });

    watcher.start([testDir]);
    await new Promise((r) => setTimeout(r, 500));

    writeFileSync(testFile, "changed");

    const event = await eventPromise;
    expect(event.path).toBe("change-test.txt");
    expect(event.action).toBe("edit");
  });

  it("should detect file deletion", async () => {
    const testDir = join(tmpdir(), `ab-test-delete-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    const testFile = join(testDir, "delete-test.txt");
    writeFileSync(testFile, "will be deleted");

    watcher = new FileWatcher(testDir);

    const eventPromise = new Promise<FileEvent>((resolve) => {
      watcher.on("file", (evt) => {
        if (evt.action === "delete") resolve(evt);
      });
    });

    watcher.start([testDir]);
    await new Promise((r) => setTimeout(r, 500));

    unlinkSync(testFile);

    const event = await eventPromise;
    expect(event.path).toBe("delete-test.txt");
    expect(event.action).toBe("delete");
  });
});
