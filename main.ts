// main.ts is mend, the CLI SPEC.md specifies (MIT). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its break and whether it ends with one (SPEC.md section 3). */
function splitFile(text: string): { br: string; lines: string[]; ends: boolean } {
  if (text === '') return { br: '\n', lines: [], ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const ends = text.endsWith(br);
  const body = ends ? text.slice(0, text.length - br.length) : text;
  return { br, lines: body === '' ? [''] : body.split(br), ends };
}

function joinFile(br: string, lines: string[], ends: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (ends ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Move = [string, string];
type Edit = (tree: Tree, moves: Move[]) => void;

// ---------------------------------------------------------------- section 5: matching

function lineEq(o: string, f: string, tier: number): boolean {
  if (tier === 0) return o === f;
  if (tier === 1) return stripTrail(o) === stripTrail(f);
  return stripBoth(o) === stripBoth(f);
}

interface Match {
  tier: number;
  positions: number[];
}

function findMatches(lines: string[], O: string[], strict: boolean, filter?: (pos: number) => boolean): Match | null {
  const top = strict ? 1 : 3;
  for (let t = 0; t < top; t += 1) {
    const positions: number[] = [];
    for (let pos = 0; pos + O.length <= lines.length; pos += 1) {
      if (filter !== undefined && !filter(pos)) continue;
      let ok = true;
      for (let i = 0; i < O.length; i += 1) {
        if (!lineEq(O[i]!, lines[pos + i]!, t)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(pos);
    }
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** Re-indent one line of N at tier 2 (SPEC.md section 5). */
function reindentLine(s: string, P: string, F: string): string {
  if (s.trim() === '') return s;
  if (!s.startsWith(P)) return s;
  return F + s.slice(P.length);
}

/** The new lines a hunk/chunk body writes, from the file's own matched lines and the patch's. */
function buildOut(body: { t: string; text: string }[], lines: string[], pos: number, tier: number, O: string[]): string[] {
  const F = leadWs(lines[pos]!);
  const P = leadWs(O[0]!);
  const out: string[] = [];
  let q = 0;
  for (const b of body) {
    if (b.t === '\\') continue;
    if (b.t === ' ') {
      out.push(lines[pos + q]!);
      q += 1;
    } else if (b.t === '-') {
      q += 1;
    } else {
      out.push(tier === 2 ? reindentLine(b.text, P, F) : b.text);
    }
  }
  return out;
}

/** The new lines when O is empty: the patch's context and + lines as they are. */
function buildOutEmpty(body: { t: string; text: string }[]): string[] {
  return body.filter((b) => b.t !== '\\').map((b) => b.text);
}

// ---------------------------------------------------------------- section 6: unified diffs

interface UBody {
  t: string;
  text: string;
}
interface UHunk {
  a: number;
  body: UBody[];
  noNewline: boolean;
}
interface USection {
  old: string | null;
  newp: string | null;
  dOld: string;
  dNew: string;
  sawDiff: boolean;
  headerDone: boolean;
  create: boolean;
  del: boolean;
  hunks: UHunk[];
}

const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

function uPath(l: string): { p: string | null; d: string } {
  let t = l.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return { p: null, d: t };
  return { p: stripAB(t), d: stripAB(t) };
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let sec: USection | null = null;
  let hunk: UHunk | null = null;
  const flushHunk = (): void => {
    if (hunk === null || sec === null) {
      hunk = null;
      return;
    }
    while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.t === ' ' && hunk.body[hunk.body.length - 1]!.text === '') hunk.body.pop();
    let lastCp = -1;
    for (let k = 0; k < hunk.body.length; k += 1) if (hunk.body[k]!.t === ' ' || hunk.body[k]!.t === '+') lastCp = k;
    hunk.noNewline = lastCp >= 0 && lastCp + 1 < hunk.body.length && hunk.body[lastCp + 1]!.t === '\\';
    sec.hunks.push(hunk);
    hunk = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      flushHunk();
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = { old: null, newp: null, dOld: m[1]!, dNew: m[2]!, sawDiff: true, headerDone: false, create: false, del: false, hunks: [] };
      sections.push(sec);
      continue;
    }
    if (hunk !== null) {
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        flushHunk();
      } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
        hunk.body.push(l === '' ? { t: ' ', text: '' } : { t: l[0]!, text: l.slice(1) });
        continue;
      } else {
        flushHunk();
      }
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      flushHunk();
      if (sec === null || sec.headerDone || sec.hunks.length > 0) {
        sec = { old: null, newp: null, dOld: '', dNew: '', sawDiff: false, headerDone: false, create: false, del: false, hunks: [] };
        sections.push(sec);
      }
      const o = uPath(l);
      sec.old = o.p;
      sec.dOld = o.d;
      const nw = uPath(lines[i + 1]!);
      sec.newp = nw.p;
      sec.dNew = nw.d;
      sec.headerDone = true;
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null || sec === null) throw new Exit2(`error: parse ${i + 1}`);
      flushHunk();
      hunk = { a: parseInt(m[1]!, 10), body: [], noNewline: false };
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) {
        sec.old = l.slice(12);
        sec.dOld = l.slice(12);
        continue;
      }
      if (l.startsWith('rename to ')) {
        sec.newp = l.slice(10);
        sec.dNew = l.slice(10);
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.create = true;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.del = true;
        continue;
      }
    }
  }
  flushHunk();
  return sections;
}

/** Apply one section's hunks to a file's text; throws Fail with the section's path. */
function applyHunks(text: string, hunks: UHunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let lines = f.lines;
  let ends = f.ends;
  let d = 0;
  for (const hunk of hunks) {
    const O: string[] = [];
    let plus = 0;
    let minus = 0;
    for (const b of hunk.body) {
      if (b.t === '\\') continue;
      if (b.t === ' ') O.push(b.text);
      else if (b.t === '-') {
        O.push(b.text);
        minus += 1;
      } else plus += 1;
    }
    let pos: number;
    let out: string[];
    if (O.length > 0) {
      const m = findMatches(lines, O, strict);
      if (m === null) throw new Fail('no-match', path);
      const target = hunk.a - 1 + d;
      pos = m.positions[0]!;
      for (const p of m.positions) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      out = buildOut(hunk.body, lines, pos, m.tier, O);
    } else {
      pos = Math.min(hunk.a + d, lines.length);
      out = buildOutEmpty(hunk.body);
    }
    const atEOF = O.length > 0 ? pos + O.length === lines.length : pos === lines.length && out.length > 0;
    lines = [...lines.slice(0, pos), ...out, ...lines.slice(pos + O.length)];
    if (atEOF) ends = !hunk.noNewline;
    d += plus - minus;
  }
  return joinFile(f.br, lines, ends);
}

function unifiedEdits(sections: USection[], strict: boolean): Edit[] {
  return sections.map((sec) => {
    const checkSafe = (p: string | null, d: string): void => {
      if (p === null || !safe(p)) throw new Fail('unsafe', d);
    };
    return (tree: Tree, moves: Move[]): void => {
      const op = sec.old ?? (sec.sawDiff ? sec.dOld : null);
      const np = sec.newp ?? (sec.sawDiff ? sec.dNew : null);
      if (sec.create || (op === null && np !== null)) {
        checkSafe(np, sec.dNew || np || '');
        const p = np!;
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        let lastHunk = -1;
        let lastIdx = -1;
        sec.hunks.forEach((h, hi) => {
          h.body.forEach((b, bi) => {
            if (b.t === '+') {
              plus.push(b.text);
              lastHunk = hi;
              lastIdx = bi;
            }
          });
        });
        let noNl = false;
        if (lastHunk >= 0) {
          const body = sec.hunks[lastHunk]!.body;
          noNl = lastIdx + 1 < body.length && body[lastIdx + 1]!.t === '\\';
        }
        tree.now.set(p, joinFile('\n', plus, plus.length > 0 && !noNl));
      } else if (sec.del || np === null) {
        checkSafe(op, sec.dOld || op || '');
        const p = op!;
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      } else if (op !== np) {
        checkSafe(op, sec.dOld);
        checkSafe(np, sec.dNew);
        if (tree.get(op!) === null) throw new Fail('missing', op!);
        if (tree.get(np!) !== null) throw new Fail('exists', np!);
        const content = applyHunks(tree.get(op!)!, sec.hunks, strict, op!);
        tree.now.set(op!, null);
        tree.now.set(np!, content);
        moves.push([op!, np!]);
      } else {
        checkSafe(op, sec.dOld);
        if (tree.get(op!) === null) throw new Fail('missing', op!);
        tree.now.set(op!, applyHunks(tree.get(op!)!, sec.hunks, strict, op!));
      }
    };
  });
}

// ---------------------------------------------------------------- section 7: SEARCH/REPLACE

interface SRBlock {
  path: string;
  old: string[];
  new: string[];
}

function parseSR(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevPath: string | null = null;
  let after = -1; // index of the previous block's REPLACE line
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    let path: string | null = null;
    for (let j = i - 1; j > after; j -= 1) {
      const l = lines[j]!;
      if (blank(l) || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    let eq = -1;
    let gt = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${i + 1}`);
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        gt = j;
        break;
      }
    }
    if (gt < 0) throw new Exit2(`error: parse ${i + 1}`);
    blocks.push({ path, old: lines.slice(i + 1, eq), new: lines.slice(eq + 1, gt) });
    prevPath = path;
    after = gt;
    i = gt;
  }
  return blocks;
}

function srEdits(blocks: SRBlock[], strict: boolean): Edit[] {
  return blocks.map((b) => {
    return (tree: Tree): void => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.old.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.new.length === 0 ? '' : `${b.new.join('\n')}\n`);
        return;
      }
      const text = tree.get(b.path);
      if (text === null) throw new Fail('missing', b.path);
      const f = splitFile(text);
      const m = findMatches(f.lines, b.old, strict);
      if (m === null) throw new Fail('no-match', b.path);
      if (m.positions.length > 1) throw new Fail('ambiguous', b.path);
      const pos = m.positions[0]!;
      const out = b.new.map((s) => (m.tier === 2 ? reindentLine(s, leadWs(b.old[0]!), leadWs(f.lines[pos]!)) : s));
      f.lines.splice(pos, b.old.length, ...out);
      tree.now.set(b.path, joinFile(f.br, f.lines, f.ends));
    };
  });
}

// ---------------------------------------------------------------- section 8: V4A

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: { t: string; text: string }[];
}
interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: VChunk[];
  open: VChunk | null;
  first: boolean;
  moveToSet: boolean;
  blanks: number;
}

function closeChunk(v: VSection): void {
  if (v.open === null) return;
  while (v.open.body.length > 0 && v.open.body[v.open.body.length - 1]!.t === ' ' && v.open.body[v.open.body.length - 1]!.text === '') v.open.body.pop();
  v.chunks.push(v.open);
  v.open = null;
}

function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => blank(l) === false);
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last === first || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  const close = (): void => {
    if (cur === null) return;
    if (cur.kind === 'add') {
      while (cur.blanks > 0 && cur.lines.length > 0) {
        cur.lines.pop();
        cur.blanks -= 1;
      }
    } else if (cur.kind === 'upd') {
      closeChunk(cur);
    }
    sections.push(cur);
    cur = null;
  };
  for (let i = first + 1; i < last; i += 1) {
    const l = lines[i]!;
    if (blank(l)) {
      if (cur !== null && cur.kind === 'add') {
        cur.lines.push('');
        cur.blanks += 1;
      } else if (cur !== null && cur.kind === 'upd' && cur.open !== null) cur.open.body.push({ t: ' ', text: '' });
      continue;
    }
    if (cur !== null && cur.kind === 'add') cur.blanks = 0;
    if (l.startsWith('*** Add File: ')) {
      close();
      cur = { kind: 'add', path: l.slice(14).trim(), moveTo: null, lines: [], chunks: [], open: null, first: true, moveToSet: false, blanks: 0 };
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      close();
      cur = { kind: 'del', path: l.slice(17).trim(), moveTo: null, lines: [], chunks: [], open: null, first: true, moveToSet: false, blanks: 0 };
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      close();
      cur = { kind: 'upd', path: l.slice(17).trim(), moveTo: null, lines: [], chunks: [], open: null, first: true, moveToSet: false, blanks: 0 };
      continue;
    }
    if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
    if (cur.kind === 'add') {
      if (l.startsWith('+')) cur.lines.push(l.slice(1));
      else throw new Exit2(`error: parse ${i + 1}`);
      continue;
    }
    if (cur.kind === 'del') throw new Exit2(`error: parse ${i + 1}`);
    if (l.startsWith('*** Move to: ') && !cur.moveToSet && cur.chunks.length === 0 && cur.open === null) {
      cur.moveTo = l.slice(13).trim();
      cur.moveToSet = true;
      continue;
    }
    if (l.trim() === '*** End of File') {
      if (cur.open === null) throw new Exit2(`error: parse ${i + 1}`);
      cur.open.eof = true;
      closeChunk(cur);
      cur.first = false;
      continue;
    }
    if (l.startsWith('@@')) {
      closeChunk(cur);
      cur.first = false;
      const a = l.slice(2).trim();
      cur.open = { anchor: a === '' ? null : a, eof: false, body: [] };
      continue;
    }
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur.open === null) {
        if (!cur.first) throw new Exit2(`error: parse ${i + 1}`);
        cur.open = { anchor: null, eof: false, body: [] };
      }
      cur.open.body.push({ t: l[0]!, text: l.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  close();
  return sections;
}

function v4aEdits(sections: VSection[], strict: boolean): Edit[] {
  return sections.map((sec) => {
    const checkSafe = (p: string): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
    };
    return (tree: Tree, moves: Move[]): void => {
      if (sec.kind === 'add') {
        checkSafe(sec.path);
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        tree.now.set(sec.path, sec.lines.length === 0 ? '' : `${sec.lines.join('\n')}\n`);
        return;
      }
      if (sec.kind === 'del') {
        checkSafe(sec.path);
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
        return;
      }
      checkSafe(sec.path);
      const text = tree.get(sec.path);
      if (text === null) throw new Fail('missing', sec.path);
      if (sec.moveTo !== null) {
        checkSafe(sec.moveTo);
        if (tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
      }
      const f = splitFile(text);
      let lines = f.lines;
      let cursor = 0;
      for (const chunk of sec.chunks) {
        if (chunk.anchor !== null) {
          let idx = -1;
          const top = strict ? 1 : 3;
          for (let t = 0; t < top && idx < 0; t += 1) {
            for (let j = cursor; j < lines.length; j += 1) {
              if (lineEq(chunk.anchor, lines[j]!, t)) {
                idx = j;
                break;
              }
            }
          }
          if (idx < 0) throw new Fail('no-match', sec.path);
          cursor = idx + 1;
        }
        const O: string[] = [];
        for (const b of chunk.body) {
          if (b.t === ' ' || b.t === '-') O.push(b.text);
        }
        if (O.length > 0) {
          const m = findMatches(lines, O, strict, (pos) => pos >= cursor && (!chunk.eof || pos + O.length === lines.length));
          if (m === null) throw new Fail('no-match', sec.path);
          const pos = m.positions[0]!;
          const out = buildOut(chunk.body, lines, pos, m.tier, O);
          lines = [...lines.slice(0, pos), ...out, ...lines.slice(pos + O.length)];
          cursor = pos + out.length;
        } else {
          const at = chunk.eof ? lines.length : cursor;
          const out = buildOutEmpty(chunk.body);
          lines = [...lines.slice(0, at), ...out, ...lines.slice(at)];
          cursor = at + out.length;
        }
      }
      const content = joinFile(f.br, lines, f.ends);
      if (sec.moveTo !== null) {
        tree.now.set(sec.path, null);
        tree.now.set(sec.moveTo, content);
        moves.push([sec.path, sec.moveTo]);
      } else {
        tree.now.set(sec.path, content);
      }
    };
  });
}

// ---------------------------------------------------------------- section 9: JSON edits

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------- sections 1, 2, 4, 10

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(parseUnified(lines), strict);
    else if (kind === 'search-replace') edits = srEdits(parseSR(lines), strict);
    else if (kind === 'v4a') edits = v4aEdits(parseV4a(lines), strict);
    else edits = [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const moves: Move[] = [];
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const used = new Set<string>();
  for (const [o, n] of moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      used.add(o);
      used.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (used.has(p)) continue;
    const was = tree.original(p);
    const now = tree.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  out.push(`ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`);
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
