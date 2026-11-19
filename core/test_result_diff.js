'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { compareResults } = require('./result_diff');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-result-diff-'));
const write = (name, value) => { const file = path.join(dir, name); fs.writeFileSync(file, value); return file; };
try {
  const a = write('a.json', JSON.stringify({ n: 1, nested: { id: '001', ok: true, missing: null }, metadata: 'old' }));
  const b = write('b.json', JSON.stringify({ n: 1 + 1e-7, nested: { id: '001', ok: true, missing: null }, metadata: 'old' }));
  assert.equal(compareResults(a, b).status, 'same');
  write('b.json', JSON.stringify({ n: 2, nested: { id: '001', ok: true, missing: null }, metadata: 'old' }));
  assert.equal(compareResults(a, b).status, 'diff');
  write('b.json', JSON.stringify({ n: '1', nested: { id: '001', ok: true, missing: null }, metadata: 'old' }));
  assert.equal(compareResults(a, b).status, 'diff');
  write('b.json', JSON.stringify({ n: 1, nested: { id: '001', ok: true, missing: null }, metadata: 'new' }));
  assert.equal(compareResults(a, b).status, 'diff');
  const ignored = compareResults(a, b, { ignore_fields: ['metadata'] });
  assert.equal(ignored.status, 'same');
  assert.match(ignored.report, /metadata/);
  write('b.json', JSON.stringify({ n: 1, nested: { id: '001', ok: true } }));
  assert.equal(compareResults(a, b, { ignore_fields: ['metadata'] }).status, 'diff');
  const one = write('one.json', '{"n":1}');
  assert.equal(compareResults(one, one, { ignore_fields: ['n'] }).status, 'no_comparable');
  assert.equal(compareResults(write('empty-a.json', '{}'), write('empty-b.json', '{}')).status, 'no_comparable');
  assert.equal(compareResults(a, write('invalid.json', '{')).status, 'read_error');
  const infiniteA = write('infinite-a.json', '{"v":1e400}');
  const infiniteB = write('infinite-b.json', '{"v":1e400}');
  assert.equal(compareResults(infiniteA, infiniteB).status, 'read_error');
  assert.equal(compareResults(infiniteA, infiniteB, { ignore_fields: ['v'] }).status, 'read_error');
  assert.equal(compareResults(a, write('other.txt', 'x')).status, 'unsupported');
  assert.equal(compareResults(write('arr-a.json', '[1,2]'), write('arr-b.json', '[1,2,3]')).status, 'diff');
  assert.throws(() => compareResults(a, b, { tol: NaN }), /tol|容差/);
  assert.throws(() => compareResults(a, b, { tol: -1 }), /tol|容差/);

  const c1 = write('a.csv', '\ufeffid,value,note\r\n001,1.0000001,"hello, ""world""\r\nnext line"\r\n002,2,yes\r\n');
  const c2 = write('b.csv', 'id,value,note\n001,1,"hello, ""world""\r\nnext line"\n002,2,yes\n');
  assert.equal(compareResults(c1, c2).status, 'same');
  write('b.csv', 'id,value,note\n1,1,"hello, ""world""\nnext line"\n002,2,yes\n');
  assert.equal(compareResults(c1, c2).status, 'diff'); // 001 is an identifier
  write('b.csv', 'id,note,value\n001,"hello, ""world""\nnext line",1\n002,yes,2\n');
  assert.equal(compareResults(c1, c2).status, 'diff');
  write('b.csv', 'id,value,note\n001,1,"hello, ""world""\nnext line"\n002,2,changed\n');
  assert.equal(compareResults(c1, c2).status, 'diff');
  assert.equal(compareResults(c1, c2, { ignore_fields: ['note'] }).status, 'same');
  assert.equal(compareResults(c1, c2, { ignore_fields: ['id', 'value', 'note'] }).status, 'no_comparable');
  write('b.csv', 'id,value,note\n001,1\n');
  assert.equal(compareResults(c1, c2).status, 'read_error');
  write('b.csv', 'id,id,note\n001,1,x\n');
  assert.equal(compareResults(c1, c2).status, 'read_error');
  write('b.csv', 'id,value,note\n001,1,"unclosed\n');
  assert.equal(compareResults(c1, c2).status, 'read_error');
  assert.equal(compareResults(write('head-a.csv', 'id,value\n'), write('head-b.csv', 'id,value\n')).status, 'no_comparable');
  assert.equal(compareResults(write('blank-a.csv', ''), write('blank-b.csv', '')).status, 'read_error');

  const py = `import openpyxl, pathlib, sys
p=pathlib.Path(sys.argv[1])
def save(name, rows, extra=None):
 w=openpyxl.Workbook(); s=w.active; s.title='data'
 for row in rows: s.append(row)
 if extra:
  t=w.create_sheet('extra'); t.append(extra)
 w.save(p/name)
base=[['key','value','status'],['a',1,'ready'],['b',2,'done']]
save('same-a.xlsx',base); save('same-b.xlsx',base)
save('text-change.xlsx',[['key','value','status'],['a',1,'changed'],['b',2,'done']])
save('number-blank.xlsx',[['key','value','status'],['a',1,'ready'],['b',None,'done']])
save('extra-sheet.xlsx',base,['x',3])
save('extra-row.xlsx',base+[['c',3,'more']])
save('extra-col.xlsx',[['key','value','status','note'],['a',1,'ready','x'],['b',2,'done','y']])
dup=[['key','value','value'],['a',1,10],['a',2,20]]
save('dup-a.xlsx',dup)
save('dup-early.xlsx',[['key','value','value'],['a',9,10],['a',2,20]])
save('dup-col.xlsx',[['key','value','value'],['a',1,99],['a',2,20]])
save('bool-a.xlsx',[['key','value'],['a',True]])
save('bool-b.xlsx',[['key','value'],['a',1]])
save('formula-a.xlsx',[['key','value'],['a','=1+2']])
save('formula-b.xlsx',[['key','value'],['a','=1+3']])
`;
  const made = spawnSync('python', ['-c', py, dir], { encoding: 'utf8' });
  if (made.status !== 0) throw new Error('无法生成真实XLSX夹具：' + made.stderr);
  const x = name => path.join(dir, name);
  assert.equal(compareResults(x('same-a.xlsx'), x('same-b.xlsx')).status, 'same');
  assert.equal(compareResults(x('same-a.xlsx'), x('text-change.xlsx')).status, 'diff');
  assert.equal(compareResults(x('same-a.xlsx'), x('number-blank.xlsx')).status, 'diff');
  assert.equal(compareResults(x('same-a.xlsx'), x('extra-sheet.xlsx')).status, 'diff');
  assert.equal(compareResults(x('same-a.xlsx'), x('extra-row.xlsx')).status, 'diff');
  assert.equal(compareResults(x('same-a.xlsx'), x('extra-col.xlsx')).status, 'diff');
  assert.equal(compareResults(x('dup-a.xlsx'), x('dup-early.xlsx')).status, 'diff');
  assert.equal(compareResults(x('dup-a.xlsx'), x('dup-col.xlsx')).status, 'diff');
  assert.equal(compareResults(x('bool-a.xlsx'), x('bool-b.xlsx')).status, 'diff');
  assert.equal(compareResults(x('formula-a.xlsx'), x('formula-b.xlsx')).status, 'diff');
  assert.equal(compareResults(x('same-a.xlsx'), x('same-b.xlsx'), { ignore_fields: ['*'] }).status, 'unsupported');
  console.log('result diff: PASS');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
