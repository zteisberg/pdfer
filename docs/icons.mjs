const icons = {
  file:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8m-8 4h8"/>',
  folder:'<path d="M3 19V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v2M3 19l3-8h16l-3 8Z"/>',
  upload:'<path d="M12 16V3M7 8l5-5 5 5M4 15v5h16v-5"/>',
  download:'<path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  sidebar:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  cursor:'<path d="m4 3 15 10-7 1-3 7Z"/>', text:'<path d="M4 7V4h16v3M12 4v16m-4 0h8"/>',
  pen:'<path d="m4 15 11-11a2.8 2.8 0 0 1 4 4L8 19l-5 2 1-6Zm9-9 4 4"/>',
  highlight:'<path d="m9 16-3 1-2-2 1-3L15 2l5 5-10 10Zm-3 1-3 3m9-14 5 5M9 21h11"/>',
  square:'<rect x="4" y="4" width="16" height="16" rx="2"/>',
  eraser:'<path d="m3 14 9-10a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3l-8 8H8l-5-4a1.5 1.5 0 0 1 0-2Zm4-4 8 8m-3 2h9"/>',
  undo:'<path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 6 6v4"/>', redo:'<path d="m15 14 5-5-5-5m5 5H10a6 6 0 0 0-6 6v4"/>',
  pages:'<rect x="7" y="3" width="12" height="15" rx="2"/><path d="M15 21H7a3 3 0 0 1-3-3V8m6 0h6m-6 4h6"/>',
  shield:'<path d="m12 22-1-.5C6 19 4 15 4 10V5l8-3 8 3v5c0 5-2 9-7 11.5Z"/><path d="m9 12 2 2 4-5"/>',
  'arrow-right':'<path d="M4 12h16m-6-6 6 6-6 6"/>', 'arrow-up':'<path d="M12 20V4m-5 5 5-5 5 5"/>', 'arrow-down':'<path d="M12 4v16m-5-5 5 5 5-5"/>',
  rotate:'<path d="M21 8h-5m5 0V3m-.8 5A8 8 0 1 0 20 17"/>',
  trash:'<path d="M3 6h18M9 6V3h6v3m4 0-1 15H6L5 6m5 4v7m4-7v7"/>',
  left:'<path d="m15 6-6 6 6 6"/>', right:'<path d="m9 6 6 6-6 6"/>',
  minus:'<path d="M5 12h14"/>', plus:'<path d="M5 12h14m-7-7v14"/>', fit:'<path d="M9 4H4v5m11-5h5v5M4 15v5h5m6 0h5v-5"/><rect x="8" y="8" width="8" height="8" rx="1"/>',
};

for (const el of document.querySelectorAll('[data-icon]')) {
  el.setAttribute('aria-hidden','true');
  el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[el.dataset.icon]}</svg>`;
}
