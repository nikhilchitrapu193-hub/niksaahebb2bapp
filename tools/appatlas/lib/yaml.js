// =============================================================================
// yaml.js — reads and writes the YAML subset AppAtlas annotation files use.
//
// Supported: nested maps, lists of scalars, lists of maps, quoted ('…' / "…")
// and plain scalars, `|` block text, `#` comments, true/false/null/numbers.
// Not supported: anchors, flow maps `{a: 1}`, multi-document files, tabs.
// shortcut: a hand-written subset instead of js-yaml because the project allows no
// new dependencies (AGENTS.md rule 7); upgrade to js-yaml if annotations ever need
// the unsupported features. parse() throws with a line number on anything else,
// so a bad file fails `npm run atlas` instead of silently losing text.
// =============================================================================

function scalar(raw, line) {
  const t = raw.trim();
  if (t === '' || t === '~' || t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === '[]') return [];
  if (t === '{}') return {};
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.startsWith('"')) {
    if (!t.endsWith('"') || t.length < 2) throw new Error(`line ${line}: unclosed double quote`);
    return JSON.parse(t);
  }
  if (t.startsWith("'")) {
    if (!t.endsWith("'") || t.length < 2) throw new Error(`line ${line}: unclosed single quote`);
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (t.startsWith('[') || t.startsWith('{')) {
    // Flow lists of plain words only: [a, b, c]
    const m = /^\[(.*)\]$/.exec(t);
    if (!m) throw new Error(`line ${line}: flow maps are not supported; use an indented block`);
    return m[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => scalar(s, line));
  }
  return t;
}

/** Remove a trailing " # comment" that is outside quotes. */
function stripComment(text) {
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { if (i === 0 || /[\s:\-[,]/.test(text[i - 1])) q = ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i);
  }
  return text;
}

export function parse(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n').map((raw, i) => {
    if (/^\t/.test(raw)) throw new Error(`line ${i + 1}: tabs are not allowed; indent with spaces`);
    return { raw, n: i + 1, indent: raw.length - raw.trimStart().length, text: stripComment(raw).trimEnd() };
  });
  let pos = 0;
  const next = () => { while (pos < lines.length && lines[pos].text.trim() === '') pos++; return lines[pos]; };

  function block(indent) {
    const first = next();
    if (!first || first.indent < indent) return null;
    return first.text.trim().startsWith('- ') || first.text.trim() === '-' ? list(first.indent) : map(first.indent);
  }

  function blockText(parentIndent) {
    const out = [];
    let bodyIndent = null;
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.raw.trim() === '') { out.push(''); pos++; continue; }
      if (l.indent <= parentIndent) break;
      bodyIndent ??= l.indent;
      out.push(l.raw.slice(bodyIndent));
      pos++;
    }
    while (out.length && out.at(-1) === '') out.pop();
    return out.join('\n');
  }

  function value(rest, indent, n) {
    if (rest.trim() === '|') return blockText(indent);
    if (rest.trim() === '') return block(indent + 1);
    return scalar(rest, n);
  }

  function map(indent) {
    const obj = {};
    for (;;) {
      const l = next();
      if (!l || l.indent < indent) return obj;
      if (l.indent > indent) throw new Error(`line ${l.n}: unexpected indent`);
      const m = /^([A-Za-z0-9_.-]+):(?:\s(.*)|$)/.exec(l.text.trim());
      if (!m) throw new Error(`line ${l.n}: expected "key: value"`);
      if (Object.hasOwn(obj, m[1])) throw new Error(`line ${l.n}: duplicate key "${m[1]}"`);
      pos++;
      obj[m[1]] = value(m[2] ?? '', indent, l.n);
    }
  }

  function list(indent) {
    const arr = [];
    for (;;) {
      const l = next();
      if (!l || l.indent < indent) return arr;
      if (l.indent > indent) throw new Error(`line ${l.n}: unexpected indent`);
      const t = l.text.trim();
      if (!t.startsWith('-')) return arr;
      const rest = t.replace(/^-\s?/, '');
      const itemIndent = indent + (l.text.length - l.text.trimStart().length - indent) + 2;
      if (/^[A-Za-z0-9_.-]+:(\s|$)/.test(rest) && !/^["']/.test(rest)) {
        // "- key: value" starts a map whose keys line up with "key"
        lines[pos] = { ...l, indent: itemIndent, text: ' '.repeat(itemIndent) + rest };
        arr.push(map(itemIndent));
      } else {
        pos++;
        arr.push(rest === '' ? block(indent + 1) : scalar(rest, l.n));
      }
    }
  }

  const result = block(0) ?? {};
  const left = next();
  if (left) throw new Error(`line ${left.n}: could not read this line (check its indentation)`);
  return result;
}

// ---------- writing ----------------------------------------------------------

function quote(s) {
  if (s === null || s === undefined) return 'null';
  if (typeof s === 'number' || typeof s === 'boolean') return String(s);
  return JSON.stringify(String(s));
}

/** Write a value as YAML that parse() reads back to the same value. */
export function stringify(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}[]\n`;
    return value.map((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const body = stringify(item, indent + 2);
        return `${pad}- ${body.slice(indent + 2)}`;
      }
      return `${pad}- ${quote(item)}\n`;
    }).join('');
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([k, v]) => {
      if (Array.isArray(v)) return v.length ? `${pad}${k}:\n${stringify(v, indent + 2)}` : `${pad}${k}: []\n`;
      if (v && typeof v === 'object') return Object.keys(v).length ? `${pad}${k}:\n${stringify(v, indent + 2)}` : `${pad}${k}: {}\n`;
      if (typeof v === 'string' && v.includes('\n')) return `${pad}${k}: |\n${v.split('\n').map((l) => (l ? `${pad}  ${l}` : '')).join('\n')}\n`;
      return `${pad}${k}: ${quote(v)}\n`;
    }).join('');
  }
  return `${pad}${quote(value)}\n`;
}
