import * as filesystem from 'node:fs/promises';
import path from 'node:path';

const OUTPUT_NAME = 'Aipet-win32-x64';

// This transaction only moves/removes generated directories inside one checked output root.
export async function replaceBundle({ outputRoot, stagedOutput, fs = filesystem }) {
  if (!path.isAbsolute(outputRoot) || !path.isAbsolute(stagedOutput)) throw new Error('Absolute package replacement paths required.');
  const root = path.resolve(outputRoot), staged = path.resolve(stagedOutput);
  const target = path.join(root, OUTPUT_NAME), stagingParent = path.dirname(staged);
  const rootInfo = await fs.lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Unsafe package output root.');
  const realRoot = await fs.realpath(root);
  async function directory(candidate, allowMissing = false) {
    let info;
    try { info = await fs.lstat(candidate); } catch (error) { if (allowMissing && error.code === 'ENOENT') return false; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Refusing non-regular generated directory: ${candidate}`);
    const relative = path.relative(realRoot, await fs.realpath(candidate));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Generated directory escapes package output root: ${candidate}`);
    return true;
  }
  function backupScope(candidate) {
    if (path.dirname(candidate) !== root || !path.basename(candidate).startsWith('.aipet-backup-')) throw new Error('Unsafe package backup path.');
  }
  async function removeEmptyBackup(candidate) {
    backupScope(candidate);
    await directory(candidate);
    // A failed rename or successful rollback leaves only an empty container.
    await fs.rmdir(candidate);
  }
  if (path.dirname(stagingParent) !== root || !path.basename(stagingParent).startsWith('.aipet-staging-') || path.basename(staged) !== OUTPUT_NAME) throw new Error('Unexpected package staging path.');
  await directory(stagingParent);
  await directory(staged);
  const existing = await directory(target, true);
  let backup = null, previous = null;
  if (existing) {
    backup = await fs.mkdtemp(path.join(root, '.aipet-backup-'));
    backupScope(backup);
    await directory(backup);
    previous = path.join(backup, OUTPUT_NAME);
    try {
      // Crucially, a locked/CWD-held existing output fails here BEFORE any old file is deleted.
      await fs.rename(target, previous);
    } catch (cause) {
      await removeEmptyBackup(backup).catch(() => {});
      throw new Error(`Could not move the existing bundle aside. Its files were not removed. Close Aipet and terminals using ${target}, then retry.`, { cause });
    }
  }
  try {
    await fs.rename(staged, target);
  } catch (cause) {
    if (previous) {
      try {
        await directory(previous);
        if (await directory(target, true)) throw new Error('Output path became occupied during replacement.');
        await fs.rename(previous, target);
      } catch (rollbackCause) {
        const error = new Error(`Bundle installation and rollback failed. The previous bundle is preserved at ${previous}. The completed build is at ${staged}.`, { cause: new AggregateError([cause, rollbackCause]) });
        error.backupPath = previous;
        error.preserveStaging = true;
        throw error;
      }
      await removeEmptyBackup(backup).catch(() => {});
      throw new Error('Could not install the completed bundle; the previous bundle was restored.', { cause });
    }
    throw new Error('Could not install the completed bundle; no previous output was changed.', { cause });
  }
  if (backup) {
    try {
      backupScope(backup);
      await directory(backup);
      // Only the checked, uniquely created backup is recursively removed, after installation.
      await fs.rm(backup, { recursive: true, force: false });
    } catch (error) {
      // The new live bundle is valid. Cleanup failure must not turn a successful install into failure.
      return { installed: true, retainedBackup: backup, cleanupWarning: `New bundle installed. Previous backup cleanup was incomplete (${error.code || 'error'}); retained files are at ${backup}.` };
    }
  }
  return { installed: true, retainedBackup: null, cleanupWarning: null };
}
