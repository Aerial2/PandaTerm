/// Type declarations for file transfer features (directory upload support)

// Tauri-specific: File objects in Tauri have a `path` property that gives
// the absolute local filesystem path of the file.
interface File {
  /** Tauri extension: absolute local filesystem path (empty string in browsers) */
  path: string;
}

// FileSystem API types for webkitGetAsEntry (directory drag-and-drop support)
interface DataTransferItem {
  /** Returns a FileSystemEntry for the dragged item (file or directory). */
  webkitGetAsEntry(): FileSystemEntry | null;
}

interface FileSystemEntry {
  readonly name: string;
  readonly fullPath: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly filesystem: FileSystem;
}

interface FileSystemFileEntry extends FileSystemEntry {
  file(successCallback: (file: File) => void, errorCallback?: (error: DOMException) => void): void;
}

interface FileSystemDirectoryEntry extends FileSystemEntry {
  createReader(): FileSystemDirectoryReader;
}

interface FileSystemDirectoryReader {
  readEntries(
    successCallback: (entries: FileSystemEntry[]) => void,
    errorCallback?: (error: DOMException) => void
  ): void;
}

interface FileSystem {
  readonly name: string;
  readonly root: FileSystemDirectoryEntry;
}

// webkitRelativePath is available on File objects when selected via
// the webkitdirectory attribute on <input>
interface File {
  /** Relative path within the selected directory (e.g. "myFolder/sub/file.txt") */
  readonly webkitRelativePath: string;
}
