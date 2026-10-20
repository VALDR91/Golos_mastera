const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const startMarker = '        function parseLocalText() {';
const endMarker = '        let modalSelectedType =';
const start = html.indexOf(startMarker);
const end = html.indexOf(endMarker, start);

if (start < 0 || end < 0) {
  throw new Error('Could not locate parseLocalText() in index.html; update the parser tests after intentional code movement.');
}
const parserSource = html.slice(start, end);

function runParser(raw) {
  const input = { value: raw };
  const project = { items: [] };
  const messages = [];
  let saved = false;
  const context = {
    document: { getElementById: (id) => id === 'voiceInput' ? input : null },
    showToast: (message) => messages.push(message),
    getCurrentProject: () => project,
    saveState: () => { saved = true; },
    Date,
  };
  vm.createContext(context);
  vm.runInContext(parserSource + '\nthis.__parse = parseLocalText;', context);
  context.__parse();
  return { input, project, messages, saved };
}

test('parses two dictated positions and applies a later price correction', () => {
  const result = runParser('Шпаклёвка стен 25 квадратов по 550 рублей. Нет, исправь цену на 600 рублей. Ещё грунтовка 40 квадратов по 100 рублей.');

  assert.equal(result.project.items.length, 2);
  const wallPutty = result.project.items.find((item) => /шпаклёвка стен/i.test(item.name));
  const primer = result.project.items.find((item) => /грунтовка/i.test(item.name));

  assert.ok(wallPutty, 'wall putty position should be present');
  assert.ok(primer, 'primer position should be present');
  assert.equal(wallPutty.qty, 25);
  assert.equal(wallPutty.unit, 'м²');
  assert.equal(wallPutty.price, 600);
  assert.equal(wallPutty.type, 'work');
  assert.equal(primer.qty, 40);
  assert.equal(primer.unit, 'м²');
  assert.equal(primer.price, 100);
  assert.equal(primer.type, 'material');
  assert.equal(wallPutty.qty * wallPutty.price + primer.qty * primer.price, 19000);
  assert.equal(result.input.value, '');
  assert.equal(result.saved, true);
});

test('a single number used as a price does not become quantity', () => {
  const result = runParser('Покрасить стены по 300 рублей');
  assert.equal(result.project.items.length, 1);
  assert.equal(result.project.items[0].qty, 1);
  assert.equal(result.project.items[0].price, 300);
  assert.equal(result.project.items[0].unit, 'шт.');
});

test('recognizes common material units and preserves material classification', () => {
  const result = runParser('Грунтовка глубокого проникновения 4 канистры по 1200 рублей');
  assert.equal(result.project.items.length, 1);
  assert.equal(result.project.items[0].qty, 4);
  assert.equal(result.project.items[0].unit, 'канистра');
  assert.equal(result.project.items[0].price, 1200);
  assert.equal(result.project.items[0].type, 'material');
});

test('keeps the original text if no estimate position can be parsed', () => {
  const raw = 'просто какой-то текст без цифр';
  const result = runParser(raw);
  assert.equal(result.project.items.length, 0);
  assert.equal(result.input.value, raw);
  assert.equal(result.saved, false);
  assert.match(result.messages.join(' '), /текст сохранён/i);
});
