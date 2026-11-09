import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { exportPdf, makeSample, validateText } from '../docs/pdf.mjs';

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
