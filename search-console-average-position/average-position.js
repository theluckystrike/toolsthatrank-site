// Average position calculator for /search-console-average-position/.
// Reads rows of impressions and average position, either a Search Console "Queries" CSV export or plain
// "impressions, position" lines, and reports the impression weighted average (the way Search Console
// averages) beside the plain mean of the rows. Everything runs in the browser. Nothing is uploaded.

export const MAX_ROWS = 50000;
export const MAX_IMPRESSIONS = 1e12;
export const MAX_POSITION = 1000;
const MAX_INPUT_CHARS = 5000000;
const MAX_REPORTED_LINES = 5;
const WHOLE = /^\d+$/;
const DECIMAL = /^\d+(?:\.\d+)?$/;

// Split one CSV or TSV line. Handles double quoted cells, including commas and doubled quotes inside them.
export function splitLine(line, delimiter) {
  const cells = [];
  let cell = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) { cells.push(cell); cell = ''; }
    else cell += ch;
  }
  cells.push(cell);
  return cells.map(value => value.trim());
}

// Parse pasted text into rows of {impressions, position}. Any invalid row rejects the whole input, so a
// result is never computed from a silently shortened list.
export function parseRows(text) {
  if (typeof text !== 'string' || !text.trim()) return {ok: false, error: 'Paste at least one row with impressions and a position.'};
  if (text.length > MAX_INPUT_CHARS) return {ok: false, error: 'That paste is too large for this page. Split it into smaller parts.'};
  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  let impressionsAt = 0, positionAt = 1, start = 0, header = false;
  const first = lines.findIndex(line => line.trim() !== '');
  if (first >= 0 && /[a-z]/i.test(lines[first])) {
    const delimiter = lines[first].includes('\t') ? '\t' : ',';
    const names = splitLine(lines[first], delimiter).map(name => name.toLowerCase());
    impressionsAt = names.findIndex(name => name === 'impressions');
    positionAt = names.findIndex(name => name === 'position');
    if (impressionsAt < 0 || positionAt < 0) return {ok: false, error: 'The header row needs columns named Impressions and Position, as in a Search Console export.'};
    start = first + 1;
    header = true;
  }
  const rows = [], bad = [];
  for (let i = start; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (rows.length >= MAX_ROWS) return {ok: false, error: `This page accepts up to ${MAX_ROWS} rows.`};
    const cells = splitLine(lines[i], lines[i].includes('\t') ? '\t' : ',');
    // Without a header a row is exactly two cells. A thousands separator such as 1,234 would otherwise shift the
    // cells and be read silently as the wrong numbers, so any other cell count rejects the row.
    if (!header && cells.length !== 2) { bad.push(i + 1); continue; }
    const impressions = cells[impressionsAt] ?? '', position = cells[positionAt] ?? '';
    if (!WHOLE.test(impressions) || !DECIMAL.test(position)) { bad.push(i + 1); continue; }
    const imp = Number(impressions), pos = Number(position);
    if (imp < 1 || imp > MAX_IMPRESSIONS || pos < 1 || pos > MAX_POSITION) { bad.push(i + 1); continue; }
    rows.push({impressions: imp, position: pos});
  }
  if (bad.length) {
    const shown = bad.slice(0, MAX_REPORTED_LINES).join(', ');
    return {ok: false, error: `Line ${shown}${bad.length > MAX_REPORTED_LINES ? ' and others' : ''} could not be read. Without a header row, each line needs exactly two values, impressions then position, separated by a comma or a tab. Impressions must be a whole number of at least 1, written without commas. Position must be a number of at least 1.`};
  }
  if (!rows.length) return {ok: false, error: 'No data rows were found under the header.'};
  return {ok: true, rows, header};
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Summarize parsed rows. weighted is how Search Console averages: each row's position counted once per impression.
export function summarize(rows) {
  let impressions = 0, weightedSum = 0, plainSum = 0, top10Rows = 0, top10Impressions = 0, beyond20Rows = 0, beyond20Impressions = 0;
  for (const row of rows.slice(0, MAX_ROWS)) {
    impressions += row.impressions;
    weightedSum += row.position * row.impressions;
    plainSum += row.position;
    if (row.position <= 10) { top10Rows += 1; top10Impressions += row.impressions; }
    if (row.position > 20) { beyond20Rows += 1; beyond20Impressions += row.impressions; }
  }
  const count = Math.min(rows.length, MAX_ROWS);
  const weighted = weightedSum / impressions, plain = plainSum / count;
  return {
    rows: count, impressions, weighted, plain, gap: plain - weighted,
    median: median(rows.slice(0, MAX_ROWS).map(row => row.position)),
    top10RowsPct: top10Rows / count * 100, top10ImpressionsPct: top10Impressions / impressions * 100,
    beyond20RowsPct: beyond20Rows / count * 100, beyond20ImpressionsPct: beyond20Impressions / impressions * 100,
  };
}

const fixed = (value, places) => value.toLocaleString('en-US', {minimumFractionDigits: places, maximumFractionDigits: places});
const signed = value => (value > 0 ? '+' : value < 0 ? '−' : '') + fixed(Math.abs(value), 2);

// Google's own worked example from Search Console Help answer 7042828: two queries, topmost positions 2 and 3.
export const EXAMPLE = 'Impressions,Position\n1,2\n1,3';

export function init(doc) {
  const form = doc.getElementById('ap-form');
  const input = doc.getElementById('ap-input');
  const error = doc.getElementById('ap-error');
  const results = doc.getElementById('ap-results');
  const buttons = ['ap-calc', 'ap-example', 'ap-clear'].map(id => doc.getElementById(id));
  if (!form || !input || !error || !results || buttons.some(button => !button)) return false;
  const [calc, example, clear] = buttons;
  const out = id => doc.getElementById(id);
  const reset = () => {
    results.hidden = true;
    for (const node of results.querySelectorAll('[data-ap]')) node.textContent = '';
  };
  const show = summary => {
    const values = {
      rows: summary.rows.toLocaleString('en-US'), impressions: summary.impressions.toLocaleString('en-US'),
      weighted: fixed(summary.weighted, 2), plain: fixed(summary.plain, 2), gap: signed(summary.gap), median: fixed(summary.median, 2),
      'top10-rows': fixed(summary.top10RowsPct, 2) + '%', 'top10-impressions': fixed(summary.top10ImpressionsPct, 2) + '%',
      'beyond20-rows': fixed(summary.beyond20RowsPct, 2) + '%', 'beyond20-impressions': fixed(summary.beyond20ImpressionsPct, 2) + '%',
    };
    for (const [key, value] of Object.entries(values)) { const node = out('ap-' + key); if (node) node.textContent = value; }
    results.hidden = false;
  };
  const run = () => {
    const parsed = parseRows(input.value);
    if (!parsed.ok) {
      reset();
      error.textContent = parsed.error;
      input.setAttribute('aria-invalid', 'true');
      return;
    }
    error.textContent = '';
    input.removeAttribute('aria-invalid');
    show(summarize(parsed.rows));
  };
  form.addEventListener('submit', event => { event.preventDefault(); run(); });
  example.addEventListener('click', () => { input.value = EXAMPLE; run(); });
  clear.addEventListener('click', () => { input.value = ''; error.textContent = ''; input.removeAttribute('aria-invalid'); reset(); input.focus(); });
  reset();
  for (const button of buttons) button.disabled = false;
  return true;
}

if (typeof document !== 'undefined') init(document);
