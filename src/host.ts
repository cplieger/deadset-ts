/** What one path names. */
export type PathKind = "file" | "directory" | "absent";

/** One entry of a directory. */
export interface DirectoryEntry {
  readonly name: string;
  readonly directory: boolean;
}

/**
 * The filesystem the analysis reads, and the directory it reads relative paths
 * against.
 *
 * It is a parameter rather than an import because a published module that reads
 * the filesystem directly carries the whole platform's type surface into every
 * consumer's compile, and because the run's own reads are then the one thing a
 * caller can watch. The command line binds it to the platform it runs on; nothing
 * under this module does.
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
}
