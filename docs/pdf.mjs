const vendor = new URL('./vendor/pdfjs/', import.meta.url);
const asset = path => new URL(path, vendor).href;
let pdfjs;
const loadingTasks = new WeakMap();

export async function openPdf(bytes) {
  const lib = await (pdfjs ??= import('./vendor/pdfjs/legacy/build/pdf.min.mjs'));
  lib.GlobalWorkerOptions.workerSrc = asset('legacy/build/pdf.worker.min.mjs');
  const task = lib.getDocument({
    data: bytes.slice(), isEvalSupported: false, cMapUrl: asset('cmaps/'), cMapPacked: true,
    standardFontDataUrl: asset('standard_fonts/'), wasmUrl: asset('wasm/'), iccUrl: asset('iccs/'),
  });
  try {
    const doc = await task.promise;
    loadingTasks.set(doc, task);
    return doc;
  }
  catch (error) { await task.destroy().catch(() => {}); throw error; }
}

export async function closePdf(doc) {
  const task = loadingTasks.get(doc);
  if (!task) return;
  loadingTasks.delete(doc);
  await task.destroy();
}

export const rotationOf = page => ((page.rotation + (page.proxy?.rotate ?? 0)) % 360 + 360) % 360;

export function viewOf(page, rotation = rotationOf(page), scale = 1) {
  if (page.proxy) return page.proxy.getViewport({ rotation, scale });
  const { width: w, height: h } = page;
  const [a,b,c,d,e,f] = ({ 0: [1,0,0,-1,0,h], 90: [0,1,1,0,0,0], 180: [-1,0,0,1,w,0], 270: [0,-1,-1,0,h,w] })[rotation];
  const swapped = rotation % 180 !== 0;
  return {
    width: (swapped ? h : w) * scale, height: (swapped ? w : h) * scale,
    convertToViewportPoint: (x,y) => [(a*x+c*y+e)*scale, (b*x+d*y+f)*scale],
    convertToPdfPoint(x,y) {
      const dx = x/scale-e, dy = y/scale-f;
      return [(d*dx-c*dy)/(a*d-b*c), (a*dy-b*dx)/(a*d-b*c)];
    },
  };
}

export const mapPoint = (from, to, x, y) => to.convertToViewportPoint(...from.convertToPdfPoint(x,y));

export function viewMatrix(from, to) {
  const [x,y] = mapPoint(from,to,0,0);
  const [ax,ay] = mapPoint(from,to,1,0);
  const [bx,by] = mapPoint(from,to,0,1);
  return [ax-x,ay-y,bx-x,by-y,x,y].map(value => +value.toFixed(8));
}

export function paintPage(page, canvas, scale, pixelRatio = 1, paintContent) {
  const viewport = viewOf(page, rotationOf(page), scale);
  const ratio = Math.min(pixelRatio, 4096 / Math.max(viewport.width, viewport.height));
  canvas.width = Math.max(1, Math.ceil(viewport.width * ratio));
  canvas.height = Math.max(1, Math.ceil(viewport.height * ratio));
  if (paintContent) {
    paintContent();
    return null;
  }
  if (!page.proxy) {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    return null;
  }
  return page.proxy.render({ canvas, viewport, transform: ratio === 1 ? null : [ratio,0,0,ratio,0,0] });
}

const color = hex => globalThis.PDFLib.rgb(...[1,3,5].map(i => parseInt(hex.slice(i,i+2),16)/255));
export const BASELINE = .8;
export const LINE_HEIGHT = 1.24;

export async function validateText(value) {
  // PDF's built-in Helvetica uses WinAnsi. Detect unsupported text before an edit is recorded.
  const { PDFDocument, StandardFonts } = globalThis.PDFLib;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const line of value.split('\n')) font.encodeText(line);
}

function drawMark(pdfPage, page, mark, font) {
  const { rgb, degrees, BlendMode, pushGraphicsState, popGraphicsState, setStrokingColor,
    setLineWidth, setLineCap, setLineJoin, moveTo, lineTo, stroke } = globalThis.PDFLib;
  const view = viewOf(page, mark.angle);
  const toPdf = (x,y) => view.convertToPdfPoint(x,y);
  const [zx,zy] = toPdf(0,0), [ux,uy] = toPdf(1,0);
  const unit = Math.hypot(ux-zx,uy-zy);
  const tint = color(mark.color);
  if (mark.type === 'text') {
    const [x,y] = toPdf(mark.x,mark.y+mark.size*BASELINE);
    pdfPage.drawText(mark.value, { x, y, size: mark.size*unit, lineHeight: mark.size*unit*LINE_HEIGHT,
      font, color: tint, rotate: degrees(Math.atan2(uy-zy,ux-zx)*180/Math.PI) });
    return;
  }
  if (mark.type === 'ink') {
    const [start,...rest] = mark.points.map(([x,y]) => toPdf(x,y));
    if (!rest.length) {
      pdfPage.drawCircle({ x:start[0], y:start[1], size:mark.size*unit/2, color:tint });
      return;
    }
    pdfPage.pushOperators(pushGraphicsState(), setStrokingColor(tint), setLineWidth(mark.size*unit),
      setLineCap(1), setLineJoin(1), moveTo(...start), ...rest.map(p => lineTo(...p)), stroke(), popGraphicsState());
    return;
  }
  const [ax,ay] = toPdf(mark.x,mark.y), [bx,by] = toPdf(mark.x+mark.w,mark.y+mark.h);
  const box = { x:Math.min(ax,bx), y:Math.min(ay,by), width:Math.abs(bx-ax), height:Math.abs(by-ay) };
  if (mark.type === 'highlight') pdfPage.drawRectangle({ ...box, color:tint, opacity:.46, blendMode:BlendMode.Multiply });
  if (mark.type === 'shape') pdfPage.drawRectangle({ ...box, color:undefined, borderColor:tint, borderWidth:mark.size*unit });
  if (mark.type === 'whiteout') pdfPage.drawRectangle({ ...box, color:rgb(1,1,1) });
}

export async function exportPdf(bytes, pages) {
  const { PDFDocument, StandardFonts, PDFName, degrees } = globalThis.PDFLib;
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const original = doc.getPages();
  const font = pages.some(page => page.marks.some(mark => mark.type === 'text')) ? await doc.embedFont(StandardFonts.Helvetica) : null;
  const prefix = pages.findIndex((page, i) => page.source !== i);
  const keep = prefix < 0 ? pages.length : prefix;
  // A moved page may be reinserted under a different parent in the PDF page tree.
  for (const page of pages.slice(keep)) {
    if (page.source === null) continue;
    const node = original[page.source].node;
    for (const name of ['Resources','MediaBox','CropBox','Rotate']) {
      const key = PDFName.of(name), value = node.getInheritableAttribute(key);
      if (value && !node.has(key)) node.set(key, value);
    }
  }
  // Reuse the page objects so their streams, fonts, and page references survive reordering.
  for (let i = original.length-1; i >= keep; i--) doc.removePage(i);
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const target = i < keep ? original[i] : doc.insertPage(i, page.source === null ? [page.width,page.height] : original[page.source]);
    if (page.rotation) target.setRotation(degrees(rotationOf(page)));
    for (const mark of page.marks) drawMark(target, page, mark, font);
  }
  return await doc.save({ updateFieldAppearances: false });
}

export async function makeSample() {
  const { PDFDocument, StandardFonts } = globalThis.PDFLib;
  const doc = await PDFDocument.create();
  doc.setTitle('Field Notes — Paperwork sample');
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const green = color('#23684f'), charcoal = color('#202d25'), muted = color('#53665c');
  for (const [index, title] of ['Field Notes','Make it yours'].entries()) {
    const page = doc.addPage([612,792]);
    const text = (str,x,y,size,font=regular,tint=charcoal) => page.drawText(str,{x,y,size,font,color:tint});
    page.drawRectangle({x:0,y:782,width:612,height:10,color:green});
    text('PAPERWORK  /  SAMPLE DOCUMENT',56,721,10,bold,green);
    text(title,54,660,46,bold);
    text(index ? 'A second page for trying the page controls.' : 'A small workspace for big ideas.',56,626,15,regular,muted);
    page.drawRectangle({x:55,y:476,width:502,height:114,color:color('#edf5ef')});
    text(index ? 'ORGANIZE YOUR PAGES' : 'TRY AN EDIT',73,559,10,bold,green);
    text(index ? 'Rotate this page, move it earlier, or add a blank page.' : 'Highlight this line, add a note, or draw in the space below.',73,530,12);
    text('When you are ready, download a copy to keep your changes.',73,508,12,regular,muted);
    text('NOTES',56,436,10,bold,green);
    for (let y=407; y>=151; y-=32) page.drawLine({start:{x:56,y},end:{x:556,y},thickness:.7,color:color('#d9e3db')});
    text('SAMPLE PDF',56,54,9,bold,muted);
    text(`0${index+1}  /  02`,510,54,9,regular,muted);
  }
  return await doc.save();
}
