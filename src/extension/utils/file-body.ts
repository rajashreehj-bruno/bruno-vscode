import fs from 'fs';
import path from 'path';

export interface FileBodyEntry {
  filePath?: string | null;
  contentType?: string | null;
  selected?: boolean;
}

export interface FileBody {
  data: Buffer;
  contentType: string;
}

export const DEFAULT_FILE_BODY_CONTENT_TYPE = 'application/octet-stream';

/**
 * File / Binary body mode holds a list of files of which exactly one is sent.
 * Falls back to the first file with a path — the radio button in the request pane
 * shows the first row as picked before the user ever clicks it.
 */
export const getSelectedFileBodyEntry = (files: FileBodyEntry[] | null | undefined): FileBodyEntry | undefined => {
  const candidates = (files || []).filter((file) => typeof file?.filePath === 'string' && file.filePath.trim().length > 0);
  if (!candidates.length) {
    return undefined;
  }
  return candidates.find((file) => file.selected) || candidates[0];
};

/**
 * Reads the selected file as the raw request body. Paths are stored relative to the
 * collection when the file lives inside it, absolute otherwise.
 */
export const readFileBody = (files: FileBodyEntry[] | null | undefined, collectionPath: string): FileBody | null => {
  const entry = getSelectedFileBodyEntry(files);
  if (!entry) {
    return null;
  }

  const filePath = (entry.filePath as string).trim();
  const resolvedPath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(collectionPath, filePath);

  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
    throw new Error(`File not found for request body: ${filePath}`);
  }

  return {
    data: fs.readFileSync(resolvedPath),
    contentType: (entry.contentType || '').trim() || DEFAULT_FILE_BODY_CONTENT_TYPE
  };
};
