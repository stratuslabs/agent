import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * Writes `data` to `filePath` and flushes it to disk before returning.
 *
 * For the temporary file of a write-then-rename. A rename makes the switch
 * atomic for a reader, but not durable: without a flush the name can reach
 * the disk before the bytes do, and a crash, a power cut or a volume
 * snapshot then finds the file at its final name with nothing in it. That
 * is what a Fly volume snapshot taken 65 s after a fresh start held:
 * `gateway-token`, `state.json` and `gateway.json` all zero bytes, and a
 * daemon that refused to start on the restored volume.
 *
 * `flag` and `mode` mean what they mean to `writeFile` (`'wx'` refuses a
 * file that exists; `mode` applies when the file is created).
 */
export const writeFileSynced = async (
  filePath: string,
  data: string | Uint8Array,
  options: { flag?: 'w' | 'wx'; mode?: number } = {},
): Promise<void> => {
  const handle = await open(filePath, options.flag ?? 'w', options.mode ?? 0o666);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/**
 * What a directory fsync can answer where it isn't supported: some
 * filesystems refuse it (EINVAL, ENOTSUP), and Windows can't open a
 * directory to sync at all (EISDIR, EPERM). The rename or link before it
 * has already happened, so none of these is a failed write.
 */
const UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR', 'EPERM', 'EACCES']);

/**
 * Flushes a directory's entries to disk: after a rename or link into it,
 * this is what makes the new name survive a crash. A real I/O error is
 * thrown; a filesystem that can't sync a directory is not one.
 */
export const syncDirectory = async (directory: string): Promise<void> => {
  let handle;
  try {
    handle = await open(directory, 'r');
  } catch (error) {
    if (UNSUPPORTED.has((error as NodeJS.ErrnoException).code ?? '')) {
      return;
    }
    throw error;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (!UNSUPPORTED.has((error as NodeJS.ErrnoException).code ?? '')) {
      throw error;
    }
  } finally {
    await handle.close();
  }
};

/**
 * Replaces `filePath` with `data`, readable only by the owner: written
 * beside it, flushed, and renamed over it, never truncated and rewritten in
 * place. A reader sees the old file or the new one and never half of
 * either, and a crash mid-write leaves the old one rather than none.
 *
 * Atomic for a reader only: two processes each doing a read-modify-write
 * can still lose one another's update unless they share a lock.
 */
export const replaceOwnerOnlyFile = async (filePath: string, data: string): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  // Unique per write, so two writers never share a temporary file.
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFileSynced(temporary, data, { mode: 0o600 });
    // Before the rename rather than after: the destination must never exist
    // at a looser mode, even briefly. The mode above applies only when the
    // file is created, so the explicit chmod stays.
    await chmod(temporary, 0o600);
    await rename(temporary, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    // A failed write must not leave a file holding secrets behind.
    await rm(temporary, { force: true });
    throw error;
  }
};
