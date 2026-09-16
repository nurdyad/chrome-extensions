import * as filesystem from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Same-directory rename publishes a complete file. Interrupted staging files
// are never read as policy; the previous policy remains authoritative.
export async function writeJsonAtomic(path, value, io = filesystem) {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  await io.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await io.open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await io.rename(temporary, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await io.rm(temporary, { force: true }).catch(() => undefined);
  }
}
