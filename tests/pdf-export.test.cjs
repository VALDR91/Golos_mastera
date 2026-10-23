const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const pdfStart = html.indexOf('        function validateEstimateForPdf(proj) {');
const pdfEnd = html.indexOf('        function generateEstimateText() {', pdfStart);
if (pdfStart < 0 || pdfEnd < 0) {
  throw new Error('Could not locate PDF export functions in index.html; update the PDF tests after intentional code movement.');
}
const pdfSource = html.slice(pdfStart, pdfEnd);

function makePdfFixture() {
  const stream = 'BT /F1 12 Tf 50 700 Td (Fixture text) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  const chunks = ['%PDF-1.4\n'];
  const offsets = [];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(chunks.join('')));
    chunks.push(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`);
  }
  const xrefOffset = Buffer.byteLength(chunks.join(''));
  chunks.push(`xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return new Blob([chunks.join('')], { type: 'application/pdf' });
}

function sampleProject(name = 'Кухня & ванная') {
  return {
    name,
    advance: 2000,
    overhead5: false,
    discountPercent: 0,
    items: [
      { id: 1, type: 'work', name: 'Укладка плитки', qty: 12, unit: 'м²', price: 850 },
      { id: 2, type: 'material', name: 'Клей плиточный', qty: 3, unit: 'мешка', price: 1200 },
    ],
  };
}

function calculateTotals(project) {
  let wSum = 0;
  let mSum = 0;
  for (const item of project.items) {
    const row = Math.round(item.qty * item.price);
    if (item.type === 'work') wSum += row;
    else mSum += row;
  }
  const baseTotal = wSum + mSum;
  const overheadSum = project.overhead5 ? Math.round(baseTotal * 0.05) : 0;
  const discountSum = project.discountPercent
    ? Math.round((baseTotal + overheadSum) * project.discountPercent / 100)
    : 0;
  const finalTotal = baseTotal + overheadSum - discountSum;
  return { wSum, mSum, overheadSum, discountSum, finalTotal, balance: finalTotal - project.advance };
}

function createHarness({
  project = sampleProject(), pdfBlob = makePdfFixture(), html2pdfEnabled = true, navigatorOverrides = {},
  pdfGenerationError = null, objectUrlError = null, linkClickError = null,
} = {}) {
  const messages = [];
  const timers = new Map();
  const revokedUrls = [];
  const appendedNodes = [];
  const clicks = [];
  const createdLinks = [];
  const shares = [];
  const nodes = {};
  let nextTimerId = 1;
  let nextObjectUrl = 1;
  let generatorCalls = 0;
  let capturedOptions = null;
  let capturedExportNode = null;
  let sourceCloneCount = 0;

  const printSource = {
    id: 'printDocument',
    innerHTML: '',
    style: {},
    cloneNode() {
      sourceCloneCount += 1;
      return {
        id: this.id,
        innerHTML: this.innerHTML,
        style: {},
        removed: false,
        remove() { this.removed = true; },
      };
    },
  };
  const body = {
    style: {},
    appendChild(node) { node.parentNode = this; appendedNodes.push(node); },
  };
  const toastNode = { classList: { remove() {}, add() {} } };
  const toastText = { innerText: '' };
  nodes.printDocument = printSource;
  nodes.proToast = toastNode;
  nodes.proToastText = toastText;
  const document = {
    fonts: { ready: Promise.resolve() },
    body,
    documentElement: { style: {} },
    getElementById(id) { return nodes[id] || null; },
    createElement(tag) {
      assert.equal(tag, 'a');
      const link = {
        href: '', download: '', style: {}, removed: false,
        click() {
          if (linkClickError) throw linkClickError;
          clicks.push({ href: this.href, download: this.download });
        },
        remove() { this.removed = true; },
      };
      createdLinks.push(link);
      return link;
    },
  };
  const navigator = {
    canShare: null,
    share: null,
    ...navigatorOverrides,
  };
  const context = {
    document,
    window: { requestAnimationFrame(callback) { callback(); } },
    navigator,
    Blob,
    File: class TestFile extends Blob {
      constructor(parts, name, options) { super(parts, options); this.name = name; }
    },
    URL: {
      createObjectURL() {
        if (objectUrlError) throw objectUrlError;
        return `blob:test-${nextObjectUrl++}`;
      },
      revokeObjectURL(url) { revokedUrls.push(url); },
    },
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    console: { warn() {}, error() {} },
    state: { masterProfile: { name: 'Бригада «Дом & Сад»', phone: '+7 900 123-45-67' } },
    getCurrentProject: () => project,
    calculateTotals,
    showToast: (message) => messages.push(message),
    escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[ch]);
    },
  };
  if (html2pdfEnabled) {
    context.html2pdf = () => {
      generatorCalls += 1;
      const worker = {
        set(options) { capturedOptions = options; return worker; },
        from(node) { capturedExportNode = node; return worker; },
        outputPdf(type) {
          assert.equal(type, 'blob');
          if (pdfGenerationError) return Promise.reject(pdfGenerationError);
          return Promise.resolve(pdfBlob);
        },
      };
      return worker;
    };
  }

  vm.createContext(context);
  vm.runInContext(`${pdfSource}\nthis.pdfApi = {
    validateEstimateForPdf, buildPdfFileName, buildOfficialEstimateHtml,
    waitForPdfRenderReady, positionPdfCaptureClone, createEstimatePdfBlob,
    downloadEstimatePdf, deliverEstimatePdf, printOfficialEstimate
  };`, context);

  return {
    api: context.pdfApi,
    context,
    project,
    messages,
    timers,
    revokedUrls,
    appendedNodes,
    clicks,
    createdLinks,
    shares,
    get generatorCalls() { return generatorCalls; },
    get capturedOptions() { return capturedOptions; },
    get capturedExportNode() { return capturedExportNode; },
    get sourceCloneCount() { return sourceCloneCount; },
    runTimers() {
      const pending = [...timers.values()];
      timers.clear();
      for (const timer of pending) timer.callback();
    },
  };
}

test('PDF HTML contains work and material rows, correct amounts, Russian text, and escaped ampersands', () => {
  const harness = createHarness();
  const project = sampleProject();
  const output = harness.api.buildOfficialEstimateHtml(
    project, calculateTotals(project), harness.context.state.masterProfile, '23.10.2026'
  );

  assert.match(output, /Объект: Кухня &amp; ванная/);
  assert.doesNotMatch(output, /Кухня &amp;amp; ванная/);
  assert.match(output, /Бригада «Дом &amp; Сад»/);
  assert.match(output, /Укладка плитки/);
  assert.match(output, /12 м²/);
  assert.match(output, /10 200 ₽/);
  assert.match(output, /Клей плиточный/);
  assert.match(output, /3 мешка/);
  assert.match(output, /3 600 ₽/);
  assert.match(output, /13 800 ₽/);
  assert.match(output, /11 800 ₽/);
});

test('filename replaces filesystem-invalid characters while preserving a literal ampersand', () => {
  const harness = createHarness();
  assert.equal(harness.api.buildPdfFileName('Кухня & ванная / объект'), 'Смета-Кухня-&-ванная---объект.pdf');
});

test('empty and malformed estimates stop before PDF generation with a clear message', async () => {
  const empty = createHarness({ project: { name: 'Пусто', items: [] } });
  assert.equal(await empty.api.printOfficialEstimate(), false);
  assert.equal(empty.generatorCalls, 0);
  assert.match(empty.messages.at(-1), /добавьте в смету/i);
  assert.equal(empty.sourceCloneCount, 0);

  const malformed = createHarness({ project: { name: 'Ошибка', items: [{ type: 'work', name: '', qty: 1, price: 5 }] } });
  assert.equal(await malformed.api.printOfficialEstimate(), false);
  assert.equal(malformed.generatorCalls, 0);
  assert.match(malformed.messages.at(-1), /некорректная позиция/i);
});

test('PDF creation waits for layout, relocates the html2canvas clone, validates the PDF signature, and cleans up', async () => {
  const harness = createHarness();
  assert.equal(await harness.api.printOfficialEstimate(), true);
  assert.equal(harness.generatorCalls, 1);
  assert.equal(harness.capturedExportNode.id, 'pdfExportDocument');
  assert.match(harness.capturedExportNode.innerHTML, /Укладка плитки/);
  assert.match(harness.capturedExportNode.innerHTML, /Клей плиточный/);
  assert.equal(harness.capturedExportNode.removed, true);
  assert.equal(harness.capturedOptions.filename, 'Смета-Кухня-&-ванная.pdf');
  assert.equal(harness.capturedOptions.html2canvas.windowWidth, 900);
  assert.equal(typeof harness.capturedOptions.html2canvas.onclone, 'function');

  const clonedExport = { style: {} };
  const clonedDocument = {
    body: { style: {} },
    documentElement: { style: {} },
    getElementById(id) { return id === 'pdfExportDocument' ? clonedExport : null; },
  };
  harness.capturedOptions.html2canvas.onclone(clonedDocument);
  assert.equal(clonedExport.style.left, '0');
  assert.equal(clonedExport.style.top, '0');
  assert.equal(clonedExport.style.position, 'absolute');
  assert.equal(clonedDocument.body.style.overflow, 'visible');
  assert.equal(harness.messages.at(-1), 'Запрос на скачивание отправлен. Проверьте папку «Загрузки».');
  assert.equal(harness.clicks.length, 1);
});

test('invalid PDF data is rejected and the temporary export node is removed', async () => {
  const harness = createHarness({ pdfBlob: new Blob(['not a PDF']) });
  assert.equal(await harness.api.printOfficialEstimate(), false);
  assert.equal(harness.capturedExportNode.removed, true);
  assert.equal(harness.clicks.length, 0);
  assert.match(harness.messages.at(-1), /повреждён или пуст/i);

  const truncated = createHarness({ pdfBlob: new Blob(['%PDF-1.4\nbody without end marker']) });
  assert.equal(await truncated.api.printOfficialEstimate(), false);
  assert.match(truncated.messages.at(-1), /повреждён или пуст/i);

  const noPage = createHarness({ pdfBlob: new Blob(['%PDF-1.4\ntrailer\n%%EOF']) });
  assert.equal(await noPage.api.printOfficialEstimate(), false);
  assert.match(noPage.messages.at(-1), /повреждён или пуст/i);
});

test('PDF generator rejection is reported and temporary DOM is cleaned up', async () => {
  const harness = createHarness({ pdfGenerationError: new Error('canvas failed') });
  assert.equal(await harness.api.printOfficialEstimate(), false);
  assert.equal(harness.capturedExportNode.removed, true);
  assert.equal(harness.clicks.length, 0);
  assert.match(harness.messages.at(-1), /не удалось сформировать PDF/i);
});

test('missing html2pdf library is reported without leaking the export node', async () => {
  const harness = createHarness({ html2pdfEnabled: false });
  assert.equal(await harness.api.printOfficialEstimate(), false);
  assert.equal(harness.appendedNodes[0].removed, true);
  assert.match(harness.messages.at(-1), /модуль создания PDF не загрузился/i);
});

test('supported navigator.share receives an application/pdf File and success is described as handoff', async () => {
  let sharedFile;
  const harness = createHarness({ navigatorOverrides: {
    canShare: ({ files }) => files[0].type === 'application/pdf',
    share: async ({ files }) => { sharedFile = files[0]; },
  } });
  assert.equal(await harness.api.printOfficialEstimate(), true);
  assert.equal(sharedFile.name, 'Смета-Кухня-&-ванная.pdf');
  assert.equal(sharedFile.type, 'application/pdf');
  assert.equal(harness.clicks.length, 0);
  assert.match(harness.messages.at(-1), /передан в меню отправки/i);
  assert.doesNotMatch(harness.messages.at(-1), /сохранён/i);
});

test('cancelled navigator.share is not called a success and does not trigger a fallback download', async () => {
  const harness = createHarness({ navigatorOverrides: {
    canShare: () => true,
    share: async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); },
  } });
  assert.equal(await harness.api.printOfficialEstimate(), false);
  assert.equal(harness.clicks.length, 0);
  assert.equal(harness.messages.at(-1), 'Экспорт PDF отменён.');
});

test('failed share falls back to download and releases its object URL after the click', async () => {
  const harness = createHarness({ navigatorOverrides: {
    canShare: () => true,
    share: async () => { throw new Error('share unavailable'); },
  } });
  assert.equal(await harness.api.printOfficialEstimate(), true);
  assert.equal(harness.clicks.length, 1);
  assert.equal(harness.createdLinks[0].removed, true);
  assert.equal(harness.clicks[0].download, 'Смета-Кухня-&-ванная.pdf');
  assert.equal(harness.revokedUrls.length, 0);
  assert.ok([...harness.timers.values()].some(timer => timer.delay === 60000));
  harness.runTimers();
  assert.deepEqual(harness.revokedUrls, [harness.clicks[0].href]);
});

test('failed download click releases its object URL immediately and reports delivery failure', async () => {
  const harness = createHarness({ linkClickError: new Error('download blocked') });
  assert.equal(await harness.api.printOfficialEstimate(), false);
  assert.equal(harness.createdLinks[0].removed, true);
  assert.deepEqual(harness.revokedUrls, ['blob:test-1']);
  assert.match(harness.messages.at(-1), /не удалось передать файл или начать скачивание/i);
});

test('sequential toast messages cancel the earlier timer', () => {
  const messages = [];
  const toastClasses = new Set(['hidden']);
  const toast = {
    classList: {
      add(name) { toastClasses.add(name); },
      remove(name) { toastClasses.delete(name); },
    },
  };
  const toastText = { innerText: '' };
  const timers = new Map();
  let nextTimerId = 1;
  const context = {
    document: { getElementById(id) { return id === 'proToast' ? toast : toastText; } },
    setTimeout(callback, delay) { const id = nextTimerId++; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.createContext(context);
  const toastStart = html.indexOf('        let toastTimer = null;');
  const toastEnd = html.indexOf('        loadState();', toastStart);
  assert.ok(toastStart >= 0 && toastEnd > toastStart, 'showToast function should be locatable');
  vm.runInContext(`${html.slice(toastStart, toastEnd)}\nthis.testToast = showToast;`, context);

  context.testToast('Первое');
  const firstTimerId = [...timers.keys()][0];
  context.testToast('Второе');
  assert.equal(toastText.innerText, 'Второе');
  assert.equal(timers.size, 1);
  assert.equal(timers.has(firstTimerId), false);
  assert.equal(toastClasses.has('hidden'), false);
  [...timers.values()][0].callback();
  assert.equal(toastClasses.has('hidden'), true);
});

test('toast is centered, constrained to the viewport, and offset above the bottom action bar', () => {
  assert.match(html, /#proToast\s*\{[^}]*left:\s*50%;[^}]*bottom:\s*calc\(env\(safe-area-inset-bottom,\s*0px\)\s*\+\s*7\.25rem\)/s);
  assert.match(html, /#proToast\s*\{[^}]*max-width:\s*calc\(100vw\s*-\s*24px\)/s);
  assert.match(html, /#proToast\s*\{[^}]*overflow-wrap:\s*anywhere/s);
});
