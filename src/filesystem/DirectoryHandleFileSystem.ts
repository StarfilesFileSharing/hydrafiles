interface FileHandle extends FileSystemFileHandle {
  remove(): Promise<void>; // Returns a Promise that resolves when the file is removed.
}

interface DirectoryHandle extends FileSystemDirectoryHandle {
  values(): IterableIterator<FileSystemHandle>; // Returns an iterator of FileSystemHandle objects for the directory's contents.
  getDirectoryHandle(path: string, options: { create: boolean }): Promise<DirectoryHandle>; // Returns a Promise that resolves to a DirectoryHandle for the specified path, creating it if specified.
  getFileHandle(path: string, opts?: { create: boolean }): Promise<FileHandle>; // Returns a Promise that resolves to a FileHandle for the specified file path.
}

declare global {
  interface Window {
    showDirectoryPicker: () => Promise<DirectoryHandle>;
    handle?: DirectoryHandle;
  }
}

async function getFileHandle(directoryHandle: DirectoryHandle, path: string, touch = false): Promise<FileHandle> {
  const parts = path.split("/");
  let currentHandle = directoryHandle;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    if (i === parts.length - 1) return await currentHandle.getFileHandle(part, { create: touch });
    else currentHandle = await currentHandle.getDirectoryHandle(part, { create: true });
  }

  throw new Error("Unreachable code reached");
}

export default class DirectoryHandleFileSystem {
  static directoryHandle = async () => {
    if ("handle" in globalThis.window && typeof globalThis.window.handle !== "undefined") return globalThis.window.handle;
    const handle = await globalThis.window.showDirectoryPicker();
    globalThis.window.handle = handle;
    return handle;
  };

  static exists = async (path: string): Promise<boolean> => {
    try {
      await getFileHandle(await this.directoryHandle(), path);
      return true;
    } catch (e) {
      const error = e as Error;
      if (error.name === "TypeMismatchError") return true;
      else if (error.name === "NotFoundError") return false;
      throw error;
    }
  };

  static mkdir = async (path: string) => {
    if (await this.exists(path)) return;
    await (await this.directoryHandle()).getDirectoryHandle(path, { create: true });
  };

  static readDir = async (path: string): Promise<string[]> => {
    const entries: string[] = [];
    const dirHandle = await (await this.directoryHandle()).getDirectoryHandle(path, { create: false });
    for await (const entry of dirHandle.values()) {
      entries.push(entry.name);
    }
    return entries;
  };

  static readFile = async (path: string): Promise<Uint8Array> => {
    if (!await this.exists(path)) throw new Error(`${path} File doesn't exist`);
    const fileHandle = await getFileHandle(await this.directoryHandle(), path);
    const file = await fileHandle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  };

  static writeFile = async (path: string, data: Uint8Array): Promise<void> => {
    const fileHandle = await getFileHandle(await this.directoryHandle(), path, true);
    const writable = await fileHandle.createWritable();
    await writable.write(data);
    await writable.close();
  };

  static getFileSize = async (path: string): Promise<number> => {
    const fileHandle = await getFileHandle(await this.directoryHandle(), path);
    const file = await fileHandle.getFile();
    return file.size;
  };

  static remove = async (path: string) => {
    const fileHandle = await getFileHandle(await this.directoryHandle(), path);
    await fileHandle.remove();
  };
}
