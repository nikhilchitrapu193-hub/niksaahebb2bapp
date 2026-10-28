// =============================================================================
// test-logger.js — reads TAP output from node --test on stdin, writes a
// structured failure log to test-failures.log in the project root.
//
// Usage:  npm run test:log
// Output: test-failures.log (created/overwritten each run)
//
// The log contains: timestamp, totals summary, then one block per failure
// with the test name, file, line number (when TAP provides it), and the
// full error message / diff.
// =============================================================================

import fs   from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const OUT = path.resolve('test-failures.log');

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

// Accumulators
const failures  = [];   // { name, file, line, detail[] }
const allLines  = [];   // every line of TAP — echoed to stdout too

let current     = null; // failure block being built
let totalOk     = 0;
let totalFail   = 0;
let totalSkip   = 0;

// TAP line patterns
const RX_OK      = /^ok \d+/;
const RX_NOT_OK  = /^not ok \d+ - (.+)/;
const RX_YAML    = /^  ---/;
const RX_YAML_END= /^  \.\.\./;
const RX_PLAN    = /^1\.\.(\d+)/;
const RX_COMMENT = /^#\s*(tests|pass|fail|skip):\s*(\d+)/i;

let inYaml = false;

rl.on('line', (line) => {
  // Echo every line to stdout so the terminal still shows normal output
  process.stdout.write(line + '\n');
  allLines.push(line);

  // Tally plan / comment summary lines
  const cmt = line.match(RX_COMMENT);
  if (cmt) {
    const key = cmt[1].toLowerCase();
    const n   = Number(cmt[2]);
    if (key === 'pass')  totalOk   = n;
    if (key === 'fail')  totalFail = n;
    if (key === 'skip')  totalSkip = n;
  }

  // ok line — close any open failure block
  if (RX_OK.test(line)) {
    if (current) { failures.push(current); current = null; }
    return;
  }

  // not ok — open a new failure block
  const notOk = line.match(RX_NOT_OK);
  if (notOk) {
    if (current) failures.push(current);   // push previous if any
    current = { name: notOk[1].trim(), file: '', lineNo: '', detail: [] };
    inYaml  = false;
    return;
  }

  // YAML block inside a not-ok (contains error detail, file, line)
  if (current) {
    if (RX_YAML.test(line))     { inYaml = true;  return; }
    if (RX_YAML_END.test(line)) { inYaml = false; return; }

    if (inYaml) {
      // Extract file / line from TAP YAML fields
      const fileLine = line.match(/^\s+file:\s*'?(.+?)'?\s*$/);
      const lineNo   = line.match(/^\s+line:\s*(\d+)/);
      if (fileLine) { current.file   = fileLine[1]; return; }
      if (lineNo)   { current.lineNo = lineNo[1];   return; }
      // Everything else in the YAML block is error detail
      current.detail.push(line.trimStart());
    }
  }
});

rl.on('close', () => {
  // Push any dangling failure block
  if (current) failures.push(current);

  const now     = new Date().toISOString();
  const total   = totalOk + totalFail;
  const lines   = [];

  lines.push('='.repeat(72));
  lines.push(`Fresh Supply — test failure log`);
  lines.push(`Run at : ${now}`);
  lines.push(`Result : ${totalFail === 0 ? 'ALL PASSED' : `${totalFail} FAILED`}  (${totalOk}/${total} passed${totalSkip ? ', ' + totalSkip + ' skipped' : ''})`);
  lines.push('='.repeat(72));

  if (failures.length === 0) {
    lines.push('');
    lines.push('No failures — all tests passed.');
  } else {
    failures.forEach((f, i) => {
      lines.push('');
      lines.push(`── FAILURE ${i + 1} ${'─'.repeat(60 - String(i + 1).length)}`);
      lines.push(`Test : ${f.name}`);
      if (f.file)   lines.push(`File : ${f.file}${f.lineNo ? ':' + f.lineNo : ''}`);
      if (f.detail.length) {
        lines.push('');
        lines.push('Detail:');
        f.detail.forEach((d) => lines.push('  ' + d));
      }
    });
    lines.push('');
    lines.push('='.repeat(72));
    lines.push(`${failures.length} failure(s) listed above.`);
  }

  lines.push('');

  fs.writeFileSync(OUT, lines.join('\n'), 'utf8');

  process.stderr.write(`\nFailure log written to: ${OUT}\n`);
  // Exit with the same code node --test would
  process.exitCode = totalFail > 0 ? 1 : 0;
});
