// =============================================================================
// scan-other.js — the smaller scanners: Edge Functions, docs (ADRs, module
// guides, patch notes), page-test coverage and the git log.
//
// Git is read with `git log` through execFileSync (no shell, works on Windows).
// If git is missing or the folder is not a repository the timeline is empty and
// the Health page says so; nothing else depends on it.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import { readText, walk, rel, sha, headerComment, headerSummary, uniq } from './text.js';

/** supabase/functions/<name>/index.ts → secrets, backend calls, outside hosts, who may call it. */
export function scanEdgeFunctions(root, dir) {
  const base = join(root, dir);
  if (!existsSync(base)) return {};
  const out = {};
  for (const name of readdirSync(base).sort()) {
    const files = walk(join(base, name)).filter((f) => /\.(ts|js)$/.test(f));
    if (!files.length) continue;
    const text = files.map(readText).join('\n');
    const header = headerComment(readText(files[0]));
    out[name] = {
      name,
      files: files.map((f) => rel(root, f)),
      header, summary: headerSummary(header),
      secrets: uniq([...text.matchAll(/Deno\.env\.get\(\s*['"]([A-Z0-9_]+)['"]/g)].map((m) => m[1])),
      rpcs: uniq([...text.matchAll(/\.rpc\(\s*['"]([a-z_0-9]+)['"]/g)].map((m) => m[1])),
      tables: uniq([...text.matchAll(/\.from\(\s*['"]([a-z_0-9]+)['"]/g)].map((m) => m[1])),
      hosts: uniq([...text.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase())),
      usesServiceRole: /SUPABASE_SERVICE_ROLE_KEY/.test(text),
      checksSignature: /signature/i.test(text),
      hash: sha(text),
    };
  }
  return out;
}

/** docs/adr/NNNN-*.md → { id, title, status, file, mentions[] } (mentions filled in by the graph). */
export function scanAdrs(root, dir) {
  const base = join(root, dir);
  if (!existsSync(base)) return [];
  return readdirSync(base).filter((f) => /^\d{4}-.*\.md$/.test(f)).sort().map((f) => {
    const text = readText(join(base, f));
    const title = (/^#\s+(.+)$/m.exec(text) || [, f])[1].replace(/^\d{4}\s*[—-]\s*/, '').trim();
    const status = (/\*\*Status:\*\*\s*([^\n]+)/.exec(text) || [, 'Unknown'])[1].trim();
    const pick = (label) => ((new RegExp(`\\*\\*${label}\\.?\\*\\*\\s*([\\s\\S]*?)(?=\\n\\*\\*[A-Z]|$)`).exec(text) || [, ''])[1]).trim();
    return { id: f.slice(0, 4), file: `${dir}/${f}`, title, status, context: pick('Context'), decision: pick('Decision'),
      consequences: pick('Consequences'), text, hash: sha(text) };
  });
}

/** docs/modules/*.md and docs/patches/*.md: title + first paragraph, for linking. */
export function scanDocs(root, dir) {
  const base = join(root, dir);
  if (!existsSync(base)) return [];
  return readdirSync(base).filter((f) => f.endsWith('.md')).sort().map((f) => {
    const text = readText(join(base, f));
    const title = (/^#\s+(.+)$/m.exec(text) || [, f])[1].trim();
    const para = text.split('\n\n').map((p) => p.trim()).find((p) => p && !p.startsWith('#')) ?? '';
    return { file: `${dir}/${f}`, title, summary: para.replace(/\s+/g, ' ').slice(0, 400), text };
  });
}

/** tests/pages.test.js → [{ name, mains, routes, rpcs }] one per test(). */
export function scanPageTests(text) {
  const parts = text.split(/\ntest\(/).slice(1);
  return parts.map((p) => {
    const name = (/^\s*['"`]((?:\\.|[^'"`])*)['"`]/.exec(p) || [, '?'])[1];
    return {
      name,
      mains: uniq([...p.matchAll(/importFresh\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1])),
      routes: uniq([...p.matchAll(/location\.hash\s*=\s*['"](#[\w/-]+)/g)].map((m) => m[1].replace(/\/[\w-]*$/, ''))),
      rpcs: uniq([...p.matchAll(/\b([a-z][a-z0-9_]+)\s*:\s*(?:async\s*)?\(/g)].map((m) => m[1]).filter((n) => n.includes('_'))),
    };
  });
}

/** Commits with the files each one changed. Newest first. */
export function gitLog(root, max = 2000) {
  try {
    const out = execFileSync('git', ['log', `-${max}`, '--date=iso-strict', '--name-only', '--format=%x1e%H%x1f%h%x1f%an%x1f%ad%x1f%s'],
      { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\x1e').filter((c) => c.trim()).map((c) => {
      const [head, ...files] = c.split('\n');
      const [hash, short, author, date, subject] = head.split('\x1f');
      return { hash, short, author, date, subject, files: files.map((f) => f.trim()).filter(Boolean) };
    });
  } catch {
    return null;   // not a git checkout, or git not installed
  }
}

/** Files changed since a tag / commit (for `appatlas diff --since`). */
export function changedSince(root, ref) {
  const out = execFileSync('git', ['diff', '--name-only', `${ref}..HEAD`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return out.split('\n').map((f) => f.trim()).filter(Boolean);
}

export const fileBase = (p) => basename(p);
