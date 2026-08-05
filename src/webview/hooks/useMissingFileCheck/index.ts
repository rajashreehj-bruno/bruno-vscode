import { useEffect, useRef, useState } from 'react';
import { getAbsoluteFilePath } from 'utils/common/path';
import { ipcRenderer } from 'utils/ipc';

export type MissingFileCheckStatus = 'idle' | 'checking' | 'ready' | 'error';

export interface MissingFileCheckState {
  status: MissingFileCheckStatus;
  missingPaths: string[];
}

/**
 * Checks whether the given file paths (resolved against `basePath`) exist on disk.
 *
 * - `'idle'`     — nothing to check (empty input or no `basePath`)
 * - `'checking'` — a check is in flight; `missingPaths` is empty
 * - `'ready'`    — check completed; `missingPaths` lists paths that don't exist
 * - `'error'`    — the check itself failed (e.g. IPC threw); `missingPaths` is empty
 */
const useMissingFileCheck = (paths: string[], basePath?: string): MissingFileCheckState => {
  const [state, setState] = useState<MissingFileCheckState>({ status: 'idle', missingPaths: [] });
  const seqRef = useRef(0);
  const pathsRef = useRef(paths);
  pathsRef.current = paths;

  const pathsKey = paths.join('\0');

  useEffect(() => {
    const currentPaths = pathsRef.current;
    if (!currentPaths.length || !basePath) {
      setState({ status: 'idle', missingPaths: [] });
      return;
    }

    const seq = ++seqRef.current;
    setState({ status: 'checking', missingPaths: [] });

    Promise.all(
      currentPaths.map(async (filePath) => {
        const exists = await ipcRenderer.invoke<boolean>(
          'renderer:exists-sync',
          getAbsoluteFilePath(basePath, filePath)
        );
        return { filePath, exists };
      })
    ).then(
      (results) => {
        if (seq !== seqRef.current) return;
        setState({
          status: 'ready',
          missingPaths: results.filter((r) => !r.exists).map((r) => r.filePath)
        });
      },
      () => {
        if (seq !== seqRef.current) return;
        setState({ status: 'error', missingPaths: [] });
      }
    );
  }, [pathsKey, basePath]);

  return state;
};

export default useMissingFileCheck;
