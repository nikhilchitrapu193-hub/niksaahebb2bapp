// =============================================================================
// text.js — small text helpers shared by the AppAtlas scanners: hashing,
// comment stripping, bracket matching and file walking.
// Pure text analysis, no parsers: the scanners rely on the project's own
// conventions (api.js wrappers, `public.`-qualified SQL, header comments), which
// docs/code-rules.md makes every file follow. ADR 0026 explains why.
// =============================================================================

import { createHash } from 'node:crypto';
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** Repo-relative path with forward slashes, so output is the same on Windows. */
export const rel = (root, file) => relative(root, file).split(sep).join('/');

export function readText(file) { return existsSync(file) ? readFileSync(file, 'utf8') : ''; }

/** Every file under dir (recursive), skipping folders named in `skip`. */
export function walk(dir, skip = ['node_modules', '.git', 'vendor']) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((name) => {
    if (skip.includes(name)) return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full, skip) : [full];
  });
}

/** Blank out // and /* *\/ comments in JS, keeping string contents and line numbers. */
export function stripJsComments(src) {
  let out = '', q = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) { out += ch; if (ch === '\\') { out += src[++i] ?? ''; continue; } if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { q = ch; out += ch; continue; }
    // A regex literal like /\/\// would confuse this; the codebase keeps those out of api.js.
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } out += '\n'; continue; }
    if (ch === '/' && src[i + 1] === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i++; continue;
    }
    out += ch;
  }
  return out;
}

/** From index i (just after an opening bracket) to its matching close: [inner, closeIndex]. */
export function balanced(src, i, open = '{', close = '}') {
  let depth = 1, q = null;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (q) { if (ch === '\\') { j++; continue; } if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { q = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return [src.slice(i, j), j];
  }
  return [src.slice(i), src.length];
}

export const lineAt = (src, index) => src.slice(0, index).split('\n').length;

/** The header comment block at the top of a JS/TS file, as plain lines. */
export function headerComment(src) {
  const lines = [];
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('//')) break;
    const body = t.replace(/^\/\/ ?/, '');
    if (/^=+$/.test(body.trim())) continue;
    lines.push(body);
  }
  return lines.join('\n').trim();
}

/** First sentence of the header, after "name.js — ". Empty when there is no header. */
export function headerSummary(header) {
  const text = header.replace(/\s+/g, ' ').trim();
  const afterDash = text.replace(/^[\w./-]+(?:\s*\([^)]*\))?\s+[—-]+\s+/, '');
  const m = /^(.+?[.!?])(\s|$)/.exec(afterDash);
  return (m ? m[1] : afterDash).trim();
}

export const uniq = (list) => [...new Set(list)].sort();
