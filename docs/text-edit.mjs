const wasmUrl = new URL('./vendor/pdfium/dist/pdfium.wasm', import.meta.url);
const fallbackUrl = new URL('./vendor/noto/NotoSans-Regular.ttf', import.meta.url);
const textDecoder = new TextDecoder('utf-16le');
const TEXT_OBJECT = 1;
const FILL_TEXT = 0;
const NON_INCREMENTAL = 2;
const TRUETYPE = 2;
const RENDER_ANNOTATIONS = 1;
const REVERSE_BYTE_ORDER = 16;
let enginePromise;

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Could not load the text editing tools.');
  return response.arrayBuffer();
}

export function loadTextEngine() {
  enginePromise ??= Promise.all([
    import('./vendor/pdfium/dist/index.browser.js'), fetchBytes(wasmUrl), fetchBytes(fallbackUrl),
  ])
    .then(async ([{ init }, wasmBinary, font]) => {
      const engine = await init({ wasmBinary });
      engine.PDFiumExt_Init();
      return { engine, fallback: new Uint8Array(font) };
    }).catch(error => {
      enginePromise = undefined;
      throw error;
    });
  return enginePromise;
}

function withBuffer(engine, length, use) {
  const { malloc, free } = engine.pdfium.wasmExports;
  const pointer = malloc(length);
  if (!pointer) throw new Error('The PDF is too large to edit in this browser.');
  try { return use(pointer); }
  finally { free(pointer); }
}

function withDocument(engine, bytes, use) {
  return withBuffer(engine, bytes.length, pointer => {
    engine.pdfium.HEAPU8.set(bytes, pointer);
    const doc = engine.FPDF_LoadMemDocument(pointer, bytes.length, '');
    if (!doc) throw new Error('This PDF could not be opened for text editing.');
    try { return use(doc); }
    finally { engine.FPDF_CloseDocument(doc); }
  });
}

function withPage(engine, doc, index, use) {
  const page = engine.FPDF_LoadPage(doc, index);
  if (!page) throw new Error('This page could not be opened for text editing.');
  try { return use(page); }
  finally { engine.FPDF_ClosePage(page); }
}

function withTextPage(engine, page, use) {
  const textPage = engine.FPDFText_LoadPage(page);
  if (!textPage) throw new Error('Could not read text on this page.');
  try { return use(textPage); }
  finally { engine.FPDFText_ClosePage(textPage); }
}

function objectText(engine, object, textPage) {
  const length = engine.FPDFTextObj_GetText(object, textPage, 0, 0);
  if (length <= 2) return '';
  return withBuffer(engine, length, pointer => {
    engine.FPDFTextObj_GetText(object, textPage, pointer, length);
    return textDecoder.decode(engine.pdfium.HEAPU8.subarray(pointer, pointer + length - 2));
  });
}

function geometry(engine, object, pointer) {
  if (!engine.FPDFPageObj_GetRotatedBounds(object, pointer)) return null;
  const read = offset => engine.pdfium.getValue(pointer + offset, 'float');
  const corners = [0, 8, 16, 24].map(offset => [read(offset), read(offset + 4)]);
  if (corners.flat().some(n => !Number.isFinite(n))) return null;
  if (!engine.FPDFPageObj_GetMatrix(object, pointer)) return null;
  const origin = [read(16), read(20)];
  return { corners, origin };
}

function textRuns(engine, page) {
  return withTextPage(engine, page, textPage => withBuffer(engine, 32, pointer => {
    const runs = [];
    const count = engine.FPDFPage_CountObjects(page);
    for (let index = 0; index < count; index++) {
      const object = engine.FPDFPage_GetObject(page, index);
      if (engine.FPDFPageObj_GetType(object) !== TEXT_OBJECT) continue;
      // Invisible text often belongs to a scan's OCR layer.
      if (engine.FPDFTextObj_GetTextRenderMode(object) !== FILL_TEXT) continue;
      if (!engine.FPDFPageObj_GetIsActive(object, pointer) || !engine.pdfium.getValue(pointer, 'i32')) continue;
      const value = objectText(engine, object, textPage);
      if (!value.trim() || /[\r\n\0]/.test(value)) continue;
      const position = geometry(engine, object, pointer);
      if (position) runs.push({ index, value, ...position });
    }
    return runs;
  }));
}

export function listTextRuns({ engine }, bytes, source) {
  return withDocument(engine, bytes, doc => withPage(engine, doc, source, page => textRuns(engine, page)));
}

function hasGlyphs(engine, font, value) {
  return font && [...value].every(char => char === ' ' ||
    (char.codePointAt(0) <= 0xffff && engine.FPDFFont_GetGlyphPath(font, char.codePointAt(0), 12)));
}

function setObjectText(engine, object, value) {
  const length = 2 * (value.length + 1);
  return withBuffer(engine, length, pointer => {
    engine.pdfium.stringToUTF16(value, pointer, length);
    return engine.FPDFText_SetText(object, pointer);
  });
}

function useFallback({ engine, fallback }, doc, page, object, edit) {
  // A replacement object must not discard clipping or marked content attached to the original.
  const clip = engine.FPDFPageObj_GetClipPath(object);
  if (engine.FPDFPageObj_CountMarks(object) || (clip && engine.FPDFClipPath_CountPaths(clip) > 0)) {
    throw new Error('The original font can’t write that text and this run can’t safely use a fallback font.');
  }
  const font = withBuffer(engine, fallback.length, pointer => {
    engine.pdfium.HEAPU8.set(fallback, pointer);
    return engine.FPDFText_LoadFont(doc, pointer, fallback.length, TRUETYPE, true);
  });
  if (!font) throw new Error('Could not load the fallback font.');
  try {
    if (!hasGlyphs(engine, font, edit.value)) {
      throw new Error('Some characters are unavailable in the original font and in Noto Sans.');
    }
    withBuffer(engine, 44, pointer => {
      if (!engine.FPDFTextObj_GetFontSize(object, pointer + 24) ||
          !engine.FPDFPageObj_GetMatrix(object, pointer) ||
          !engine.FPDFPageObj_GetFillColor(object, pointer + 28, pointer + 32, pointer + 36, pointer + 40)) {
        throw new Error('Could not preserve the appearance of the original text.');
      }
      const rgba = [28, 32, 36, 40].map(offset => engine.pdfium.getValue(pointer + offset, 'i32'));
      const size = engine.pdfium.getValue(pointer + 24, 'float');
      const replacement = engine.FPDFPageObj_CreateTextObj(doc, font, size);
      if (!replacement) throw new Error('Could not create the replacement text.');
      let inserted = false;
      try {
        if (!setObjectText(engine, replacement, edit.value) ||
            !engine.FPDFPageObj_SetMatrix(replacement, pointer) ||
            !engine.FPDFPageObj_SetFillColor(replacement, ...rgba) ||
            !engine.FPDFPage_RemoveObject(page, object)) {
          throw new Error('Could not replace this text run.');
        }
        engine.FPDFPageObj_Destroy(object);
        inserted = engine.FPDFPage_InsertObjectAtIndex(page, replacement, edit.index);
        if (!inserted) throw new Error('Could not place the replacement text.');
      } finally {
        if (!inserted) engine.FPDFPageObj_Destroy(replacement);
      }
    });
  } finally {
    engine.FPDFFont_Close(font);
  }
}

function applyTextEdits(runtime, doc, page, edits) {
  const { engine } = runtime;
  // Check each target against the original source before mutating the page.
  const originals = new Map(textRuns(engine, page).map(run => [run.index, run]));
  for (const edit of edits) {
    if (originals.get(edit.index)?.value !== edit.original) throw new Error('The original text run has changed.');
    const object = engine.FPDFPage_GetObject(page, edit.index);
    const font = engine.FPDFTextObj_GetFont(object);
    if (hasGlyphs(engine, font, edit.value) && setObjectText(engine, object, edit.value) &&
        withTextPage(engine, page, textPage => objectText(engine, object, textPage)) === edit.value) continue;
    useFallback(runtime, doc, page, object, edit);
  }
  if (!engine.FPDFPage_GenerateContent(page)) throw new Error('Could not write the edited page.');
}

function saveDocument(engine, doc) {
  const writer = engine.PDFiumExt_OpenFileWriter();
  if (!writer) throw new Error('Could not start PDF export.');
  try {
    if (!engine.FPDF_SaveAsCopy(doc, writer, NON_INCREMENTAL)) throw new Error('Could not save the edited PDF.');
    const length = engine.PDFiumExt_GetFileWriterSize(writer);
    if (!length) throw new Error('The edited PDF is empty.');
    return withBuffer(engine, length, pointer => {
      engine.PDFiumExt_GetFileWriterData(writer, pointer, length);
      return engine.pdfium.HEAPU8.slice(pointer, pointer + length);
    });
  } finally {
    engine.PDFiumExt_CloseFileWriter(writer);
  }
}

export function rewriteText(runtime, bytes, pages) {
  const edited = pages.filter(page => page.textEdits?.length);
  if (!edited.length) return bytes;
  const { engine } = runtime;
  const output = withDocument(engine, bytes, doc => {
    for (const { source, textEdits } of edited) {
      withPage(engine, doc, source, page => applyTextEdits(runtime, doc, page, textEdits));
    }
    return saveDocument(engine, doc);
  });
  // Reopen the actual saved file, since a successful SetText does not guarantee readable text.
  withDocument(engine, output, doc => {
    for (const { source, textEdits } of edited) {
      withPage(engine, doc, source, page => {
        const runs = textRuns(engine, page);
        for (const edit of textEdits) {
          const matches = runs.filter(run => Math.hypot(run.origin[0]-edit.origin[0], run.origin[1]-edit.origin[1]) < .1);
          if (!matches.some(run => run.value === edit.value) || matches.some(run => run.value === edit.original)) {
            throw new Error('The replacement could not be verified in the saved PDF.');
          }
        }
      });
    }
  });
  return output;
}

export function paintEditedPage(runtime, bytes, model, canvas) {
  const { engine } = runtime;
  const { width, height } = canvas;
  withDocument(engine, bytes, doc => withPage(engine, doc, model.source, page => {
    applyTextEdits(runtime, doc, page, model.textEdits);
    const bitmap = engine.FPDFBitmap_Create(width, height, 1);
    if (!bitmap) throw new Error('Could not allocate a preview for this page.');
    try {
      engine.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
      engine.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, model.rotation / 90,
        RENDER_ANNOTATIONS | REVERSE_BYTE_ORDER);
      const pointer = engine.FPDFBitmap_GetBuffer(bitmap);
      const pixels = new Uint8ClampedArray(engine.pdfium.HEAPU8.slice(pointer, pointer + 4 * width * height));
      canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
    } finally {
      engine.FPDFBitmap_Destroy(bitmap);
    }
  }));
}
