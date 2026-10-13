/** What one path names. */
export type PathKind = "file" | "directory" | "absent";

/** One entry of a directory. */
export interface DirectoryEntry {
  readonly name: string;
  readonly directory: boolean;
}

/**
 * The platform one run reads: the filesystem, the working directory and the analyzer's
 * installed version. A run may keep what it reads for the host's life, so a caller whose
 * tree changes passes a new host. It is a parameter, not an import, so a published module
 * carries no platform type surface into a consumer's compile and a caller can watch the
 * run's reads. The command line binds it to the platform; nothing under this module does.
 */
export interface Host {
  /** The directory a relative path resolves against. */
  workingDirectory(): string;
  /** The text of one file, or a throw naming why it cannot be read. */
  readFile(path: string): string;
  /** The entries of one directory, or a throw naming why it cannot be read. */
  readDirectory(path: string): readonly DirectoryEntry[];
  /** What one path names, `"absent"` where nothing is there. */
  kindOf(path: string): PathKind;
  /**
   * The path one path names once every symbolic link along it is followed, or a throw
   * naming why it cannot be: a package manager links an installed workspace package
   * into `node_modules`, and the link's target is what says which package it is.
   */
  realPath(path: string): string;
  /**
   * The version of the package this analyzer was installed from, or a throw
   * naming why it cannot be known. It is a method rather than a value because
   * locating that package is a filesystem walk, and a host that cannot do it
   * says so at the one moment the value is asked for.
   */
  analyzerVersion(): string;
  /**
   * Writes one document from its pieces, in order, or a throw naming why it cannot. The
   * pieces are written as they come, so the document is never held as one string. The
   * write is atomic: a reader of the path sees the previous document or this one and
   * never a part of it.
   */
  writeDocument(path: string, pieces: Iterable<string>): void;
  /**
   * A new empty directory of its own, outside every tree the run reads, or a throw naming
   * why it cannot be made. The run removes it before it ends.
   */
  temporaryDirectory(): TemporaryDirectory;
  /**
   * The command that runs this analyzer's mapper for component files, under the runtime
   * the analyzer itself runs under. The compiler starts it to read a component file.
   */
  componentMapperCommand(): readonly string[];
}

/** One directory a run made for itself. */
export interface TemporaryDirectory {
  readonly path: string;
  /** Removes the directory and everything in it; removing it twice removes it once. */
  remove(): void;
}
