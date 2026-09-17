import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(process.argv[2] || resolve(dirname(fileURLToPath(import.meta.url)), '..'));
async function scripts(dir) {
    const found = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) found.push(...await scripts(path));
        else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) found.push(path);
    }
    return found;
}
try {
    const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
    if (manifest.manifest_version !== 3) throw new Error('manifest.json: expected manifest_version 3');
    const version = String(manifest.version || '');
    if (!/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(version)
        || version.split('.').some(n => Number(n) > 65535) || !version.split('.').some(Number)) {
        throw new Error('manifest.json: invalid Chrome extension version');
    }
    if (!manifest.name || !manifest.background?.service_worker) throw new Error('manifest.json: name and service worker are required');
    const references = [manifest.background.service_worker, manifest.action?.default_popup,
        ...Object.values(manifest.icons || {}), ...Object.values(manifest.action?.default_icon || {}),
        ...(manifest.content_scripts || []).flatMap(script => [...script.js || [], ...script.css || []]),
        ...(manifest.web_accessible_resources || []).flatMap(group => group.resources || [])].filter(Boolean);
    for (const reference of references) {
        const path = resolve(root, reference);
        if (relative(root, path).startsWith('..') || !(await stat(path)).isFile()) throw new Error(`manifest.json: invalid asset ${reference}`);
    }
    const files = await scripts(root);
    for (const path of files) {
        const result = spawnSync(process.execPath, ['--input-type=' + (extname(path) === '.cjs' ? 'commonjs' : 'module'), '--check'], {
            input: await readFile(path, 'utf8'), encoding: 'utf8'
        });
        if (result.error || result.status !== 0) throw new Error(`${relative(root, path)}: ${result.error?.message || result.stderr}`);
    }
    console.log(`Validated manifest, ${references.length} asset references and syntax of ${files.length} JavaScript files.`);
} catch (error) {
    console.error(`Extension check failed: ${error.message}`);
    process.exitCode = 1;
}
