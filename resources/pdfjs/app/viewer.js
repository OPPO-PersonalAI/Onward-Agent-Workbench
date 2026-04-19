/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Onward PDF viewer. Adapted from the Dark_PDF_Reader Chrome extension reference
 * (ISC-licensed) and stripped of all chrome.* / GitHub Issue / options-page code.
 * Loaded inside an <iframe> by the renderer; receives theme + i18n via postMessage.
 */

"use strict";

pdfjsLib.GlobalWorkerOptions.workerSrc = "../build/pdf.worker.js";

const DEFAULT_SCALE_VALUE = "page-width";
const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const SCALE_STEP = 1.1;

let outlineAutoFitTimer = null;
let outlineAutoFitVersion = 0;

const I18N_DEFAULTS = {
  toc: "Outline",
  prevPage: "Previous page",
  nextPage: "Next page",
  zoomOut: "Zoom out",
  zoomIn: "Zoom in",
  zoom: "Zoom",
  fitWidth: "Fit Width",
  fitPage: "Fit Page",
  searchPlaceholder: "Search text (Enter for next)",
  prevMatch: "Previous match",
  nextMatch: "Next match",
  colorToggleOn: "Temporarily disable dark",
  colorToggleOff: "Restore dark rendering",
  colorToggleTitleOn: "Temporarily view original colors",
  colorToggleTitleOff: "Restore Dark Mode rendering",
  close: "Close",
  cancel: "Cancel",
  confirm: "Confirm",
  passwordTitle: "Enter PDF password",
  passwordPrompt: "This PDF is encrypted. Please enter the password.",
  passwordIncorrect: "Incorrect password. Please try again.",
  emptyState: "No PDF loaded",
  errorInvalid: "The PDF file is corrupted or invalid.",
  errorMissing: "Unable to read the PDF file.",
  errorPassword: "The PDF requires a password; load was not completed.",
  errorUnexpected: "Unexpected response while reading the PDF.",
  errorGeneric: "Failed to open PDF."
};

const els = {
  fileName: document.getElementById("fileName"),
  prevPageBtn: document.getElementById("prevPageBtn"),
  nextPageBtn: document.getElementById("nextPageBtn"),
  pageNumberInput: document.getElementById("pageNumberInput"),
  pageCountLabel: document.getElementById("pageCountLabel"),
  zoomOutBtn: document.getElementById("zoomOutBtn"),
  zoomInBtn: document.getElementById("zoomInBtn"),
  zoomSelect: document.getElementById("zoomSelect"),
  customZoomOption: document.getElementById("customZoomOption"),
  searchInput: document.getElementById("searchInput"),
  searchPrevBtn: document.getElementById("searchPrevBtn"),
  searchNextBtn: document.getElementById("searchNextBtn"),
  searchResult: document.getElementById("searchResult"),
  colorToggleBtn: document.getElementById("colorToggleBtn"),
  outlinePanel: document.getElementById("outlinePanel"),
  outlineContainer: document.getElementById("outlineContainer"),
  viewerSection: document.getElementById("viewerSection"),
  viewerContainer: document.getElementById("viewerContainer"),
  viewer: document.getElementById("viewer"),
  errorBanner: document.getElementById("errorBanner"),
  errorMessage: document.getElementById("errorMessage"),
  errorCloseBtn: document.getElementById("errorCloseBtn"),
  passwordDialogBackdrop: document.getElementById("passwordDialogBackdrop"),
  passwordPrompt: document.getElementById("passwordPrompt"),
  passwordInput: document.getElementById("passwordInput"),
  passwordCancelBtn: document.getElementById("passwordCancelBtn"),
  passwordConfirmBtn: document.getElementById("passwordConfirmBtn")
};

const eventBus = new pdfjsViewer.EventBus();
const linkService = new pdfjsViewer.PDFLinkService({ eventBus });
const findController = new pdfjsViewer.PDFFindController({ eventBus, linkService });
const pdfViewer = new pdfjsViewer.PDFViewer({
  container: els.viewerContainer,
  viewer: els.viewer,
  eventBus,
  linkService,
  findController,
  removePageBorders: false,
  imageResourcesPath: "../web/images/"
});

linkService.setViewer(pdfViewer);

let currentLoadingTask = null;
let currentDocument = null;
let currentScaleSetting = DEFAULT_SCALE_VALUE;
let searchDebounceTimer = null;
let openToken = 0;
let pendingPasswordUpdate = null;
let passwordCancelledLoad = false;
let colorEnhancementEnabled = true;
let i18nDict = { ...I18N_DEFAULTS };

init();

function init() {
  bindUiEvents();
  bindViewerEvents();
  bindHostMessages();
  clearOutline();
  updatePageControls(1, 0);
  updateZoomUi({ scale: 1, presetValue: DEFAULT_SCALE_VALUE });
  applyI18nToDom();
  applyColorEnhancementState();
  loadFromQueryParam();
}

function bindHostMessages() {
  window.addEventListener("message", event => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "onward:pdf:theme") {
      applyThemeFromHost(data.vars || {});
    } else if (data.type === "onward:pdf:i18n") {
      i18nDict = { ...I18N_DEFAULTS, ...(data.strings || {}) };
      applyI18nToDom();
    } else if (data.type === "onward:pdf:colorEnhancement") {
      colorEnhancementEnabled = Boolean(data.enabled);
      applyColorEnhancementState();
    } else if (data.type === "onward:pdf:restoreState") {
      pendingRestoreState = {
        page: Number(data.page),
        scrollTop: Number(data.scrollTop),
        scale: typeof data.scale === "string" ? data.scale : null
      };
      applyRestoreStateIfReady();
    } else if (data.type === "onward:pdf:setOutlineOpen") {
      // Host drives outline visibility now that the in-viewer toggle is
      // gone — keeps the UX consistent with the Markdown outline button.
      if (data.open) {
        els.outlinePanel.classList.remove("collapsed");
        scheduleOutlineAwarePageWidth();
      } else {
        cancelOutlineAutoFit();
        els.outlinePanel.classList.add("collapsed");
      }
    }
  });
  // Notify host that viewer is ready.
  try {
    window.parent.postMessage({ type: "onward:pdf:ready" }, "*");
  } catch (_error) {
    // Ignore if no parent (standalone dev).
  }
}

function applyThemeFromHost(vars) {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(vars)) {
    if (typeof value !== "string") continue;
    // Only accept keys that look like CSS custom properties.
    if (!/^--[\w-]+$/.test(name)) continue;
    root.style.setProperty(name, value);
  }
}

function applyI18nToDom() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.getAttribute("data-i18n");
    if (key && i18nDict[key]) el.textContent = i18nDict[key];
  });
  document.querySelectorAll("[data-i18n-title]").forEach(el => {
    const key = el.getAttribute("data-i18n-title");
    if (key && i18nDict[key]) el.title = i18nDict[key];
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    const key = el.getAttribute("data-i18n-placeholder");
    if (key && i18nDict[key]) el.setAttribute("placeholder", i18nDict[key]);
  });
  // The color toggle has separate copy for enabled/disabled states; let
  // applyColorEnhancementState pick the right variant every time translations
  // arrive so it doesn't get stuck with stale English text.
  applyColorEnhancementState();
}

function loadFromQueryParam() {
  const params = new URLSearchParams(window.location.search);
  const fileParam = params.get("file");
  if (!fileParam) {
    setDocumentVisible(false);
    return;
  }
  // `file` is expected to be a fully-formed file:// URL or an absolute path the
  // renderer has already URL-encoded. pdf.js getDocument handles both.
  void openPdfUrl(fileParam, params.get("name") || basenameFromUrl(fileParam));
}

function bindUiEvents() {
  els.prevPageBtn.addEventListener("click", () => {
    if (!currentDocument) return;
    pdfViewer.currentPageNumber = clamp(pdfViewer.currentPageNumber - 1, 1, currentDocument.numPages);
  });

  els.nextPageBtn.addEventListener("click", () => {
    if (!currentDocument) return;
    pdfViewer.currentPageNumber = clamp(pdfViewer.currentPageNumber + 1, 1, currentDocument.numPages);
  });

  els.pageNumberInput.addEventListener("change", () => {
    jumpToPage(els.pageNumberInput.value);
  });

  els.zoomOutBtn.addEventListener("click", () => adjustZoom(1 / SCALE_STEP));
  els.zoomInBtn.addEventListener("click", () => adjustZoom(SCALE_STEP));

  els.zoomSelect.addEventListener("change", () => {
    if (!currentDocument) return;
    const value = els.zoomSelect.value;
    if (value === "page-width" || value === "page-fit") {
      pdfViewer.currentScaleValue = value;
      return;
    }
    const numeric = Number.parseFloat(value);
    if (!Number.isFinite(numeric)) return;
    pdfViewer.currentScaleValue = String(clamp(numeric, MIN_SCALE, MAX_SCALE));
  });

  els.searchInput.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    runFind({ type: "again", findPrevious: event.shiftKey });
  });

  els.searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => runFind({ type: "" }), 200);
  });

  els.searchPrevBtn.addEventListener("click", () => runFind({ type: "again", findPrevious: true }));
  els.searchNextBtn.addEventListener("click", () => runFind({ type: "again", findPrevious: false }));

  els.colorToggleBtn.addEventListener("click", () => {
    colorEnhancementEnabled = !colorEnhancementEnabled;
    applyColorEnhancementState();
  });

  els.errorCloseBtn.addEventListener("click", () => clearError());

  els.passwordCancelBtn.addEventListener("click", () => {
    closePasswordDialog();
    if (currentLoadingTask) {
      passwordCancelledLoad = true;
      currentLoadingTask.destroy();
    }
    showError(i18nDict.errorPassword);
  });

  els.passwordConfirmBtn.addEventListener("click", submitPassword);
  els.passwordInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitPassword();
    }
  });

  window.addEventListener("keydown", event => {
    const isCmd = event.ctrlKey || event.metaKey;
    if (isCmd && event.key.toLowerCase() === "f") {
      event.preventDefault();
      els.searchInput.focus();
      els.searchInput.select();
    }
  });
}

function bindViewerEvents() {
  eventBus.on("pagechanging", event => {
    updatePageControls(event.pageNumber, currentDocument?.numPages || 0);
    queueReadingStatePost();
  });
  eventBus.on("scalechanging", event => {
    updateZoomUi(event);
    queueReadingStatePost();
  });
  eventBus.on("updatefindmatchescount", event => updateSearchCount(event.matchesCount));
  eventBus.on("updatefindcontrolstate", event => updateSearchCount(event.matchesCount));

  // Scroll persistence: debounce a "state" message back to the host when the
  // user scrolls the viewer, so the host can remember where they were.
  els.viewerContainer.addEventListener(
    "scroll",
    () => { queueReadingStatePost(); },
    { passive: true }
  );
}

let readingStatePostTimer = null;
function queueReadingStatePost() {
  if (readingStatePostTimer) clearTimeout(readingStatePostTimer);
  readingStatePostTimer = setTimeout(() => {
    readingStatePostTimer = null;
    postReadingState();
  }, 250);
}

function postReadingState() {
  if (!currentDocument) return;
  try {
    window.parent.postMessage({
      type: "onward:pdf:state",
      page: pdfViewer.currentPageNumber,
      scrollTop: els.viewerContainer.scrollTop,
      scale: currentScaleSetting
    }, "*");
  } catch (_err) {
    /* ignore */
  }
}

let pendingRestoreState = null;
function applyRestoreStateIfReady() {
  if (!pendingRestoreState || !currentDocument) return;
  const state = pendingRestoreState;
  pendingRestoreState = null;
  try {
    if (typeof state.scale === "string" && state.scale.length > 0) {
      pdfViewer.currentScaleValue = state.scale;
    }
  } catch (_err) {
    /* ignore */
  }
  if (Number.isFinite(state.page)) {
    pdfViewer.currentPageNumber = clamp(Number(state.page), 1, currentDocument.numPages);
  }
  if (Number.isFinite(state.scrollTop)) {
    requestAnimationFrame(() => {
      els.viewerContainer.scrollTop = Math.max(0, Number(state.scrollTop));
    });
  }
}

async function openPdfUrl(url, displayName) {
  const token = ++openToken;
  clearError();
  els.fileName.textContent = displayName || "";
  els.fileName.title = displayName || "";

  await resetCurrentDocument();
  if (token !== openToken) return;

  const loadingTask = pdfjsLib.getDocument({
    url,
    cMapUrl: "../cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "../standard_fonts/",
    isEvalSupported: false,
    enableXfa: false
  });
  currentLoadingTask = loadingTask;
  passwordCancelledLoad = false;

  loadingTask.onPassword = (updatePassword, reason) => {
    if (token !== openToken) return;
    showPasswordDialog(updatePassword, reason);
  };

  let pdfDocument;
  try {
    pdfDocument = await loadingTask.promise;
  } catch (error) {
    currentLoadingTask = null;
    if (passwordCancelledLoad) {
      passwordCancelledLoad = false;
      return;
    }
    if (token !== openToken) return;
    handlePdfOpenError(error);
    return;
  }

  if (token !== openToken) {
    try {
      await pdfDocument.destroy();
    } catch (_error) {
      /* ignore */
    }
    return;
  }

  currentDocument = pdfDocument;
  currentLoadingTask = null;
  closePasswordDialog();

  eventBus.on(
    "pagesinit",
    () => {
      // Default-then-restore: set the baseline scale/page first, then apply
      // any host-provided state on top so the user returns to their last
      // reading spot. Missing/partial state falls back to the baseline.
      pdfViewer.currentScaleValue = DEFAULT_SCALE_VALUE;
      pdfViewer.currentPageNumber = 1;
      els.viewerContainer.scrollTop = 0;
      applyRestoreStateIfReady();
    },
    { once: true }
  );

  pdfViewer.setDocument(pdfDocument);
  linkService.setDocument(pdfDocument, null);

  updatePageControls(1, pdfDocument.numPages);
  updateSearchCount({ current: 0, total: 0 });
  setDocumentVisible(true);

  try {
    const hasOutline = await renderOutline(pdfDocument);
    applyAutoOutlineBehavior(hasOutline);
    try {
      window.parent.postMessage({ type: "onward:pdf:outlineStatus", hasOutline }, "*");
    } catch (_err) {
      /* ignore */
    }
  } catch (_error) {
    clearOutline();
    applyAutoOutlineBehavior(false);
    try {
      window.parent.postMessage({ type: "onward:pdf:outlineStatus", hasOutline: false }, "*");
    } catch (_err) {
      /* ignore */
    }
  }
}

async function resetCurrentDocument() {
  closePasswordDialog();
  currentScaleSetting = DEFAULT_SCALE_VALUE;
  passwordCancelledLoad = false;

  pdfViewer.setDocument(null);
  linkService.setDocument(null, null);

  const loadingTask = currentLoadingTask;
  currentLoadingTask = null;
  if (loadingTask) {
    try {
      await loadingTask.destroy();
    } catch (_error) {
      /* ignore */
    }
  }

  const oldDocument = currentDocument;
  currentDocument = null;
  if (oldDocument) {
    try {
      await oldDocument.destroy();
    } catch (_error) {
      /* ignore */
    }
  }

  clearOutline();
  updatePageControls(1, 0);
  updateSearchCount({ current: 0, total: 0 });
  setDocumentVisible(false);
}

function adjustZoom(ratio) {
  if (!currentDocument) return;
  const nextScale = clamp(Number((pdfViewer.currentScale * ratio).toFixed(2)), MIN_SCALE, MAX_SCALE);
  pdfViewer.currentScaleValue = String(nextScale);
}

function jumpToPage(value) {
  if (!currentDocument) return;
  let page = Number.parseInt(value, 10);
  if (!Number.isFinite(page)) page = pdfViewer.currentPageNumber;
  pdfViewer.currentPageNumber = clamp(page, 1, currentDocument.numPages);
}

function runFind({ type = "", findPrevious = false }) {
  const query = els.searchInput.value.trim();
  if (!query) {
    updateSearchCount({ current: 0, total: 0 });
    eventBus.dispatch("findbarclose", { source: window });
    return;
  }
  eventBus.dispatch("find", {
    source: window,
    type,
    query,
    phraseSearch: true,
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious,
    matchDiacritics: false
  });
}

async function renderOutline(pdfDocument) {
  const outline = await pdfDocument.getOutline();
  if (!outline?.length) {
    clearOutline();
    return false;
  }
  els.outlineContainer.textContent = "";
  const root = document.createElement("ul");
  appendOutlineItems(root, outline);
  els.outlineContainer.appendChild(root);
  return true;
}

// Matches the Dark_PDF_Reader behavior: when the document ships with an
// outline, auto-expand the outline pane. The initial zoom calculation was
// made against the collapsed layout, so we nudge to page-fit and then back
// to page-width once the panel's width transition settles — giving
// pdf.js a chance to measure the new viewport.
function applyAutoOutlineBehavior(hasOutline) {
  if (hasOutline) {
    els.outlinePanel.classList.remove("collapsed");
    scheduleOutlineAwarePageWidth();
    return;
  }
  cancelOutlineAutoFit();
  els.outlinePanel.classList.add("collapsed");
}

function scheduleOutlineAwarePageWidth() {
  cancelOutlineAutoFit();
  const runId = outlineAutoFitVersion;
  const panel = els.outlinePanel;

  const applyPageWidth = () => {
    if (runId !== outlineAutoFitVersion) return;
    if (!currentDocument || panel.classList.contains("collapsed")) return;
    pdfViewer.currentScaleValue = "page-fit";
    requestAnimationFrame(() => {
      if (runId !== outlineAutoFitVersion) return;
      if (!currentDocument || panel.classList.contains("collapsed")) return;
      pdfViewer.currentScaleValue = DEFAULT_SCALE_VALUE;
    });
  };

  const onTransitionEnd = event => {
    if (event.target !== panel) return;
    if (event.propertyName !== "width" && event.propertyName !== "opacity") return;
    panel.removeEventListener("transitionend", onTransitionEnd);
    clearTimeout(outlineAutoFitTimer);
    outlineAutoFitTimer = null;
    applyPageWidth();
  };

  panel.addEventListener("transitionend", onTransitionEnd);
  const transitionMs = getMaxTransitionTimeMs(panel);
  outlineAutoFitTimer = setTimeout(() => {
    panel.removeEventListener("transitionend", onTransitionEnd);
    outlineAutoFitTimer = null;
    applyPageWidth();
  }, Math.max(120, transitionMs + 80));
}

function cancelOutlineAutoFit() {
  outlineAutoFitVersion += 1;
  if (outlineAutoFitTimer) {
    clearTimeout(outlineAutoFitTimer);
    outlineAutoFitTimer = null;
  }
}

function getMaxTransitionTimeMs(element) {
  const style = getComputedStyle(element);
  const durations = parseTransitionTimeList(style.transitionDuration);
  const delays = parseTransitionTimeList(style.transitionDelay);
  if (!durations.length) return 0;
  const count = Math.max(durations.length, delays.length || 1);
  let maxTime = 0;
  for (let i = 0; i < count; i += 1) {
    const d = durations[i % durations.length] || 0;
    const g = (delays.length ? delays[i % delays.length] : 0) || 0;
    maxTime = Math.max(maxTime, d + g);
  }
  return maxTime;
}

function parseTransitionTimeList(value) {
  return String(value || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => {
      if (item.endsWith("ms")) { const ms = Number.parseFloat(item.slice(0, -2)); return Number.isFinite(ms) ? ms : 0; }
      if (item.endsWith("s")) { const s = Number.parseFloat(item.slice(0, -1)); return Number.isFinite(s) ? s * 1000 : 0; }
      const f = Number.parseFloat(item); return Number.isFinite(f) ? f * 1000 : 0;
    });
}

function appendOutlineItems(parent, items) {
  for (const item of items) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "outline-item";
    button.textContent = item.title || "";
    button.addEventListener("click", () => {
      if (item.dest) linkService.goToDestination(item.dest);
      else if (item.url) window.open(item.url, "_blank", "noopener");
    });
    li.appendChild(button);
    if (item.items?.length) {
      const childList = document.createElement("ul");
      appendOutlineItems(childList, item.items);
      li.appendChild(childList);
    }
    parent.appendChild(li);
  }
}

function clearOutline() {
  els.outlineContainer.textContent = "";
}

function updatePageControls(pageNumber, pageCount) {
  const hasDocument = pageCount > 0;
  els.pageNumberInput.max = String(Math.max(pageCount, 1));
  els.pageNumberInput.value = String(Math.max(pageNumber, 1));
  els.pageCountLabel.textContent = `/ ${pageCount}`;
  els.prevPageBtn.disabled = !hasDocument || pageNumber <= 1;
  els.nextPageBtn.disabled = !hasDocument || pageNumber >= pageCount;
}

function updateZoomUi({ scale, presetValue }) {
  const optionValues = new Set(Array.from(els.zoomSelect.options, option => option.value));
  if (presetValue && optionValues.has(String(presetValue))) {
    currentScaleSetting = String(presetValue);
    els.customZoomOption.hidden = true;
    els.zoomSelect.value = String(presetValue);
    return;
  }
  const numericScale = clamp(Number(scale) || 1, MIN_SCALE, MAX_SCALE);
  const value = String(Number(numericScale.toFixed(2)));
  currentScaleSetting = value;
  els.customZoomOption.hidden = false;
  els.customZoomOption.value = value;
  els.customZoomOption.textContent = `${Math.round(numericScale * 100)}%`;
  els.zoomSelect.value = value;
}

function updateSearchCount(matchesCount) {
  const current = Number(matchesCount?.current || 0);
  const total = Number(matchesCount?.total || 0);
  els.searchResult.textContent = `${current} / ${total}`;
}

function setDocumentVisible(visible) {
  els.viewerSection.classList.toggle("has-document", visible);
}

function showPasswordDialog(updatePassword, reason) {
  pendingPasswordUpdate = updatePassword;
  const prompt =
    reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD
      ? i18nDict.passwordIncorrect
      : i18nDict.passwordPrompt;
  els.passwordPrompt.textContent = prompt;
  els.passwordInput.value = "";
  els.passwordDialogBackdrop.hidden = false;
  els.passwordInput.focus();
}

function closePasswordDialog() {
  pendingPasswordUpdate = null;
  els.passwordDialogBackdrop.hidden = true;
  els.passwordInput.value = "";
}

function submitPassword() {
  const password = els.passwordInput.value;
  if (!pendingPasswordUpdate) {
    closePasswordDialog();
    return;
  }
  if (!password) {
    els.passwordInput.focus();
    return;
  }
  pendingPasswordUpdate(password);
  closePasswordDialog();
}

function showError(summary, detail = "") {
  els.errorMessage.textContent = "";
  const summaryNode = document.createElement("strong");
  summaryNode.textContent = summary;
  els.errorMessage.appendChild(summaryNode);
  if (detail) {
    const detailNode = document.createElement("span");
    detailNode.textContent = detail;
    els.errorMessage.appendChild(detailNode);
  }
  els.errorBanner.hidden = false;
}

function clearError() {
  els.errorBanner.hidden = true;
  els.errorMessage.textContent = "";
}

function handlePdfOpenError(error) {
  closePasswordDialog();
  const errorName = error?.name || "UnknownError";
  const errorMessage = error?.message || "";
  const details = errorMessage ? `${errorName}: ${errorMessage}` : errorName;
  switch (errorName) {
    case "InvalidPDFException":
      showError(i18nDict.errorInvalid, details);
      break;
    case "MissingPDFException":
      showError(i18nDict.errorMissing, details);
      break;
    case "PasswordException":
      showError(i18nDict.errorPassword, details);
      break;
    case "UnexpectedResponseException":
      showError(i18nDict.errorUnexpected, details);
      break;
    default:
      showError(i18nDict.errorGeneric, details);
      break;
  }
}

function applyColorEnhancementState() {
  const isEnabled = colorEnhancementEnabled !== false;
  els.viewer.classList.toggle("dark-invert", isEnabled);
  document.documentElement.classList.toggle("color-enhancement-off", !isEnabled);
  els.colorToggleBtn.classList.toggle("is-off", !isEnabled);
  els.colorToggleBtn.setAttribute("aria-pressed", !isEnabled ? "true" : "false");
  // Reflect the current mode in the label so the button reads as an action the
  // user can take from here (not the state they're currently in). When dark
  // rendering is ON, the action is "temporarily disable dark"; when OFF, the
  // action is "restore dark rendering". Matches the reference viewer's copy.
  const labelKey = isEnabled ? "colorToggleOn" : "colorToggleOff";
  const titleKey = isEnabled ? "colorToggleTitleOn" : "colorToggleTitleOff";
  els.colorToggleBtn.textContent = i18nDict[labelKey] ?? I18N_DEFAULTS[labelKey];
  els.colorToggleBtn.title = i18nDict[titleKey] ?? I18N_DEFAULTS[titleKey];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function basenameFromUrl(url) {
  try {
    const parsed = new URL(url, "file:///");
    const parts = parsed.pathname.split("/").filter(Boolean);
    return decodeURIComponent(parts[parts.length - 1] || "");
  } catch (_error) {
    return "";
  }
}
