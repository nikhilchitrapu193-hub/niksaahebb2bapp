// =============================================================================
// annotations.js — loads and checks the human-written knowledge:
//   appatlas/annotations/<feature_id>.yaml   one per feature (the 10 questions)
//   appatlas/troubleshooting.yaml            symptom → cause → fix, never invented
//   appatlas/review-lock.json                what each reviewed feature looked like
//                                            when a person last confirmed it
//
// Draft vs reviewed: an annotation written at setup time by an AI (offline, once)
// or by a developer who has not checked it is `status: draft`. Only a person who
// has read it against the app runs `appatlas review <id> --by "Name"`, which sets
// `status: reviewed` and records the evidence hashes. Drafts are shown as drafts;
// they are never presented as verified (ADR 0026).
//
// Unknown keys are an error, so a typo ("what_if_wong") fails the build instead of
// silently dropping an answer.
// =============================================================================

import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { readText } from './text.js';
import { parse } from './yaml.js';

/** The 10 questions every feature answers in Admin Mode, in order. */
export const QUESTIONS = [
  { key: 'what_is_this',          q: 'What is this feature?' },
  { key: 'why_it_exists',         q: 'Why does the business need it?' },
  { key: 'who_uses_it',           q: 'Who uses it?' },
  { key: 'what_does_it_affect',   q: 'What does it affect?' },
  { key: 'what_if_i_change_it',   q: 'What happens if I change it?' },
  { key: 'what_if_wrong',         q: 'What happens if it is set up wrong?' },
  { key: 'prerequisites',         q: 'What must be in place first?' },
  { key: 'workflow',              q: 'What are the steps?' },
  { key: 'common_errors',         q: 'What do the common errors mean?' },
  { key: 'when_to_call_developer', q: 'When should I call a developer?' },
];

const TOP = {
  feature_id: 'string', name: 'string', module: 'string', status: 'string', drafted_by: 'string',
  reviewed_by: 'string', reviewed_on: 'string', screens: 'list', infrastructure: 'boolean',
  evidence: 'map', admin: 'map', developer: 'map', screenshot: 'string', roles: 'list',
};
const ADMIN = { ...Object.fromEntries(QUESTIONS.map((q) => [q.key, q.key === 'workflow' || q.key === 'common_errors' ? 'list' : 'string'])), migration_guide: 'map' };
const DEVELOPER = { notes: 'string', known_issues: 'list', code_to_replace: 'list', config_files: 'list' };
const EVIDENCE = { functions: 'list', tables: 'list', edge_functions: 'list', buckets: 'list', files: 'list' };
const STATUSES = ['draft', 'reviewed'];

function typeOf(v) { return Array.isArray(v) ? 'list' : v === null ? 'null' : typeof v === 'object' ? 'map' : typeof v; }

function checkKeys(obj, allowed, where, errors) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (!allowed[k]) { errors.push(`${where}: unknown key "${k}"`); continue; }
    if (v !== null && typeOf(v) !== allowed[k]) errors.push(`${where}.${k}: expected ${allowed[k]}, found ${typeOf(v)}`);
  }
}

/** Check one parsed annotation; returns a list of problems (empty = fine). */
export function validateAnnotation(a, file) {
  const errors = [];
  if (!a || typeOf(a) !== 'map') return [`${file}: not a YAML map`];
  checkKeys(a, TOP, file, errors);
  if (!a.feature_id) errors.push(`${file}: feature_id is required`);
  if (!a.name) errors.push(`${file}: name is required`);
  if (a.feature_id && !file.endsWith(`${a.feature_id}.yaml`)) errors.push(`${file}: file name must be ${a.feature_id}.yaml`);
  if (a.status && !STATUSES.includes(a.status)) errors.push(`${file}: status must be draft or reviewed`);
  if (a.status === 'reviewed' && !(a.reviewed_by && a.reviewed_on)) errors.push(`${file}: a reviewed annotation needs reviewed_by and reviewed_on (use appatlas review)`);
  checkKeys(a.admin, ADMIN, `${file} admin`, errors);
  checkKeys(a.developer, DEVELOPER, `${file} developer`, errors);
  checkKeys(a.evidence, EVIDENCE, `${file} evidence`, errors);
  for (const [i, e] of (a.admin?.common_errors ?? []).entries()) {
    if (typeOf(e) !== 'map' || !e.symptom || !e.solution) errors.push(`${file} admin.common_errors[${i}]: needs symptom and solution`);
  }
  for (const [i, s] of (a.admin?.workflow ?? []).entries()) if (typeof s !== 'string') errors.push(`${file} admin.workflow[${i}]: must be text`);
  return errors;
}

export function loadAnnotations(root, dir) {
  const base = join(root, dir);
  const out = {}, errors = [];
  if (!existsSync(base)) return { annotations: out, errors };
  for (const f of readdirSync(base).filter((n) => n.endsWith('.yaml')).sort()) {
    const path = `${dir}/${f}`;
    try {
      const a = parse(readText(join(base, f)));
      const problems = validateAnnotation(a, path);
      errors.push(...problems);
      if (a?.feature_id) out[a.feature_id] = { ...a, status: a.status ?? 'draft', file: path };
    } catch (e) {
      errors.push(`${path}: ${e.message}`);
    }
  }
  return { annotations: out, errors };
}

/** Troubleshooting catalog: [{ id, symptom, match[], cause, fix, features[] }]. */
export function loadTroubleshooting(root, file) {
  const path = join(root, file);
  if (!existsSync(path)) return { entries: [], errors: [] };
  const errors = [];
  let doc;
  try { doc = parse(readText(path)); } catch (e) { return { entries: [], errors: [`${file}: ${e.message}`] }; }
  const entries = (doc.entries ?? []).map((e, i) => {
    for (const k of Object.keys(e)) if (!['id', 'symptom', 'match', 'cause', 'fix', 'features', 'source'].includes(k)) errors.push(`${file} entries[${i}]: unknown key "${k}"`);
    if (!e.id || !e.symptom || !e.cause || !e.fix) errors.push(`${file} entries[${i}]: needs id, symptom, cause and fix`);
    return { features: [], match: [], ...e };
  });
  const ids = entries.map((e) => e.id);
  for (const id of ids.filter((x, i) => ids.indexOf(x) !== i)) errors.push(`${file}: duplicate id "${id}"`);
  return { entries, errors };
}

/**
 * Deterministic matching: an entry matches when any of its `match` strings (or its
 * symptom) appears in the text, ignoring case and punctuation. No scoring, no guessing.
 */
export function matchTroubleshooting(entries, text) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9₹%]+/g, ' ').trim();
  const t = norm(text);
  if (!t) return [];
  return entries.filter((e) => [...e.match, e.symptom].some((m) => { const n = norm(m); return n && (t.includes(n) || n.includes(t)); }));
}

export function loadLock(root, file) {
  const t = readText(join(root, file));
  return t ? JSON.parse(t) : {};
}
