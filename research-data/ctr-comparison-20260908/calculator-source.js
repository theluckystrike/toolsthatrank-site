// Browser ES module: keep this source readable; no build-time dependencies.
"use strict";
const presets = {
  largest: {
    label: "Largest property",
    sourceId: "harvest",
    sourceUrl:
      "https://raw.githubusercontent.com/theluckystrike/toolsthatrank-site/ff05db5055435937525646008f96c4c1d77d4452/research-data/ctr-comparison-20260908/gsc-harvest.json",
    values: ["309177", "1160", "329175", "1068"],
  },
  pooled: {
    label: "All measured properties",
    sourceId: "audit",
    sourceUrl:
      "https://raw.githubusercontent.com/theluckystrike/toolsthatrank-site/ff05db5055435937525646008f96c4c1d77d4452/research-data/ctr-comparison-20260908/audit.json",
    values: ["424845", "1715", "462488", "1814"],
  },
  excluded: {
    label: "Same cohort excluding largest",
    sourceId: "audit",
    sourceUrl:
      "https://raw.githubusercontent.com/theluckystrike/toolsthatrank-site/ff05db5055435937525646008f96c4c1d77d4452/research-data/ctr-comparison-20260908/audit.json",
    values: ["115668", "555", "133313", "746"],
  },
};
const ids = [
  "earlier-impressions",
  "earlier-clicks",
  "later-impressions",
  "later-clicks",
];
const MAX_COUNT = 1e12;
const MAX_INPUT_LENGTH = 64;
const inputs = ids.map((id) => document.getElementById(id));
const form = document.getElementById("ctr-form");
const select = document.getElementById("preset");
const results = document.getElementById("calculator-results");
const status = document.getElementById("calculator-status");
const calculateButton = form?.querySelector('button[type="submit"]');
const resetButton = document.getElementById("reset");
const clearButton = document.getElementById("clear");
const errors = ids.map((id) => document.getElementById(id + "-error"));
let custom = false;
const format = new Intl.NumberFormat("en", { maximumFractionDigits: 4 });
function display(value, signed = false) {
  if (value === null) return "Undefined";
  const rounded = Number(value.toFixed(4));
  return (
    (signed && rounded > 0 ? "+" : "") +
    format.format(Object.is(rounded, -0) ? 0 : rounded)
  );
}
function resetErrors() {
  inputs.forEach((input) => {
    input.removeAttribute("aria-invalid");
    errors[inputs.indexOf(input)].textContent = "";
  });
}
function error(index, message) {
  const input = inputs[index];
  input.setAttribute("aria-invalid", "true");
  errors[inputs.indexOf(input)].textContent = message;
}
function invalidate() {
  results.replaceChildren();
  status.textContent = "";
}
function node(tag, text) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}
function anchor(url, label) {
  const element = node("a", label);
  element.href = url;
  return element;
}
function direction(label, before, after) {
  if (after > before) return label + " rose";
  if (after < before) return label + " fell";
  return label + " stayed the same";
}
function explainChange(ei, ec, li, lc, er, lr, preset) {
  const explanation = node("p");
  const rate =
    er === null || lr === null
      ? "CTR comparison is undefined because a period has no impressions"
      : direction("CTR", er, lr);
  explanation.append(
    document.createTextNode(
      direction("Clicks", ec, lc) +
        ". " +
        direction("Impressions", ei, li) +
        ". " +
        rate +
        ". ",
    ),
    anchor("#comparison-formula", "How this is calculated"),
  );
  if (!custom) {
    explanation.dataset.sourceId = preset.sourceId;
    explanation.append(
      document.createTextNode(" · "),
      anchor(preset.sourceUrl, "Measured input counts"),
    );
  }
  return explanation;
}
function readCounts(focusError) {
  const values = inputs.map((input, index) => {
    const raw = input.value;
    if (raw.length > MAX_INPUT_LENGTH) {
      error(index, "Use at most 64 digits per count.");
      return null;
    }
    if (raw === "") {
      error(index, "Enter a count.");
      return null;
    }
    if (!/^\d+$/.test(raw)) {
      error(
        index,
        "Use decimal digits only, with no signs, spaces, commas or decimal points.",
      );
      return null;
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value > MAX_COUNT) {
      error(index, "The count exceeds the supported limit.");
      return null;
    }
    return value;
  });
  for (const start of [0, 2]) {
    if (
      values[start] !== null &&
      values[start + 1] !== null &&
      values[start + 1] > values[start]
    )
      error(start + 1, "Clicks cannot exceed impressions.");
  }
  const invalid = inputs.find(
    (input) => input.getAttribute("aria-invalid") === "true",
  );
  if (invalid) {
    status.textContent = "Correct the marked fields, then calculate again.";
    if (focusError) invalid.focus();
    return null;
  }
  return values;
}

function compareCounts(values) {
  const [ei, ec, li, lc] = values;
  const er = ei === 0 ? null : ec / ei;
  const lr = li === 0 ? null : lc / li;
  const defined = er !== null && lr !== null;
  const pp = defined ? (lr - er) * 100 : null;
  const relative = defined && er !== 0 ? ((lr - er) / er) * 100 : null;
  const net = lc - ec;
  const impression = defined ? ((li - ei) * (er + lr)) / 2 : null;
  const ctr = defined ? ((lr - er) * (ei + li)) / 2 : null;
  const output = { ei, ec, li, lc, er, lr, defined, pp, relative, net, impression, ctr };
  const numeric = [er, lr, pp, relative, net, impression, ctr];
  if (!numeric.every((value) => value === null || Number.isFinite(value))) {
    throw new Error("The calculation produced an unsupported numeric result.");
  }
  // Count-scale tolerance accommodates cancellation at the supported upper limit.
  const tolerance = 16 * Number.EPSILON * Math.max(1, ei, li, Math.abs(net));
  if (defined && Math.abs(impression + ctr - net) > tolerance) {
    throw new Error("The click components did not reconcile.");
  }
  return output;
}

function renderHeading(preset) {
  results.append(node("h3", custom ? "Your inputs" : preset.label));
  if (!custom) {
    const provenance = node("p");
    provenance.dataset.sourceId = preset.sourceId;
    provenance.append(
      anchor(preset.sourceUrl, "Measured counts source"),
      document.createTextNode(" · "),
      anchor(
        "https://raw.githubusercontent.com/theluckystrike/toolsthatrank-site/ff05db5055435937525646008f96c4c1d77d4452/research-data/ctr-comparison-20260908/gsc-harvest.json",
        "Recorded API responses and fetch timestamp",
      ),
    );
    results.append(provenance);
  }
}

function renderCounts(comparison, preset) {
  const { ei, ec, li, lc, er, lr } = comparison;
  const counts = node("table");
  const caption = node("caption", "Counts and CTR");
  counts.append(caption);
  const head = node("thead");
  const header = node("tr");
  for (const label of ["Period", "Clicks", "Impressions", "CTR", "Source"]) {
    const cell = node("th", label);
    cell.scope = "col";
    header.append(cell);
  }
  head.append(header);
  counts.append(head);
  const body = node("tbody");
  for (const [label, clicks, impressions, rate] of [
    ["Earlier", ec, ei, er],
    ["Later", lc, li, lr],
  ]) {
    const row = node("tr");
    const title = node("th", label);
    title.scope = "row";
    row.append(
      title,
      node("td", display(clicks)),
      node("td", display(impressions)),
      node("td", rate === null ? "Undefined" : display(rate * 100) + "%"),
    );
    const source = node("td");
    if (!custom) {
      row.dataset.sourceId = preset.sourceId;
      source.append(
        anchor(preset.sourceUrl, "Counts source"),
        document.createTextNode(" · "),
      );
    } else source.append(document.createTextNode("Your inputs · "));
    source.append(
      anchor(
        "https://support.google.com/webmasters/answer/7576553?hl=en",
        "CTR definition",
      ),
    );
    row.append(source);
    body.append(row);
  }
  counts.append(body);
  results.append(counts);
}

function renderChanges(comparison, preset) {
  const { pp, relative, net, impression, ctr } = comparison;
  const changes = node("table");
  changes.append(node("caption", "Change and symmetric components"));
  const changeBody = node("tbody");
  for (const [label, value, unit] of [
    ["CTR change", pp, " percentage points"],
    ["Relative CTR change", relative, "%"],
    ["Net click change", net, Math.abs(net) === 1 ? " click" : " clicks"],
    ["Impression component", impression, " click equivalents"],
    ["CTR component", ctr, " click equivalents"],
  ]) {
    const row = node("tr");
    const title = node("th", label);
    title.scope = "row";
    const valueCell = node(
      "td",
      value === null ? "Undefined" : display(value, true) + unit,
    );
    const source = node("td");
    source.append(anchor("#comparison-formula", "Calculation method"));
    if (!custom) {
      source.append(
        document.createTextNode(" · "),
        anchor(preset.sourceUrl, "Input counts"),
      );
      row.dataset.sourceId = preset.sourceId;
    }
    row.append(title, valueCell, source);
    changeBody.append(row);
  }
  changes.append(changeBody);
  results.append(changes);
}

function renderSummary(comparison, preset) {
  const { ei, ec, li, lc, er, lr, defined } = comparison;
  results.append(explainChange(ei, ec, li, lc, er, lr, preset));
  if (!defined)
    results.append(
      node(
        "p",
        "CTR is undefined for a period without impressions. Both decomposition components are withheld. Review the raw click change above.",
      ),
    );
  else if (er === 0)
    results.append(
      node(
        "p",
        "Relative CTR change is undefined because earlier CTR is zero.",
      ),
    );
  status.textContent = custom
    ? "Your inputs calculated."
    : "Measured sample calculated.";
}

function selectedPreset() {
  if (!Object.hasOwn(presets, select.value)) {
    throw new Error("Select a valid measured sample before calculating.");
  }
  return presets[select.value];
}

function calculate(focusError = false) {
  invalidate();
  resetErrors();
  const preset = selectedPreset();
  const values = readCounts(focusError);
  if (values === null) return;
  const comparison = compareCounts(values);
  renderHeading(preset);
  renderCounts(comparison, preset);
  renderChanges(comparison, preset);
  renderSummary(comparison, preset);
}

function restore() {
  const preset = selectedPreset();
  custom = false;
  preset.values.forEach((value, index) => {
    inputs[index].value = value;
  });
  calculate();
}
// Unexpected integration failures withhold all calculated output.
function reportFailure(message) {
  results?.replaceChildren();
  if (status) {
    status.textContent = message;
    return;
  }
  const target = form || document.querySelector("main") || document.body;
  if (target) {
    const notice = node("p", message);
    notice.setAttribute("role", "alert");
    target.append(notice);
  }
}

function safely(action) {
  try {
    action();
    return true;
  } catch (failure) {
    const detail = failure instanceof Error ? failure.message : "Unexpected error.";
    reportFailure("Calculator unavailable. " + detail);
    return false;
  }
}

function editInputs() {
  custom = true;
  resetErrors();
  invalidate();
  status.textContent = "Your inputs. Select Calculate to update the results.";
}

function clearInputs() {
  custom = true;
  inputs.forEach((input) => { input.value = ""; });
  resetErrors();
  invalidate();
  status.textContent = "Your inputs. Fields cleared.";
  inputs[0].focus();
}

function initialize() {
  const required = [form, select, results, status, calculateButton, resetButton, clearButton,
    ...inputs, ...errors];
  if (required.some((element) => element == null)) {
    reportFailure("Calculator unavailable: required page elements are missing.");
    return;
  }
  inputs.forEach((input) => {
    input.addEventListener("input", () => safely(editInputs));
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    safely(() => calculate(true));
  });
  select.addEventListener("change", () => safely(restore));
  resetButton.addEventListener("click", () => safely(restore));
  clearButton.addEventListener("click", () => safely(clearInputs));
  if (!safely(restore)) return;
  for (const button of [calculateButton, resetButton, clearButton]) {
    button.disabled = false;
  }
}

initialize();
