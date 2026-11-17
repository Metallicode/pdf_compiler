/* PDF Compiler — merge, reorder and compress PDFs entirely in the browser. */
(() => {
  'use strict';

  const { PDFDocument } = PDFLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  const SOFT_FILE_LIMIT = 50;
  const MAX_CANVAS_SIDE = 8000;          // px — browsers fail above ~16k, stay safe
  const MAX_CANVAS_AREA = 40_000_000;    // px²
  const PRESETS = { medium: { dpi: 150, quality: 70 }, strong: { dpi: 100, quality: 50 } };

  // ---------- State ----------
  /** @type {{id:number,name:string,size:number,bytes:ArrayBuffer,pages:number|null,thumb:string|null,error:string|null}[]} */
  let items = [];
  let nextId = 1;
  let busy = false;
  let nameTouched = false;
  let resultUrl = null;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const dropzone = $('dropzone'), fileInput = $('fileInput');
  const listSection = $('listSection'), fileList = $('fileList'), summary = $('summary');
  const options = $('options'), outName = $('outName');
  const dpi = $('dpi'), quality = $('quality'), dpiOut = $('dpiOut'), qualityOut = $('qualityOut');
  const advanced = $('advanced'), runBtn = $('run');
  const progress = $('progress'), progressBar = $('progressBar'), progressText = $('progressText');
  const result = $('result');

  // ---------- Helpers ----------
  const fmtSize = (b) => {
    if (b < 1024) return `${b} B`;
    if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
    return `${(b / 1024 ** 2).toFixed(b < 10 * 1024 ** 2 ? 2 : 1)} MB`;
  };
  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const baseName = (n) => n.replace(/\.pdf$/i, '');
  const currentMode = () => document.querySelector('input[name="mode"]:checked').value;
  const nextFrame = () => new Promise((r) => setTimeout(r, 0));
  const safeFileName = (s) => (s.trim().replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]+/g, '_') || 'output') + '.pdf';

  const ICONS = {
    grip: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M9 5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3m6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3M9 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3m6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3M9 16a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3m6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3"/></svg>',
    up: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 8l-6 6 1.4 1.4 4.6-4.6 4.6 4.6L18 14z"/></svg>',
    down: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 16l6-6-1.4-1.4-4.6 4.6-4.6-4.6L6 10z"/></svg>',
    x: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
  };

  // ---------- Adding files ----------
  dropzone.addEventListener('click', () => !busy && fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!busy) fileInput.click(); }
  });
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

  // Accept drops anywhere on the page so a near-miss doesn't open the PDF in the tab.
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; dropzone.classList.add('over'); } });
  window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; dropzone.classList.remove('over'); } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove('over');
    if (!busy) addFiles(e.dataTransfer.files);
  });

  async function addFiles(fileListLike) {
    const files = [...fileListLike].filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    const skipped = fileListLike.length - files.length;
    if (skipped > 0) toast(`${skipped} file${skipped > 1 ? 's were' : ' was'} skipped (not a PDF).`);
    if (!files.length) return;

    const added = [];
    for (const f of files) {
      const item = { id: nextId++, name: f.name, size: f.size, bytes: await f.arrayBuffer(), pages: null, thumb: null, error: null };
      items.push(item);
      added.push(item);
    }
    if (items.length > SOFT_FILE_LIMIT) {
      toast(`You have ${items.length} files. That works, but large batches can use a lot of memory.`);
    }
    invalidateResult();
    render();
    for (const item of added) await inspect(item); // one at a time keeps memory low
  }

  // Read the page count and render a first-page thumbnail with pdf.js.
  async function inspect(item) {
    let doc;
    try {
      doc = await pdfjsLib.getDocument({ data: item.bytes.slice(0), isEvalSupported: false }).promise;
      item.pages = doc.numPages;
      const page = await doc.getPage(1);
      const vp0 = page.getViewport({ scale: 1 });
      const scale = 120 / Math.max(vp0.width, vp0.height);
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      item.thumb = canvas.toDataURL('image/jpeg', 0.7);
    } catch (err) {
      item.error = err?.name === 'PasswordException'
        ? 'Password-protected, so it can\'t be processed'
        : 'Could not read this file. It may be damaged or not a real PDF.';
    } finally {
      if (doc) doc.destroy();
    }
    if (items.includes(item)) render();
  }

  // ---------- Rendering the list ----------
  function render() {
    const n = items.length;
    listSection.hidden = options.hidden = n === 0;
    dropzone.classList.toggle('compact', n > 0);

    const totalPages = items.reduce((s, i) => s + (i.pages || 0), 0);
    const totalSize = items.reduce((s, i) => s + i.size, 0);
    summary.textContent = `${n} file${n === 1 ? '' : 's'} · ${totalPages} page${totalPages === 1 ? '' : 's'} · ${fmtSize(totalSize)}`;

    fileList.innerHTML = items.map((it, idx) => `
      <li class="file${it.error ? ' error' : ''}" data-id="${it.id}">
        <span class="handle" title="Drag to reorder">${ICONS.grip}</span>
        <span class="index">${idx + 1}</span>
        ${it.thumb ? `<img class="thumb" src="${it.thumb}" alt="">` : '<span class="thumb placeholder"></span>'}
        <div class="meta">
          <div class="name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</div>
          <div class="details">${it.error ? escapeHtml(it.error) : `${it.pages == null ? 'Reading…' : `${it.pages} page${it.pages === 1 ? '' : 's'}`} · ${fmtSize(it.size)}`}</div>
        </div>
        <div class="row-actions">
          <button type="button" class="icon-btn move" data-act="up" title="Move up" aria-label="Move up" ${idx === 0 ? 'disabled' : ''}>${ICONS.up}</button>
          <button type="button" class="icon-btn move" data-act="down" title="Move down" aria-label="Move down" ${idx === n - 1 ? 'disabled' : ''}>${ICONS.down}</button>
          <button type="button" class="icon-btn remove" data-act="remove" title="Remove" aria-label="Remove ${escapeHtml(it.name)}">${ICONS.x}</button>
        </div>
      </li>`).join('');

    // Button label and default output name
    runBtn.textContent = n === 1 ? 'Compress PDF' : `Merge ${n} files`;
    if (!nameTouched) outName.value = n === 1 ? `${baseName(items[0].name)}-compressed` : 'merged';
    updateRunState();
  }

  function updateRunState() {
    const hasErrors = items.some((i) => i.error);
    const pending = items.some((i) => i.pages == null && !i.error);
    runBtn.disabled = busy || !items.length || hasErrors || pending;
    runBtn.title = hasErrors ? 'Remove the files marked in red first' : pending ? 'Still reading files…' : '';
  }

  fileList.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn || busy) return;
    const id = Number(btn.closest('.file').dataset.id);
    const idx = items.findIndex((i) => i.id === id);
    const act = btn.dataset.act;
    if (act === 'remove') items.splice(idx, 1);
    else if (act === 'up' && idx > 0) [items[idx - 1], items[idx]] = [items[idx], items[idx - 1]];
    else if (act === 'down' && idx < items.length - 1) [items[idx + 1], items[idx]] = [items[idx], items[idx + 1]];
    invalidateResult();
    render();
  });

  Sortable.create(fileList, {
    handle: '.handle',
    animation: 150,
    onStart: () => { if (busy) return false; },
    onEnd: (e) => {
      if (e.oldIndex === e.newIndex) return;
      const [moved] = items.splice(e.oldIndex, 1);
      items.splice(e.newIndex, 0, moved);
      invalidateResult();
      render();
    },
  });

  $('sortName').addEventListener('click', () => {
    if (busy) return;
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    items.sort((a, b) => collator.compare(a.name, b.name));
    invalidateResult(); render();
  });
  $('reverse').addEventListener('click', () => { if (!busy) { items.reverse(); invalidateResult(); render(); } });
  $('clearAll').addEventListener('click', () => { if (!busy) { items = []; nameTouched = false; invalidateResult(); render(); } });

  // ---------- Options ----------
  outName.addEventListener('input', () => { nameTouched = true; invalidateResult(); });

  function syncAdvanced() {
    const mode = currentMode();
    if (mode === 'lossless') advanced.setAttribute('data-disabled', '');
    else {
      advanced.removeAttribute('data-disabled');
      dpi.value = PRESETS[mode].dpi;
      quality.value = PRESETS[mode].quality;
    }
    dpiOut.textContent = dpi.value;
    qualityOut.textContent = quality.value;
  }
  document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', () => { syncAdvanced(); invalidateResult(); }));
  dpi.addEventListener('input', () => { dpiOut.textContent = dpi.value; invalidateResult(); });
  quality.addEventListener('input', () => { qualityOut.textContent = quality.value; invalidateResult(); });
  syncAdvanced();

  // ---------- Processing ----------
  runBtn.addEventListener('click', run);

  async function run() {
    if (busy || !items.length) return;
    invalidateResult();
    busy = true;
    updateRunState();
    dropzone.setAttribute('aria-disabled', 'true');
    progress.hidden = false;
    setProgress(0, 'Starting…');

    const mode = currentMode();
    const inputSize = items.reduce((s, i) => s + i.size, 0);
    const started = performance.now();
    try {
      const bytes = mode === 'lossless'
        ? await buildLossless()
        : await buildRasterized(Number(dpi.value), Number(quality.value) / 100);
      showResult(bytes, inputSize, mode, performance.now() - started);
    } catch (err) {
      console.error(err);
      result.hidden = false;
      result.innerHTML = `<p class="err">${escapeHtml(err.userMessage || 'Something went wrong while creating the PDF.')}</p>
        <p class="note">${escapeHtml(String(err.message || err))}</p>`;
    } finally {
      busy = false;
      progress.hidden = true;
      dropzone.removeAttribute('aria-disabled');
      updateRunState();
    }
  }

  function setProgress(fraction, text) {
    progressBar.style.width = `${Math.round(fraction * 100)}%`;
    progressText.textContent = text;
  }

  function fail(item, err, what) {
    const e = new Error(err?.message || String(err));
    e.userMessage = `Could not ${what} “${item.name}”.`;
    return e;
  }

  function applyMetadata(doc) {
    doc.setTitle(baseName(safeFileName(outName.value)));
    doc.setProducer('PDF Compiler');
    doc.setCreator('PDF Compiler');
  }

  // Lossless: copy the original page objects as they are (text, fonts and vectors untouched),
  // drop unused objects, and save with compressed object streams.
  async function buildLossless() {
    if (items.length === 1) {
      // A single file is loaded and re-saved as a whole so bookmarks and form fields are kept.
      const item = items[0];
      setProgress(0.3, `Optimizing “${item.name}”…`);
      await nextFrame();
      let doc;
      try { doc = await PDFDocument.load(item.bytes, { ignoreEncryption: true, updateMetadata: false }); }
      catch (err) { throw fail(item, err, 'read'); }
      applyMetadata(doc);
      setProgress(0.7, 'Saving…');
      await nextFrame();
      return doc.save({ useObjectStreams: true });
    }

    const out = await PDFDocument.create();
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      setProgress(i / items.length, `Adding file ${i + 1} of ${items.length}: ${item.name}`);
      await nextFrame();
      try {
        const src = await PDFDocument.load(item.bytes, { ignoreEncryption: true, updateMetadata: false });
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((p) => out.addPage(p));
      } catch (err) { throw fail(item, err, 'merge'); }
    }
    applyMetadata(out);
    setProgress(0.95, 'Saving…');
    await nextFrame();
    return out.save({ useObjectStreams: true });
  }

  // Image modes: render each page to a JPEG at the chosen DPI and put it on a page of the same size.
  async function buildRasterized(targetDpi, jpegQuality) {
    const out = await PDFDocument.create();
    const totalPages = items.reduce((s, i) => s + i.pages, 0);
    let done = 0;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });

    for (const item of items) {
      let doc;
      try {
        doc = await pdfjsLib.getDocument({ data: item.bytes.slice(0), isEvalSupported: false }).promise;
        for (let p = 1; p <= doc.numPages; p++) {
          setProgress(done / totalPages, `Compressing page ${done + 1} of ${totalPages} (${item.name})`);
          const page = await doc.getPage(p);
          const base = page.getViewport({ scale: 1 }); // in PDF points, rotation applied
          let scale = targetDpi / 72;
          scale = Math.min(scale, MAX_CANVAS_SIDE / Math.max(base.width, base.height));
          scale = Math.min(scale, Math.sqrt(MAX_CANVAS_AREA / (base.width * base.height)));
          const vp = page.getViewport({ scale });
          canvas.width = Math.max(1, Math.round(vp.width));
          canvas.height = Math.max(1, Math.round(vp.height));
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
          const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', jpegQuality));
          if (!blob) throw new Error('The browser could not encode the page image.');
          const img = await out.embedJpg(await blob.arrayBuffer());
          const newPage = out.addPage([base.width, base.height]);
          newPage.drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
          page.cleanup();
          done++;
        }
      } catch (err) {
        throw fail(item, err, 'compress');
      } finally {
        if (doc) doc.destroy();
      }
    }
    canvas.width = canvas.height = 0;
    applyMetadata(out);
    setProgress(0.98, 'Saving…');
    await nextFrame();
    return out.save({ useObjectStreams: true });
  }

  // ---------- Result ----------
  function showResult(bytes, inputSize, mode, ms) {
    const fileName = safeFileName(outName.value);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = URL.createObjectURL(blob);

    const diff = inputSize - blob.size;
    const pct = Math.round((Math.abs(diff) / inputSize) * 100);
    let sizeLine;
    if (diff > 0 && pct >= 1) {
      sizeLine = `<span class="saving">${pct}% smaller</span> (${fmtSize(inputSize)} → ${fmtSize(blob.size)})`;
    } else if (diff >= 0) {
      sizeLine = `<span class="growth">About the same size</span> (${fmtSize(inputSize)} → ${fmtSize(blob.size)})`;
    } else {
      sizeLine = `<span class="growth">${pct}% larger</span> (${fmtSize(inputSize)} → ${fmtSize(blob.size)})`;
    }

    let note = '';
    if (diff < 0 && mode !== 'lossless') {
      note = 'These files were already well compressed, so turning pages into images made the file bigger. Try <strong>Lossless</strong>, or lower the resolution or quality.';
    } else if (pct < 5 && mode === 'lossless') {
      note = 'The files were already well optimized. For a much smaller file, try <strong>Medium</strong> or <strong>Strong</strong>. Text will no longer be selectable.';
    }
    if (mode === 'lossless' && items.length > 1) {
      note += `${note ? '<br>' : ''}When merging, bookmarks and form fields from the original files are not kept.`;
    }

    result.hidden = false;
    result.innerHTML = `
      <p>${sizeLine} · done in ${(ms / 1000).toFixed(1)} s</p>
      <a class="btn primary big" href="${resultUrl}" download="${escapeHtml(fileName)}">Download ${escapeHtml(fileName)}</a>
      ${note ? `<p class="note" style="margin-top:10px">${note}</p>` : ''}`;
  }

  function invalidateResult() {
    if (busy) return;
    result.hidden = true;
    result.innerHTML = '';
    if (resultUrl) { URL.revokeObjectURL(resultUrl); resultUrl = null; }
  }

  // ---------- Tiny toast ----------
  let toastTimer;
  function toast(msg) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.setAttribute('role', 'status');
      el.style.cssText = 'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);max-width:calc(100% - 32px);background:var(--text);color:var(--bg);padding:10px 16px;border-radius:8px;font-size:14px;box-shadow:0 4px 16px rgba(0,0,0,.2);z-index:10';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
  }
})();
