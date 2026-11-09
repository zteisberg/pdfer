import './icons.mjs';
import { openPdf, closePdf, makeSample, rotationOf, viewOf, viewMatrix, mapPoint, paintPage, validateText, exportPdf, BASELINE, LINE_HEIGHT } from './pdf.mjs';
import { loadTextEngine, listTextRuns, paintEditedPage, rewriteText } from './text-edit.mjs';

const $ = id => document.getElementById(id);
const stage = $('stage'), paper = $('paper'), overlay = $('overlay'), canvas = $('pdf-canvas');
const fileInput = $('file'), tools = [...document.querySelectorAll('[data-tool]')];
const mobile = matchMedia('(max-width:540px)');
const prefs = { text:{color:'#17634e',size:18}, ink:{color:'#17634e',size:3}, highlight:{color:'#ffdb4d'}, shape:{color:'#17634e',size:3}, whiteout:{color:'#ffffff'} };
const hints = {
  select:'Click an edit to select it. Drag to move it.', text:'Click the page to place text.', ink:'Drag on the page to draw.',
  highlight:'Drag over an area to highlight it.', shape:'Drag to draw a rectangle.', whiteout:'Drag to cover an area. The original content stays in the PDF.',
};
const MIN_ZOOM=.15, MAX_ZOOM=4;
let state = { pages:[], active:null }, originalBytes, originalPages, doc, savedPages, filename, seq=0;
let undo=[], redo=[], tool='select', selected=null, zoom=null, busy=false, drag, promptText;
let renderTask, renderId=0, renderedPage, renderedScale, renderedRotation, noticeTimer, thumbsKey='';
let thumbs=new Map(), thumbObserver, unloadHandlerAttached=false;
const sourceRuns = new WeakMap();
let textRuntime, renderedTextEdits;

const current = () => state.pages.find(page => page.id === state.active);
const activeIndex = () => state.pages.findIndex(page => page.id === state.active);
const markSelected = () => current()?.marks.find(mark => mark.id === selected);
const dirty = () => !!doc && state.pages !== savedPages;
const key = () => ++seq;
const editable = () => !!doc && !busy;
const keepOnPage = (n,max) => Math.min(max,Math.max(0,n));

function notice(message, error=false, wait=4300) {
  clearTimeout(noticeTimer);
  $('notice').textContent=message; $('notice').dataset.error=error; $('notice').hidden=!message;
  if (wait && message) noticeTimer=setTimeout(() => { $('notice').hidden=true; }, wait);
}

function protectEdits(e) { e.preventDefault(); e.returnValue=''; }

function sourceTextHint(page) {
  if (!page.proxy) return 'This page has no existing text.';
  const entry = sourceRuns.get(page.proxy);
  if (entry?.error) return 'Could not read editable text on this page.';
  if (!entry?.runs) return 'Looking for editable text…';
  return entry.runs.length ? 'Click an outlined text run to edit it.' : 'No editable text found on this page.';
}

function setSidebar(open) {
  $('sidebar').hidden=!open;
  $('sidebar').parentElement.classList.toggle('sidebar-closed',!open);
  $('toggle-pages').setAttribute('aria-expanded',open);
  if (open) paintVisibleThumbs();
}
setSidebar(!mobile.matches);
mobile.addEventListener('change', () => setSidebar(!mobile.matches));

function updateControls() {
  const page=current(), index=activeIndex(), count=state.pages.length, canEdit=editable();
  $('file-name').hidden=!doc;
  if (doc) {
    $('file-name').title=filename;
    $('file-name').querySelector('span').textContent=filename+(dirty()?' •':'');
  }
  $('empty').hidden=!!doc; $('paper-wrap').hidden=!doc; $('context-bar').hidden=!doc;
  $('page-actions').hidden=!doc; $('sidebar-empty').hidden=!!doc;
  $('page-count').textContent=count;
  $('page-status').textContent=page?`Page ${index+1} of ${count}`:'No document open';
  $('sheet-label').textContent=page?`PAGE ${index+1}  /  ${count}`:'';
  for (const id of ['download','zoom-in','zoom-out','zoom-fit','rotate','add-page']) $(id).disabled=!canEdit;
  for (const id of ['open','choose','demo']) $(id).disabled=busy;
  $('prev').disabled=$('move-up').disabled=!canEdit||index<=0;
  $('next').disabled=$('move-down').disabled=!canEdit||index>=count-1;
  $('delete-page').disabled=!canEdit||count<=1;
  $('undo').disabled=!canEdit||!undo.length; $('redo').disabled=!canEdit||!redo.length;
  for (const button of tools) {
    button.disabled=!canEdit;
    const active=button.dataset.tool===tool;
    button.classList.toggle('active',active); button.setAttribute('aria-pressed',active);
  }
  overlay.dataset.tool=tool;
  const mark=markSelected(), settings=tool==='select'?mark:prefs[tool], mode=mark?.type ?? tool;
  $('tool-hint').textContent=tool==='edit-text'&&page?sourceTextHint(page):
    mark?`${({ink:'Drawing',shape:'Rectangle',text:'Text',highlight:'Highlight',whiteout:'Whiteout'})[mark.type]} selected`:hints[tool];
  $('remove-mark').hidden=!mark; $('remove-mark').disabled=!canEdit;
  $('edit-mark').hidden=mark?.type!=='text'; $('edit-mark').disabled=!canEdit;
  $('color-option').hidden=!settings?.color||mode==='whiteout'; $('color').disabled=!canEdit;
  if (settings?.color) $('color').value=settings.color;
  $('size-option').hidden=!settings?.size; $('size').disabled=!canEdit;
  if (settings?.size) {
    const sizes=mode==='text'?[10,12,14,16,18,20,24,28,32,40,48,60]:[1,2,3,5,8,12];
    if ($('size').dataset.mode!==mode) {
      $('size').replaceChildren(...sizes.map(size=>new Option(`${size} pt`,size)));
      $('size').dataset.mode=mode;
    }
    $('size-label').textContent=mode==='text'?'Size':'Stroke'; $('size').value=settings.size;
  }
  if (dirty() !== unloadHandlerAttached) {
    unloadHandlerAttached=dirty();
    if (unloadHandlerAttached) window.addEventListener('beforeunload',protectEdits);
    else window.removeEventListener('beforeunload',protectEdits);
  }
}

function refresh() {
  updateControls(); updateThumbs(); renderPage();
}

function commit(pages, active=state.active) {
  undo.push(state); if (undo.length>120) undo.shift(); redo=[];
  state={pages,active}; refresh();
}

function changePage(page) { commit(state.pages.map(p=>p.id===page.id?page:p)); }
function addMark(mark) { const page=current(); changePage({...page,marks:[...page.marks,{...mark,id:key()}]}); }
function replaceMark(mark) {
  const page=current();
  changePage({...page,marks:page.marks.map(m=>m.id===mark.id?mark:m)});
}
function deleteMark() {
  if (!editable()||!markSelected()) return;
  const page=current(), id=selected; selected=null;
  changePage({...page,marks:page.marks.filter(m=>m.id!==id)});
}

function stepHistory(back) {
  if (!editable()) return;
  const from=back?undo:redo, to=back?redo:undo;
  if (!from.length) return;
  to.push(state); state=from.pop(); selected=null; drag=null; refresh();
}

function goTo(index) {
  const page=state.pages[index];
  if (!editable()||!page||page.id===state.active) return;
  state={...state,active:page.id}; selected=null; drag=null;
  stage.scrollTo(0,0); refresh();
  thumbs.get(page.id)?.button.scrollIntoView({block:'nearest'});
}

function movePage(delta) {
  const index=activeIndex(), next=index+delta;
  if (!editable()||next<0||next>=state.pages.length) return;
  const pages=[...state.pages]; [pages[index],pages[next]]=[pages[next],pages[index]]; commit(pages);
  thumbs.get(state.active)?.button.scrollIntoView({block:'nearest'});
}

function setTool(name) {
  if (!editable()) return;
  if (name==='edit-text' && sourceRuns.get(current().proxy)?.error) sourceRuns.delete(current().proxy);
  tool=name; selected=null; drag=null; updateControls(); drawOverlay();
}

function fitScale(page) {
  const view=viewOf(page), inset=mobile.matches?32:56;
  return Math.max(.02,Math.min(1.5,(stage.clientWidth-inset)/view.width,(stage.clientHeight-68)/view.height));
}

function paintWorkspacePage(page, target, scale, pixelRatio) {
  const paintContent = page.textEdits?.length
    ? () => paintEditedPage(textRuntime, originalBytes, page, target)
    : undefined;
  return paintPage(page, target, scale, pixelRatio, paintContent);
}

function renderPage() {
  const page=current();
  if (!page) return;
  const scale=zoom??fitScale(page), rotation=rotationOf(page);
  const view=viewOf(page), width=view.width*scale, height=view.height*scale;
  paper.style.width=`${width}px`; paper.style.height=`${height}px`;
  overlay.setAttribute('viewBox',`0 0 ${view.width} ${view.height}`);
  $('zoom-value').value=`${Math.round(scale*100)}%`;
  $('zoom-in').disabled=!editable()||scale>=MAX_ZOOM;
  $('zoom-out').disabled=!editable()||scale<=MIN_ZOOM;
  drawOverlay();
  if (renderedPage===page.id&&renderedScale===scale&&renderedRotation===rotation&&renderedTextEdits===page.textEdits) return;
  renderedPage=page.id; renderedScale=scale; renderedRotation=rotation;
  renderedTextEdits=page.textEdits;
  const id=++renderId;
  const oldTask=renderTask;
  if (oldTask) oldTask.cancel();
  // Wait for the canceled render to release the canvas before reusing it.
  Promise.resolve(oldTask?.promise).catch(()=>{}).then(async()=>{
    if (id!==renderId) return;
    try {
      renderTask=paintWorkspacePage(page,canvas,scale,Math.min(2,devicePixelRatio||1));
      await renderTask?.promise;
    } catch(error) {
      if (error.name!=='RenderingCancelledException'&&id===renderId) {
        renderedPage=null;
        notice('This page couldn’t be displayed.',true);
        console.error(error);
      }
    } finally { if (id===renderId) renderTask=null; }
  });
}

function setZoom(scale) {
  if (!editable()) return;
  zoom=scale===null?null:Math.max(MIN_ZOOM,Math.min(MAX_ZOOM,scale));
  if (zoom===null) stage.scrollTo(0,0);
  renderPage();
}

const el = (name, attrs={}) => {
  const node=document.createElementNS('http://www.w3.org/2000/svg',name);
  for (const [prop,value] of Object.entries(attrs)) node.setAttribute(prop,value);
  return node;
};

function svgMark(mark, page, view, interactive=false) {
  const transform=mark.angle===rotationOf(page)?null:viewMatrix(viewOf(page,mark.angle),view);
  const group=el('g',transform?{transform:`matrix(${transform.join(' ')})`}:{});
  if (interactive&&mark.id) group.dataset.mark=mark.id;
  const {x,y,w,h,color,size,points}=mark;
  if (mark.type==='text') {
    const text=el('text',{fill:color,'font-size':size,'font-family':'Arial, Helvetica, sans-serif','xml:space':'preserve'});
    mark.value.split('\n').forEach((line,index)=>{
      const span=el('tspan',{x,y:y+size*(BASELINE+index*LINE_HEIGHT)});
      span.textContent=line||' '; text.append(span);
    });
    if (interactive) text.style.pointerEvents='bounding-box';
    group.append(text);
  } else if (mark.type==='ink') {
    if (points.length===1) {
      if (interactive) group.append(el('circle',{cx:points[0][0],cy:points[0][1],r:Math.max(size/2,5),fill:'transparent'}));
      group.append(el('circle',{cx:points[0][0],cy:points[0][1],r:size/2,fill:color}));
    } else {
      const attrs={points:points.map(p=>p.join(',')).join(' '),fill:'none','stroke-linecap':'round','stroke-linejoin':'round'};
      if (interactive) group.append(el('polyline',{...attrs,stroke:'transparent','stroke-width':Math.max(size,12)}));
      group.append(el('polyline',{...attrs,stroke:color,'stroke-width':size}));
    }
  } else {
    const rect=el('rect',{x,y,width:w,height:h,fill:mark.type==='shape'?'transparent':color});
    if (mark.type==='shape') { rect.setAttribute('stroke',color); rect.setAttribute('stroke-width',size); }
    if (mark.type==='highlight') { rect.setAttribute('opacity',.46); group.style.mixBlendMode='multiply'; }
    group.append(rect);
  }
  return group;
}

function drawMarks(svg, page, interactive=false) {
  const view=viewOf(page);
  svg.replaceChildren();
  for (const original of page.marks) {
    const mark=interactive&&drag?.moved?.id===original.id?drag.moved:original;
    const group=svgMark(mark,page,view,interactive);
    svg.append(group);
    if (interactive&&selected===mark.id) {
      const box=group.getBBox(), padding=Math.max(2,(mark.size??0)/2);
      group.append(el('rect',{x:box.x-padding,y:box.y-padding,width:box.width+padding*2,height:box.height+padding*2,fill:'none',stroke:'#197751','stroke-width':1.4,'stroke-dasharray':'5 3','vector-effect':'non-scaling-stroke','pointer-events':'none'}));
    }
  }
  if (interactive&&drag?.draft) svg.append(svgMark(drag.draft,page,view));
}

async function findSourceRuns(page, entry, bytes) {
  try {
    textRuntime = await loadTextEngine();
    entry.runs = listTextRuns(textRuntime, bytes, page.source);
  } catch (error) {
    entry.error = error;
    console.warn(error);
  }
  if (current()?.proxy === page.proxy && tool === 'edit-text') {
    updateControls();
    drawOverlay();
  }
}

function drawOverlay() {
  const page=current();
  if (!page) return;
  drawMarks(overlay,page,true);
  if (tool!=='edit-text'||!page.proxy) return;

  let entry = sourceRuns.get(page.proxy);
  if (!entry) {
    entry = {};
    sourceRuns.set(page.proxy, entry);
    void findSourceRuns(page, entry, originalBytes);
    return;
  }
  if (!entry.runs) return;
  const view = viewOf(page);
  const edits = new Map(page.textEdits?.map(edit => [edit.index, edit.value]));
  for (const run of entry.runs) {
    const points = run.corners.map(([x,y]) => view.convertToViewportPoint(x,y).join(',')).join(' ');
    const target = el('polygon', { points, tabindex: 0, role: 'button',
      'aria-label': `Edit text: ${edits.get(run.index) ?? run.value}` });
    target.dataset.sourceText = run.index;
    overlay.append(target);
  }
}

function paintThumb(id) {
  const thumb=thumbs.get(id), page=state.pages.find(p=>p.id===id);
  if (!thumb||!page||thumb.painted) return;
  thumb.painted=true;
  const v=viewOf(page), s=Math.min(108/v.width,103/v.height);
  thumb.sheet.style.aspectRatio=`${v.width} / ${v.height}`;
  thumb.sheet.style.width=`${v.width*s}px`;
  thumb.svg.setAttribute('viewBox',`0 0 ${v.width} ${v.height}`);
  drawMarks(thumb.svg,page);
  try {
    paintWorkspacePage(page,thumb.canvas,s,1.5)?.promise.catch(error=>{
      if (error.name!=='RenderingCancelledException'&&thumb.button.isConnected) console.warn(error);
    });
  } catch (error) {
    console.warn(error);
  }
}

function paintVisibleThumbs() {
  for (const [id,thumb] of thumbs) if (thumb.button.offsetParent && Math.abs(thumb.button.getBoundingClientRect().top-$('page-list').getBoundingClientRect().top)<$('page-list').clientHeight+150) paintThumb(id);
}

function updateThumbs() {
  const signature=state.pages.map(p=>`${p.id}:${p.rotation}:${p.textRevision??0}`).join(',');
  if (signature!==thumbsKey) {
    thumbsKey=signature; thumbs.clear(); thumbObserver?.disconnect();
    thumbObserver=new IntersectionObserver(entries=>{
      for (const entry of entries) if (entry.isIntersecting) paintThumb(+entry.target.dataset.page);
    },{root:$('page-list'),rootMargin:'100px'});
    $('page-list').replaceChildren(...state.pages.map((page,index)=>{
      const button=document.createElement('button'), preview=document.createElement('span');
      const sheet=document.createElement('span'), thumbnail=document.createElement('canvas'), svg=el('svg',{'aria-hidden':true});
      const label=document.createElement('span');
      button.className='thumb'; button.dataset.page=page.id; button.type='button'; button.setAttribute('aria-label',`Page ${index+1}`);
      preview.className='thumb-preview'; preview.setAttribute('aria-hidden','true'); sheet.className='thumb-sheet';
      sheet.append(thumbnail,svg); preview.append(sheet); label.textContent=index+1; button.append(preview,label);
      button.addEventListener('click',()=>{goTo(index); if (mobile.matches) setSidebar(false);});
      thumbs.set(page.id,{button,sheet,canvas:thumbnail,svg,marks:page.marks,painted:false}); thumbObserver.observe(button);
      return button;
    }));
  }
  for (const page of state.pages) {
    const thumb=thumbs.get(page.id);
    thumb.button.setAttribute('aria-current',page.id===state.active);
    thumb.button.disabled=busy;
    if (thumb.painted&&thumb.marks!==page.marks) drawMarks(thumb.svg,page);
    thumb.marks=page.marks;
  }
  paintVisibleThumbs();
}

function point(e) {
  const rect=overlay.getBoundingClientRect(), view=viewOf(current());
  return [keepOnPage((e.clientX-rect.x)*view.width/rect.width,view.width),keepOnPage((e.clientY-rect.y)*view.height/rect.height,view.height)];
}

function askText(data) {
  promptText=data;
  $('text-title').textContent=data.sourceRun?'Edit existing text':data.id?'Edit text':'Add text';
  $('text-submit').textContent=data.id||data.sourceRun?'Save text':'Place text';
  $('source-text-help').hidden=!data.sourceRun;
  $('text-value').value=data.value??''; $('text-error').hidden=true;
  $('text-dialog').showModal(); $('text-value').focus();
}

function editSourceText(target) {
  if (!editable()||tool!=='edit-text'||!target) return;
  const page = current();
  const sourceRun = sourceRuns.get(page.proxy)?.runs?.find(run => run.index === Number(target.dataset.sourceText));
  if (!sourceRun) return;
  const previous = page.textEdits?.find(edit => edit.index === sourceRun.index);
  askText({ sourceRun, page, value: previous?.value ?? sourceRun.value });
}

overlay.addEventListener('click', e => editSourceText(e.target.closest('[data-source-text]')));
overlay.addEventListener('keydown', e => {
  const target = e.target.closest('[data-source-text]');
  if (!target || (e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  editSourceText(target);
});

overlay.addEventListener('pointerdown',e=>{
  if (!editable()||tool==='edit-text'||e.button!==0||drag||!e.isPrimary) return;
  const page=current(), [x,y]=point(e), angle=rotationOf(page);
  if (tool==='text') { askText({type:'text',angle,x,y,...prefs.text}); return; }
  if (tool==='select') {
    const id=Number(e.target.closest('[data-mark]')?.dataset.mark);
    selected=page.marks.find(mark=>mark.id===id)?.id??null;
    updateControls(); drawOverlay();
    if (!selected) return;
    const mark=markSelected();
    drag={pointer:e.pointerId,start:[x,y],mark,moved:null};
  } else {
    const draft={type:tool,angle,...prefs[tool],x,y,w:0,h:0};
    if (tool==='ink') draft.points=[[x,y]];
    drag={pointer:e.pointerId,start:[x,y],draft}; drawOverlay();
  }
  overlay.setPointerCapture(e.pointerId);
});

function updateDrag(e) {
  if (!drag||drag.pointer!==e.pointerId) return;
  const [x,y]=point(e), [sx,sy]=drag.start;
  if (drag.mark) {
    const page=current(), from=viewOf(page), to=viewOf(page,drag.mark.angle);
    const [ax,ay]=mapPoint(from,to,sx,sy), [bx,by]=mapPoint(from,to,x,y);
    const dx=bx-ax, dy=by-ay;
    drag.moved=Math.hypot(dx,dy)<.5?null:{...drag.mark,x:drag.mark.x+dx,y:drag.mark.y+dy};
    if (drag.moved?.points) drag.moved.points=drag.mark.points.map(([px,py])=>[px+dx,py+dy]);
  } else if (drag.draft.type==='ink') {
    const points=drag.draft.points, [px,py]=points.at(-1);
    if (points.length<4000&&Math.hypot(px-x,py-y)>.8) points.push([x,y]);
  } else Object.assign(drag.draft,{x:Math.min(x,sx),y:Math.min(y,sy),w:Math.abs(x-sx),h:Math.abs(y-sy)});
  drawOverlay();
}

overlay.addEventListener('pointermove',updateDrag);
overlay.addEventListener('pointerup',e=>{
  if (!drag||drag.pointer!==e.pointerId) return;
  updateDrag(e);
  const {moved,draft}=drag; drag=null;
  if (moved) replaceMark(moved);
  else if (draft&&(draft.type==='ink'||(draft.w>=2&&draft.h>=2))) addMark(draft);
  else drawOverlay();
});
for (const name of ['pointercancel','lostpointercapture']) overlay.addEventListener(name,e=>{
  if (drag?.pointer===e.pointerId) { drag=null; drawOverlay(); }
});

async function confirmReplacement() {
  if (!dirty()) return true;
  const dialog=$('replace-dialog');
  if (dialog.open) return false;
  dialog.returnValue='cancel'; dialog.showModal();
  return new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue==='open'),{once:true}));
}

async function loadPdf(file) {
  if ($('text-dialog').open) return;
  if (busy || (file&&!/\.pdf$/i.test(file.name)&&file.type!=='application/pdf')) {
    if (!busy) notice('Choose a PDF file to open.',true);
    return;
  }
  if (!await confirmReplacement()||busy) return;
  busy=true; drag=null; updateControls(); notice('Opening PDF…',false,0);
  let nextDoc;
  try {
    if (!globalThis.PDFLib) throw new Error('Missing bundled PDF library');
    const bytes=file?new Uint8Array(await file.arrayBuffer()):await makeSample();
    nextDoc=await openPdf(bytes);
    if (!nextDoc.numPages) throw new Error('No pages');
    // Check that the writing library can open the file before allowing any edits.
    await globalThis.PDFLib.PDFDocument.load(bytes,{updateMetadata:false});
    const proxies=[];
    for (let i=1; i<=nextDoc.numPages; i+=24) {
      proxies.push(...await Promise.all(Array.from({length:Math.min(24,nextDoc.numPages-i+1)},(_,n)=>nextDoc.getPage(i+n))));
    }
    const pages=proxies.map((proxy,source)=>({id:key(),source,proxy,rotation:0,marks:[]}));
    const previous=doc; doc=nextDoc; originalBytes=bytes; originalPages=savedPages=pages;
    state={pages,active:pages[0].id}; filename=file?.name??'Field Notes.pdf';
    undo=[]; redo=[]; zoom=null; selected=null; tool='select'; renderedPage=null;
    closePdf(previous).catch(()=>{});
    if (mobile.matches) setSidebar(false);
    stage.scrollTo(0,0); notice('');
  } catch(error) {
    await closePdf(nextDoc).catch(()=>{});
    const locked=error.name==='PasswordException'||error.constructor.name==='EncryptedPDFError';
    notice(locked?'This PDF is locked. Open an unlocked copy to edit it.':'Couldn’t open this PDF. Check the file and try again.',true,6500);
    console.error(error);
  } finally { busy=false; refresh(); }
}

async function download() {
  if (!editable()) return;
  busy=true; drag=null; updateControls(); notice('Preparing your PDF…',false,0);
  const pages=state.pages;
  try {
    const source=pages.some(page=>page.textEdits?.length)?rewriteText(textRuntime,originalBytes,pages):originalBytes;
    const bytes=pages===originalPages?originalBytes:await exportPdf(source,pages);
    const url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
    const link=document.createElement('a'); link.href=url; link.download=`${filename.replace(/\.pdf$/i,'')}-edited.pdf`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
    savedPages=pages; notice('PDF ready. Check your downloads.');
  } catch(error) { notice('Couldn’t export this PDF. Your edits are still here.',true); console.error(error); }
  finally { busy=false; refresh(); }
}

$('open').onclick=$('choose').onclick=()=>fileInput.click();
fileInput.addEventListener('change',()=>{const file=fileInput.files[0]; fileInput.value=''; if (file) loadPdf(file);});
$('demo').onclick=()=>loadPdf(null); $('download').onclick=download;
$('toggle-pages').onclick=()=>setSidebar($('sidebar').hidden);
$('undo').onclick=()=>stepHistory(true); $('redo').onclick=()=>stepHistory(false);
$('prev').onclick=()=>goTo(activeIndex()-1); $('next').onclick=()=>goTo(activeIndex()+1);
$('move-up').onclick=()=>movePage(-1); $('move-down').onclick=()=>movePage(1);
$('rotate').onclick=()=>{const page=current(); changePage({...page,rotation:(page.rotation+90)%360});};
$('add-page').onclick=()=>{
  const v=viewOf(current()), page={id:key(),source:null,width:v.width,height:v.height,rotation:0,marks:[]};
  const pages=[...state.pages]; pages.splice(activeIndex()+1,0,page); selected=null; commit(pages,page.id); stage.scrollTo(0,0);
  thumbs.get(page.id)?.button.scrollIntoView({block:'nearest'});
};
$('delete-page').onclick=()=>{
  const index=activeIndex(), pages=state.pages.filter(page=>page.id!==state.active); selected=null;
  commit(pages,pages[Math.min(index,pages.length-1)].id); stage.scrollTo(0,0); notice('Page removed. You can undo this.');
};
$('zoom-in').onclick=()=>setZoom((zoom??fitScale(current()))*1.2);
$('zoom-out').onclick=()=>setZoom((zoom??fitScale(current()))/1.2);
$('zoom-fit').onclick=()=>setZoom(null);
$('edit-mark').onclick=()=>{const mark=markSelected(); if (mark?.type==='text') askText(mark);};
$('remove-mark').onclick=deleteMark;
for (const button of tools) button.onclick=()=>setTool(button.dataset.tool);
for (const prop of ['color','size']) $(prop).addEventListener('change',()=>{
  const value=prop==='size'?+$(prop).value:$(prop).value, mark=markSelected();
  if (!editable()) return;
  if (mark) replaceMark({...mark,[prop]:value});
  else if (prefs[tool]) prefs[tool][prop]=value;
});
$('text-cancel').onclick=()=>$('text-dialog').close();
$('text-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const value=$('text-value').value.trim().replaceAll('\t','    ');
  if (!value) { $('text-error').textContent='Enter some text first.'; $('text-error').hidden=false; return; }
  const pending=promptText;
  if (pending.sourceRun) {
    if (value===pending.value) { $('text-dialog').close(); return; }
    if (/\p{Cc}/u.test(value)) {
      $('text-error').textContent='Enter a single line of text.';
      $('text-error').hidden=false;
      return;
    }
    const { page, sourceRun } = pending;
    const textEdits = (page.textEdits ?? []).filter(edit => edit.index !== sourceRun.index);
    if (value !== sourceRun.value) {
      textEdits.push({ index: sourceRun.index, original: sourceRun.value, origin: sourceRun.origin, value });
    }
    const edited = { ...page, textEdits, textRevision: key() };
    try {
      rewriteText(textRuntime, originalBytes, [edited]);
    } catch (error) {
      $('text-error').textContent=error.message;
      $('text-error').hidden=false;
      return;
    }
    $('text-dialog').close();
    changePage(edited);
    return;
  }
  try { await validateText(value); }
  catch { $('text-error').textContent='Some characters aren’t available in the built-in font. Try plain Latin text.'; $('text-error').hidden=false; return; }
  if (!$('text-dialog').open||promptText!==pending) return;
  $('text-dialog').close();
  const mark={...pending,value}; if (mark.id) replaceMark(mark); else addMark(mark);
});

const filesDragging=e=>Array.from(e.dataTransfer?.types??[]).includes('Files');
let dragDepth=0;
document.addEventListener('dragenter',e=>{if (!filesDragging(e)) return; e.preventDefault(); dragDepth++; if (!busy) $('drop-indicator').hidden=false;});
document.addEventListener('dragover',e=>{if (!filesDragging(e)) return; e.preventDefault(); e.dataTransfer.dropEffect=busy?'none':'copy';});
document.addEventListener('dragleave',e=>{if (!filesDragging(e)) return; dragDepth=Math.max(0,dragDepth-1); if (!dragDepth) $('drop-indicator').hidden=true;});
document.addEventListener('drop',e=>{
  if (!filesDragging(e)) return; e.preventDefault(); dragDepth=0; $('drop-indicator').hidden=true;
  if (e.dataTransfer.files.length) loadPdf(e.dataTransfer.files[0]);
});

document.addEventListener('keydown',e=>{
  if (!editable()||document.querySelector('dialog[open]')||e.target.closest('input,select,textarea,[contenteditable]')) return;
  const k=e.key.toLowerCase(), command=e.metaKey||e.ctrlKey;
  if (command&&k==='z') { e.preventDefault(); stepHistory(!e.shiftKey); return; }
  if (command&&k==='y') { e.preventDefault(); stepHistory(false); return; }
  if (command||e.altKey) return;
  const shortcuts={v:'select',t:'text',e:'edit-text',d:'ink',h:'highlight',r:'shape',w:'whiteout'};
  if (shortcuts[k]) { e.preventDefault(); setTool(shortcuts[k]); }
  if (k==='escape') setTool('select');
  if (k==='delete'&&selected) { e.preventDefault(); deleteMark(); }
  if (k==='enter'&&e.target===stage&&tool==='text') {
    const page=current(), view=viewOf(page);
    askText({type:'text',angle:rotationOf(page),x:view.width/4,y:view.height/4,...prefs.text});
  }
});

new ResizeObserver(()=>{if (doc&&zoom===null) renderPage();}).observe(stage);
updateControls();
