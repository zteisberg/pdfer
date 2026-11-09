import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { exportPdf, makeSample, validateText } from '../docs/pdf.mjs';
import { listTextRuns, rewriteText } from '../docs/text-edit.mjs';
import { init } from '../docs/vendor/pdfium/dist/index.browser.js';

const require = createRequire(import.meta.url);
const { PDFDocument, PDFRawStream, decodePDFRawStream } = globalThis.PDFLib = require('../docs/vendor/pdf-lib.min.js');
const page = (source, rotation=0, marks=[]) => ({ source, rotation, width:612, height:792, marks });

test('export preserves source page references and writes all marks in PDF coordinates', async () => {
  const bytes = await makeSample();
  const original = await PDFDocument.load(bytes);
  const edited = page(1,90,[
    { type:'text', angle:0, x:60, y:320, size:18, color:'#17634e', value:'Verified café\nSecond line' },
    { type:'ink', angle:90, size:3, color:'#17634e', points:[[160,120],[190,131],[195,125]] },
    { type:'highlight', angle:90, x:220, y:100, w:110, h:20, color:'#ffdb4d' },
    { type:'shape', angle:0, x:40, y:60, w:90, h:20, size:3, color:'#17634e' },
    { type:'whiteout', angle:90, x:50, y:220, w:21, h:11, color:'#ffffff' },
  ]);
  const result = await PDFDocument.load(await exportPdf(bytes, [edited,page(null,270),page(0)]));
  assert.deepEqual(result.getPages().map(p=>p.getRotation().angle), [90,270,0]);
  assert.equal(result.getPage(0).ref.toString(), original.getPage(1).ref.toString());
  assert.equal(result.getPage(2).ref.toString(), original.getPage(0).ref.toString());
  const contents = result.getPage(0).node.Contents().asArray()
    .map(ref=>result.context.lookup(ref)).filter(s=>s instanceof PDFRawStream)
    .map(s=>Buffer.from(decodePDFRawStream(s).decode()).toString()).at(-1);
  assert.ok(/<566572696669656420636166E9> Tj/i.test(contents), 'text was encoded in the exported page');
  assert.ok(/1 J\s+1 j\s+120 160 m\s+131 190 l/.test(contents), 'ink used rotated PDF coordinates');
  assert.ok(/\/GS-[^ ]+ gs[\s\S]*?1 0 0 1 100 220 cm/.test(contents), 'highlight has transparency and correct placement');
  assert.ok(/1 0 0 1 40 712 cm[\s\S]*?\nh\s+S/.test(contents), 'rectangle has a stroke');
  assert.ok(/1 1 1 rg[\s\S]*?1 0 0 1 220 50 cm/.test(contents), 'whiteout has a white fill');
});

test('export removes a page and keeps the remaining original page', async () => {
  const bytes = await makeSample();
  const original = await PDFDocument.load(bytes);
  const result = await PDFDocument.load(await exportPdf(bytes,[page(1)]));
  assert.equal(result.getPageCount(),1);
  assert.equal(result.getPage(0).ref.toString(),original.getPage(1).ref.toString());
});

test('text validation rejects characters the export font cannot encode', async () => {
  await validateText('Café\nRésumé');
  await assert.rejects(()=>validateText('🦋'));
});

test('existing text is replaced in the saved PDF, including fallback glyphs and page reordering', async () => {
  const [wasmBinary, fallback] = await Promise.all([
    readFile(new URL('../docs/vendor/pdfium/dist/pdfium.wasm', import.meta.url)),
    readFile(new URL('../docs/vendor/noto/NotoSans-Regular.ttf', import.meta.url)),
  ]);
  const engine = await init({ wasmBinary });
  engine.PDFiumExt_Init();
  const runtime = { engine, fallback };
  const bytes = await makeSample();
  const runs = listTextRuns(runtime, bytes, 0);
  const title = runs.find(run => run.value === 'Field Notes');
  const subtitle = runs.find(run => run.value === 'A small workspace for big ideas.');
  const edits = [
    { index: title.index, origin: title.origin, original: title.value, value: 'Updated title' },
    { index: subtitle.index, origin: subtitle.origin, original: subtitle.value, value: 'Café, Ελληνικά, Ж' },
  ];
  const pages = [page(1), { ...page(0,90), textEdits: edits }];
  const output = await exportPdf(rewriteText(runtime, bytes, pages), pages);
  const reopened = listTextRuns(runtime, output, 1);
  assert.equal(reopened.length, runs.length);
  assert.deepEqual(reopened.find(run => run.value === edits[0].value).origin, title.origin);
  assert.deepEqual(reopened.find(run => run.value === edits[1].value).origin, subtitle.origin);
  assert.ok(reopened.some(run => run.value === 'NOTES'));
  assert.ok(reopened.every(run => run.value !== title.value && run.value !== subtitle.value));
  assert.ok(listTextRuns(runtime, output, 0).some(run => run.value === 'Make it yours'));
});
