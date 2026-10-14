#!/usr/bin/env node
/**
 * Refresh the offline manual: node scripts/sync-linux-command.mjs
 * Requires Node.js 20+, curl, and tar on PATH (Git Bash supplies both on Windows).
 * Downloads the pinned archive into a temporary directory, imports only
 * command/*.md and LICENSE, and validates coverage before replacing resources.
 * Upstream Markdown and license bytes are preserved; only index metadata is cleaned.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile, copyFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = 'https://github.com/jaywcjlove/linux-command';
const commit = 'cd17682d612e6fdfaff29261c11ffbc3f951f41d';
const archiveUrl = `https://codeload.github.com/jaywcjlove/linux-command/tar.gz/${commit}`;
const archiveSha256 = 'c8fdd6447bb9679d410780745092d06af22eaff9f932c2408714b35b791be002';
const expectedCount = 621;
const root = `linux-command-${commit}`;
const destination = path.resolve(fileURLToPath(new URL('../apps/desktop-ui/src/data/linux-command/', import.meta.url)));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function metadata(id, bytes) {
  const lines = bytes.toString('utf8').replace(/^﻿/, '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim());
  const first = lines[start]?.trim() ?? '';
  const atx = /^#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(first);
  assert(atx || /^\s*[=-]+\s*$/.test(lines[start + 1] ?? ''), `Missing title: ${id}`);
  const name = (atx ? atx[1] : first).replace(/﻿/g, '').trim();
  const intro = lines.slice(start + (atx ? 1 : 2));
  while (intro.length && !intro[0].trim()) intro.shift();
  const paragraph = [];
  for (const line of intro) {
    if (!line.trim() || /^\s*(?:#|```|~~~)/.test(line)) break;
    paragraph.push(line.trim());
  }
  const description = paragraph.join(' ').replace(/﻿/g, '').trim();
  assert(name && description, `Missing name or introduction: ${id}`);
  return { id, name, description };
}

// Resource-bearing Markdown/HTML references, excluding code examples.
function imageReferences(id, markdown) {
  const prose = markdown.replace(/^\s*(```|~~~)[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '');
  const definitions = new Map([...prose.matchAll(/^\s*\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+["'(].*)?$/gm)]
    .map((match) => [match[1].trim().toLowerCase(), match[2]]));
  const references = [];
  for (const match of prose.matchAll(/!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))[^)]*\)/g)) {
    references.push({ document: `docs/${id}.md`, kind: 'markdown-image', url: match[2] ?? match[3] });
  }
  for (const match of prose.matchAll(/!\[([^\]]+)\](?:\[([^\]]*)\])?(?!\()/g)) {
    const key = (match[2] || match[1]).trim().toLowerCase();
    assert(definitions.has(key), `Unresolved image reference in ${id}: ${key}`);
    references.push({ document: `docs/${id}.md`, kind: 'markdown-image', url: definitions.get(key) });
  }
  for (const tag of prose.matchAll(/<(?:img|source|video|audio|iframe|object|link|script)\b[^>]*>/gi)) {
    for (const attribute of tag[0].matchAll(/\b(?:src|href|poster|data|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      references.push({ document: `docs/${id}.md`, kind: 'html-resource', url: attribute[1] ?? attribute[2] ?? attribute[3] });
    }
  }
  // A changed pin must explicitly handle any new local asset rather than silently omit it.
  for (const reference of references) {
    assert(/^(?:https?:\/\/|\/\/|data:)/i.test(reference.url), `Local asset needs vendoring: ${id}: ${reference.url}`);
  }
  return references;
}

async function main() {
  const temporary = await mkdtemp(path.join(tmpdir(), 'pandaterm-linux-command-'));
  let staging;
  try {
    const archivePath = path.join(temporary, 'source.tar.gz');
    // curl also honors system proxy settings in environments where Node fetch cannot connect.
    // No redirects are followed; only HTTPS is allowed, with bounded time and download size.
    execFileSync('curl', ['--fail', '--silent', '--show-error', '--proto', '=https', '--tlsv1.2',
      '--retry', '3', '--retry-all-errors', '--max-time', '120', '--max-filesize', String(32 * 1024 * 1024),
      '--output', archivePath, archiveUrl], { timeout: 600_000, maxBuffer: 1024 * 1024 });
    const archive = await readFile(archivePath);
    assert(archive.length <= 32 * 1024 * 1024, 'Unexpected archive size');
    assert(hash(archive) === archiveSha256, 'Pinned archive SHA-256 mismatch');
    const entries = execFileSync('tar', ['-tzf', 'source.tar.gz'], { cwd: temporary, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim().split(/\r?\n/);
    assert(entries.every((entry) => entry.startsWith(`${root}/`) && !entry.includes('\\') && !entry.split('/').includes('..')), 'Unsafe archive path');
    const documents = entries.filter((entry) => new RegExp(`^${root}/command/[a-zA-Z0-9._+-]+\\.md$`).test(entry)).sort();
    const allMarkdown = entries.filter((entry) => entry.startsWith(`${root}/command/`) && entry.endsWith('.md'));
    assert(documents.length === expectedCount && allMarkdown.length === expectedCount, `Expected ${expectedCount} documents, found ${allMarkdown.length}`);
    assert(new Set(documents).size === expectedCount, 'Duplicate archive document paths');
    assert(entries.includes(`${root}/LICENSE`), 'Missing upstream license');
    // Extract only approved files. The archive checksum and paths are checked first.
    // A file list avoids Windows command-line length limits for all 621 documents.
    await writeFile(path.join(temporary, 'members.txt'), [`${root}/LICENSE`, ...documents].join('\n') + '\n');
    execFileSync('tar', ['-xzf', 'source.tar.gz', '-T', 'members.txt'], { cwd: temporary, maxBuffer: 8 * 1024 * 1024 });
    await mkdir(path.dirname(destination), { recursive: true });
    staging = await mkdtemp(path.join(path.dirname(destination), '.linux-command-'));
    await mkdir(path.join(staging, 'docs'));
    const index = [];
    const checksums = {};
    const references = [];
    for (const document of documents) {
      const filename = path.posix.basename(document);
      const id = filename.slice(0, -3);
      const source = path.join(temporary, ...document.split('/'));
      const bytes = await readFile(source);
      index.push(metadata(id, bytes));
      references.push(...imageReferences(id, bytes.toString('utf8')));
      checksums[`docs/${filename}`] = hash(bytes);
      await copyFile(source, path.join(staging, 'docs', filename));
    }
    const license = await readFile(path.join(temporary, root, 'LICENSE'));
    assert(license.toString('utf8').includes('MIT License') && license.toString('utf8').includes('OUT OF OR IN CONNECTION WITH THE SOFTWARE'), 'Incomplete MIT license');
    await writeFile(path.join(staging, 'LICENSE'), license);
    await writeFile(path.join(staging, 'index.json'), json(index));
    await writeFile(path.join(staging, 'provenance.json'), json({
      repository, commit, archiveUrl, archiveSha256,
      sourceDirectory: 'command', documentCount: expectedCount, license: 'MIT',
      importCommand: 'node scripts/sync-linux-command.mjs',
      contentPolicy: 'Markdown and LICENSE are copied byte-for-byte; index titles remove BOMs and descriptions use the initial introduction paragraph.',
      images: { localCount: 0, externalCount: references.length, references,
        policy: 'External URLs are preserved and require network access; the pinned source has no local image or HTML resource dependencies.' },
      titleDifferences: index.filter((entry) => entry.id !== entry.name),
      checksums: { ...checksums, LICENSE: hash(license), 'index.json': hash(Buffer.from(json(index))) },
    }));
    assert((await readdir(path.join(staging, 'docs'))).length === expectedCount, 'Staged document coverage mismatch');
    // Only this generated resource directory is replaced; no application files are touched.
    await rm(destination, { recursive: true, force: true });
    // Copying validated files avoids directory-rename locks from Windows file watchers.
    await cp(staging, destination, { recursive: true });
    console.log(`Imported ${index.length} documents into ${destination}`);
    console.log(`Index: { id, name, description }; title differences: ${index.filter((entry) => entry.id !== entry.name).length}`);
    console.log(`Image/HTML resource references: ${references.length} external, 0 local`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
