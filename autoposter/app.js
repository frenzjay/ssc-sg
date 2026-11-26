/**
 * autoPub Editorial Studio — Interactive Workspace Controller
 * Features:
 * - Full Local Progress Persistence (IndexedDB for photos/crops/SVG/PNGs + sync localStorage backup)
 * - Automatic Restore on Page Refresh (photos, pan/zoom, per-photo overrides, text, layout, ratio)
 * - Reset Studio & Clear Photos Confirmation Modal
 * - 30 Transparent Editable SSC-SG SVG Templates + Direct Stage Pan/Zoom
 */

(function () {
  'use strict';

  const PT = window.PubmatTemplates;

  const RESOLUTION_PRESETS = {
    highres: {
      'ssc': { width: 2000, height: 1414 },
      '4x3': { width: 1440, height: 1080 },
      '4:3': { width: 1440, height: 1080 },
      '16x9': { width: 2400, height: 1350 },
      '16:9': { width: 2400, height: 1350 }
    },
    standard: {
      'ssc': { width: 1414, height: 1000 },
      '4x3': { width: 1200, height: 900 },
      '4:3': { width: 1200, height: 900 },
      '16x9': { width: 1920, height: 1080 },
      '16:9': { width: 1920, height: 1080 }
    }
  };

  function normalizeFormatKey(fmt) {
    if (!fmt) return 'ssc';
    const s = String(fmt).replace(':', 'x').toLowerCase();
    if (s === 'ssc') return 'ssc';
    return s.includes('16') ? '16x9' : '4x3';
  }

  function displayFormatLabel(fmt) {
    const k = normalizeFormatKey(fmt);
    if (k === 'ssc') return 'SSC';
    if (k === '16x9') return '16:9';
    return '4:3';
  }

  const DB_NAME = 'autopub_studio_db';
  const DB_VERSION = 1;
  const WORKSPACE_LS_KEY = 'autopub_workspace_meta_v3';
  const LEGACY_KEYS = ['pubmat_settings', 'pubmat_settings_v2', 'pubmat_custom_borders', 'pubmat_post_editor_v1'];

  const DEFAULT_SETTINGS = {
    resolutionPreset: 'highres',
    prefix: 'pubmat_',
    format: 'image/png'
  };

  const defaultPostFields = PT ? Object.assign({}, PT.DEFAULT_FIELDS) : {
    showStory: true,
    category: 'OFFICIAL ANNOUNCEMENT',
    date: 'NOVEMBER 26, 2026 • LARENA, SIQUIJOR',
    heading: 'SSC Celebrates Lorem Ipsum Dolor Sit Amet',
    caption: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam.',
    orgTitle: 'SIQUIJOR STATE COLLEGE',
    orgSubtitle: 'STUDENT GOVERNMENT',
    facebook: 'Siquijor State College - Student Government',
    email: 'sgoffice@siquijorstate.edu.ph'
  };

  const state = {
    settings: Object.assign({}, DEFAULT_SETTINGS),
    templateMode: 'preset', // 'preset' | 'svg' | 'png'
    activePresetId: 'v3_01',
    presetSeriesFilter: 'all',
    presetSearchQuery: '',
    stageBackdrop: 'checker', // 'checker' | 'sample'
    customSvgText: null,
    customSvgName: '',
    postFields: Object.assign({}, defaultPostFields),
    borderImages: { '4x3': null, '4:3': null, '16x9': null, '16:9': null },
    borderSources: { '4x3': null, '4:3': null, '16x9': null, '16:9': null },
    borderStatus: { '4x3': 'sample', '4:3': 'sample', '16x9': 'sample', '16:9': 'sample' },
    items: [],
    selectedItemId: null,
    editScope: 'global', // 'global' | 'item'
    globalFormatOverride: 'ssc',
    holdRawPreview: false,
    stageDrag: { active: false, startX: 0, startY: 0 },
    resetModalAction: 'all' // 'all' | 'photos'
  };

  const svgImageCache = new Map();
  const thumbBlobUrls = new Map();
  let livePreviewTimer = null;
  let batchRenderTimer = null;
  let panCommitTimer = null;
  let metaSaveTimer = null;
  const itemSaveTimers = new Map();
  let pendingDbOps = 0;
  let isExportingZip = false;
  let renderGen = 0;

  // =========================================================================
  // LOCAL PERSISTENCE ENGINE (IndexedDB + Synchronous localStorage Backup)
  // =========================================================================
  const StudioDB = (function () {
    let dbPromise = null;

    function open() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve) => {
        if (typeof indexedDB === 'undefined') return resolve(null);
        try {
          const req = indexedDB.open(DB_NAME, DB_VERSION);
          req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('meta')) {
              db.createObjectStore('meta', { keyPath: 'key' });
            }
            if (!db.objectStoreNames.contains('items')) {
              db.createObjectStore('items', { keyPath: 'id' });
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => {
            console.warn('IndexedDB unavailable, falling back to localStorage.');
            resolve(null);
          };
        } catch (err) {
          resolve(null);
        }
      });
      return dbPromise;
    }

    async function put(storeName, value) {
      const db = await open();
      if (!db) return false;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(storeName, 'readwrite');
          tx.objectStore(storeName).put(value);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        } catch (e) {
          resolve(false);
        }
      });
    }

    async function get(storeName, key) {
      const db = await open();
      if (!db) return null;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(storeName, 'readonly');
          const req = tx.objectStore(storeName).get(key);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        } catch (e) {
          resolve(null);
        }
      });
    }

    async function getAll(storeName) {
      const db = await open();
      if (!db) return [];
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(storeName, 'readonly');
          const req = tx.objectStore(storeName).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve([]);
        } catch (e) {
          resolve([]);
        }
      });
    }

    async function del(storeName, key) {
      const db = await open();
      if (!db) return false;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(storeName, 'readwrite');
          tx.objectStore(storeName).delete(key);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        } catch (e) {
          resolve(false);
        }
      });
    }

    async function clearStore(storeName) {
      const db = await open();
      if (!db) return false;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(storeName, 'readwrite');
          tx.objectStore(storeName).clear();
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        } catch (e) {
          resolve(false);
        }
      });
    }

    return { open, put, get, getAll, del, clearStore };
  })();

  // --- DOM Elements ---
  const saveStatusBadge = document.getElementById('saveStatusBadge');
  const saveStatusText = document.getElementById('saveStatusText');
  const ratioSegmented = document.getElementById('ratioSegmented');
  const fileInput = document.getElementById('fileInput');
  const btnAddPhotosTop = document.getElementById('btnAddPhotosTop');
  const btnResetWorkspace = document.getElementById('btnResetWorkspace');
  const btnFilmstripAdd = document.getElementById('btnFilmstripAdd');
  const btnEmptyDropPrompt = document.getElementById('btnEmptyDropPrompt');
  const btnPrimaryExport = document.getElementById('btnPrimaryExport');
  const primaryExportLabel = document.getElementById('primaryExportLabel');

  const mobileWorkspaceTabs = document.getElementById('mobileWorkspaceTabs');
  const paneTemplates = document.getElementById('paneTemplates');
  const paneStage = document.getElementById('paneStage');
  const paneInspector = document.getElementById('paneInspector');

  // Left Drawer
  const templateModeTabs = document.getElementById('templateModeTabs');
  const panelModePreset = document.getElementById('panelModePreset');
  const panelModeSvg = document.getElementById('panelModeSvg');
  const panelModePng = document.getElementById('panelModePng');
  const presetSearchInput = document.getElementById('presetSearchInput');
  const presetSeriesFilter = document.getElementById('presetSeriesFilter');
  const presetGalleryGrid = document.getElementById('presetGalleryGrid');

  const inputCustomSvg = document.getElementById('inputCustomSvg');
  const btnUploadCustomSvg = document.getElementById('btnUploadCustomSvg');
  const btnClearCustomSvg = document.getElementById('btnClearCustomSvg');
  const previewCustomSvg = document.getElementById('previewCustomSvg');
  const placeholderCustomSvg = document.getElementById('placeholderCustomSvg');
  const customSvgFilename = document.getElementById('customSvgFilename');
  const badgeStatusSvg = document.getElementById('badgeStatusSvg');

  const badgeStatus4x3 = document.getElementById('badgeStatus4x3');
  const badgeStatus16x9 = document.getElementById('badgeStatus16x9');
  const previewBorder4x3 = document.getElementById('previewBorder4x3');
  const previewBorder16x9 = document.getElementById('previewBorder16x9');
  const placeholder4x3 = document.getElementById('placeholder4x3');
  const placeholder16x9 = document.getElementById('placeholder16x9');
  const btnUploadBorder4x3 = document.getElementById('btnUploadBorder4x3');
  const inputCustomBorder4x3 = document.getElementById('inputCustomBorder4x3');
  const btnUploadBorder16x9 = document.getElementById('btnUploadBorder16x9');
  const inputCustomBorder16x9 = document.getElementById('inputCustomBorder16x9');
  const btnNone4x3 = document.getElementById('btnNone4x3');
  const btnNone16x9 = document.getElementById('btnNone16x9');
  const btnSample4x3 = document.getElementById('btnSample4x3');
  const btnSample16x9 = document.getElementById('btnSample16x9');
  const btnResetBorders = document.getElementById('btnResetBorders');

  // Center Stage & Filmstrip
  const activePresetNameEl = document.getElementById('activePresetName');
  const stageResolutionMeta = document.getElementById('stageResolutionMeta');
  const emptyStageBgToggle = document.getElementById('emptyStageBgToggle');
  const btnLiveBgChecker = document.getElementById('btnLiveBgChecker');
  const btnLiveBgSample = document.getElementById('btnLiveBgSample');
  const btnExportActiveSvg = document.getElementById('btnExportActiveSvg');
  const btnExportActivePng = document.getElementById('btnExportActivePng');

  const dropzone = document.getElementById('dropzone');
  const artboardWrap = document.getElementById('artboardWrap');
  const liveOverlayImg = document.getElementById('liveOverlayImg');
  const stageCanvas = document.getElementById('stageCanvas');

  const stageFramingBar = document.getElementById('stageFramingBar');
  const stageZoomSlider = document.getElementById('stageZoomSlider');
  const stageZoomVal = document.getElementById('stageZoomVal');
  const btnStageResetCrop = document.getElementById('btnStageResetCrop');
  const btnToggleRawHold = document.getElementById('btnToggleRawHold');
  const btnDownloadCurrent = document.getElementById('btnDownloadCurrent');

  const progressBarContainer = document.getElementById('progressBarContainer');
  const progressBar = document.getElementById('progressBar');
  const filmstripCountLabel = document.getElementById('filmstripCountLabel');
  const filmstripSubHint = document.getElementById('filmstripSubHint');
  const filmstripBatchActions = document.getElementById('filmstripBatchActions');
  const btnDownloadAllZip = document.getElementById('btnDownloadAllZip');
  const btnClearAll = document.getElementById('btnClearAll');
  const imageGrid = document.getElementById('imageGrid');

  // Right Inspector
  const inspectorScopeBar = document.getElementById('inspectorScopeBar');
  const editScopeTabs = document.getElementById('editScopeTabs');
  const btnScopeItem = document.getElementById('btnScopeItem');
  const itemOverrideBanner = document.getElementById('itemOverrideBanner');
  const chkItemCustomText = document.getElementById('chkItemCustomText');
  const overridePhotoName = document.getElementById('overridePhotoName');
  const btnResetItemOverrides = document.getElementById('btnResetItemOverrides');
  const itemTemplateSelect = document.getElementById('itemTemplateSelect');

  const chkShowStory = document.getElementById('chkShowStory');
  const storyFieldsContainer = document.getElementById('storyFieldsContainer');
  const inputCategory = document.getElementById('inputCategory');
  const inputDate = document.getElementById('inputDate');
  const btnSetToday = document.getElementById('btnSetToday');
  const inputHeading = document.getElementById('inputHeading');
  const btnClearHeading = document.getElementById('btnClearHeading');
  const inputCaption = document.getElementById('inputCaption');
  const btnClearCaption = document.getElementById('btnClearCaption');
  const inputOrgTitle = document.getElementById('inputOrgTitle');
  const inputOrgSubtitle = document.getElementById('inputOrgSubtitle');
  const inputFacebook = document.getElementById('inputFacebook');
  const inputEmail = document.getElementById('inputEmail');
  const btnResetTextDefaults = document.getElementById('btnResetTextDefaults');

  // Modals
  const settingsModal = document.getElementById('settingsModal');
  const btnOpenSettings = document.getElementById('btnOpenSettings');
  const btnCloseSettingsModal = document.getElementById('btnCloseSettingsModal');
  const btnCancelSettings = document.getElementById('btnCancelSettings');
  const btnSaveSettings = document.getElementById('btnSaveSettings');
  const settingResolution = document.getElementById('settingResolution');
  const settingFormat = document.getElementById('settingFormat');
  const settingPrefix = document.getElementById('settingPrefix');

  const resetModal = document.getElementById('resetModal');
  const resetModalHeading = document.getElementById('resetModalHeading');
  const resetModalDesc = document.getElementById('resetModalDesc');
  const resetSummaryBox = document.getElementById('resetSummaryBox');
  const btnCloseResetModal = document.getElementById('btnCloseResetModal');
  const btnCancelReset = document.getElementById('btnCancelReset');
  const btnConfirmReset = document.getElementById('btnConfirmReset');

  // --- Save Status Indicator Helpers ---
  function setSaveBadge(saving, customLabel) {
    if (!saveStatusBadge || !saveStatusText) return;
    saveStatusBadge.classList.toggle('is-saving', Boolean(saving));
    saveStatusText.textContent = customLabel || (saving ? 'Saving…' : 'Saved locally');
  }

  function buildWorkspaceSnapshot() {
    return {
      key: 'workspace',
      updatedAt: Date.now(),
      settings: Object.assign({}, state.settings),
      templateMode: state.templateMode,
      activePresetId: state.activePresetId,
      presetSeriesFilter: state.presetSeriesFilter,
      presetSearchQuery: state.presetSearchQuery,
      stageBackdrop: state.stageBackdrop,
      globalFormatOverride: state.globalFormatOverride,
      editScope: state.editScope,
      selectedItemId: state.selectedItemId,
      postFields: Object.assign({}, state.postFields),
      customSvgText: state.customSvgText,
      customSvgName: state.customSvgName,
      itemOrder: state.items.map(i => i.id)
    };
  }

  function writeSnapshotToLocalStorageSync(snap) {
    try {
      const lite = Object.assign({}, snap, {
        customSvgText: snap.customSvgText && snap.customSvgText.length < 300000 ? snap.customSvgText : null
      });
      localStorage.setItem(WORKSPACE_LS_KEY, JSON.stringify(lite));
    } catch (e) {}
  }

  function persistWorkspaceMeta(immediate) {
    setSaveBadge(true);
    const snap = buildWorkspaceSnapshot();
    writeSnapshotToLocalStorageSync(snap);

    if (metaSaveTimer) clearTimeout(metaSaveTimer);
    const flush = async () => {
      pendingDbOps++;
      try {
        await StudioDB.put('meta', snap);
      } finally {
        pendingDbOps = Math.max(0, pendingDbOps - 1);
        if (pendingDbOps === 0) setSaveBadge(false);
      }
    };

    if (immediate) {
      flush();
    } else {
      metaSaveTimer = setTimeout(flush, 180);
    }
  }

  function serializeItemRecord(item, orderIndex) {
    return {
      id: item.id,
      order: orderIndex != null ? orderIndex : state.items.indexOf(item),
      name: item.name,
      blob: item.blob || item.file || null,
      fallbackDataUrl: (!item.blob && !item.file) ? item.originalDataUrl : null,
      originalWidth: item.originalWidth,
      originalHeight: item.originalHeight,
      ratio: item.ratio,
      detectedFormat: item.detectedFormat,
      chosenFormat: item.chosenFormat,
      panX: item.panX,
      panY: item.panY,
      zoom: item.zoom,
      overrideTemplateId: item.overrideTemplateId || null,
      customFields: item.customFields ? Object.assign({}, item.customFields) : null
    };
  }

  async function persistItemNow(item, orderIndex) {
    setSaveBadge(true);
    pendingDbOps++;
    try {
      await StudioDB.put('items', serializeItemRecord(item, orderIndex));
    } finally {
      pendingDbOps = Math.max(0, pendingDbOps - 1);
      if (pendingDbOps === 0) setSaveBadge(false);
    }
  }

  function schedulePersistItem(item) {
    setSaveBadge(true);
    if (itemSaveTimers.has(item.id)) {
      clearTimeout(itemSaveTimers.get(item.id));
    }
    const t = setTimeout(() => {
      itemSaveTimers.delete(item.id);
      persistItemNow(item);
      persistWorkspaceMeta(true);
    }, 200);
    itemSaveTimers.set(item.id, t);
  }

  async function persistBordersState() {
    setSaveBadge(true);
    pendingDbOps++;
    try {
      const record = {
        key: 'borders',
        status4x3: state.borderStatus['4x3'],
        status16x9: state.borderStatus['16x9'],
        src4x3: state.borderStatus['4x3'] === 'custom' ? state.borderSources['4x3'] : null,
        src16x9: state.borderStatus['16x9'] === 'custom' ? state.borderSources['16x9'] : null
      };
      await StudioDB.put('meta', record);
    } finally {
      pendingDbOps = Math.max(0, pendingDbOps - 1);
      if (pendingDbOps === 0) setSaveBadge(false);
    }
  }

  // --- Initialization & Full Session Restore ---
  async function init() {
    populatePerItemTemplateDropdown();
    await restoreSession();
    syncAllChromeControlsFromState();
    renderPresetGallery();
    syncInspectorFromActiveScope();
    updateTemplateModeUI();
    updateStageAndPrimaryCTA();
    setupEventListeners();
  }

  async function restoreSession() {
    let lsSnap = null;
    try {
      const raw = localStorage.getItem(WORKSPACE_LS_KEY);
      if (raw) lsSnap = JSON.parse(raw);
    } catch (e) {}

    const idbSnap = await StudioDB.get('meta', 'workspace');
    let snap = idbSnap;
    if (lsSnap && (!idbSnap || (lsSnap.updatedAt || 0) > (idbSnap.updatedAt || 0))) {
      snap = Object.assign({}, idbSnap || {}, lsSnap);
      if (!snap.customSvgText && idbSnap && idbSnap.customSvgText) {
        snap.customSvgText = idbSnap.customSvgText;
      }
    }

    if (snap) {
      if (snap.settings) Object.assign(state.settings, snap.settings);
      if (snap.templateMode) state.templateMode = snap.templateMode;
      if (snap.activePresetId) state.activePresetId = snap.activePresetId;
      if (snap.presetSeriesFilter) state.presetSeriesFilter = snap.presetSeriesFilter;
      if (typeof snap.presetSearchQuery === 'string') state.presetSearchQuery = snap.presetSearchQuery;
      if (snap.stageBackdrop) state.stageBackdrop = snap.stageBackdrop;
      if (snap.globalFormatOverride) state.globalFormatOverride = snap.globalFormatOverride;
      if (snap.editScope) state.editScope = snap.editScope;
      if (snap.selectedItemId) state.selectedItemId = snap.selectedItemId;
      if (snap.postFields) Object.assign(state.postFields, snap.postFields);
      if (snap.customSvgText) {
        state.customSvgText = snap.customSvgText;
        state.customSvgName = snap.customSvgName || 'custom.svg';
      }
    }

    await loadBorders();

    // Restore uploaded photos + pan/zoom + per-photo overrides from IndexedDB
    const savedRecords = await StudioDB.getAll('items');
    if (savedRecords && savedRecords.length > 0) {
      const orderMap = new Map();
      if (snap && Array.isArray(snap.itemOrder)) {
        snap.itemOrder.forEach((id, idx) => orderMap.set(id, idx));
      }
      savedRecords.sort((a, b) => {
        const oa = orderMap.has(a.id) ? orderMap.get(a.id) : (a.order != null ? a.order : 9999);
        const ob = orderMap.has(b.id) ? orderMap.get(b.id) : (b.order != null ? b.order : 9999);
        return oa - ob;
      });

      showProgress(10);
      for (let i = 0; i < savedRecords.length; i++) {
        const rec = savedRecords[i];
        const restored = await reconstructItemFromRecord(rec);
        if (restored) {
          state.items.push(restored);
          appendFilmstripThumb(restored);
          await renderItem(restored);
        }
        showProgress(((i + 1) / savedRecords.length) * 100);
      }
      setTimeout(hideProgress, 250);

      if (!state.selectedItemId || !state.items.some(it => it.id === state.selectedItemId)) {
        state.selectedItemId = state.items[0] ? state.items[0].id : null;
      }
      document.querySelectorAll('.film-thumb').forEach(el => {
        el.classList.toggle('active', el.dataset.itemId === state.selectedItemId);
      });
    } else {
      state.selectedItemId = null;
    }

    setSaveBadge(false, snap || (savedRecords && savedRecords.length) ? 'Restored & saved' : 'Saved locally');
    if (snap || (savedRecords && savedRecords.length)) {
      setTimeout(() => {
        if (pendingDbOps === 0) setSaveBadge(false, 'Saved locally');
      }, 2200);
    }
  }

  function reconstructItemFromRecord(rec) {
    return new Promise((resolve) => {
      if (!rec) return resolve(null);
      let objectUrl = null;
      let src = rec.fallbackDataUrl || null;
      if (rec.blob instanceof Blob) {
        objectUrl = URL.createObjectURL(rec.blob);
        src = objectUrl;
      }
      if (!src) return resolve(null);

      const img = new Image();
      img.onload = () => {
        resolve({
          id: rec.id,
          file: null,
          blob: rec.blob || null,
          objectUrl,
          imgObj: img,
          name: rec.name || 'photo.jpg',
          originalWidth: rec.originalWidth || img.naturalWidth || img.width,
          originalHeight: rec.originalHeight || img.naturalHeight || img.height,
          originalDataUrl: src,
          ratio: rec.ratio || ((img.naturalWidth || 1) / (img.naturalHeight || 1)),
          detectedFormat: rec.detectedFormat || '4:3',
          chosenFormat: rec.chosenFormat || 'ssc',
          panX: Number(rec.panX) || 0,
          panY: Number(rec.panY) || 0,
          zoom: Number(rec.zoom) || 1.0,
          overrideTemplateId: rec.overrideTemplateId || null,
          customFields: rec.customFields || null,
          renderedDataUrl: null,
          renderedBlob: null
        });
      };
      img.onerror = () => {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        resolve(null);
      };
      img.src = src;
    });
  }

  function syncAllChromeControlsFromState() {
    if (settingResolution) settingResolution.value = state.settings.resolutionPreset;
    if (settingFormat) settingFormat.value = state.settings.format;
    if (settingPrefix) settingPrefix.value = state.settings.prefix;

    if (ratioSegmented) {
      ratioSegmented.querySelectorAll('.seg-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.ratio === state.globalFormatOverride);
      });
    }

    if (presetSeriesFilter) {
      presetSeriesFilter.querySelectorAll('.filter-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.series === state.presetSeriesFilter);
      });
    }

    if (presetSearchInput) {
      presetSearchInput.value = state.presetSearchQuery;
    }

    if (artboardWrap && btnLiveBgChecker && btnLiveBgSample) {
      const isSample = state.stageBackdrop === 'sample';
      btnLiveBgSample.classList.toggle('active', isSample);
      btnLiveBgChecker.classList.toggle('active', !isSample);
      artboardWrap.classList.toggle('sample-backdrop', isSample);
      artboardWrap.classList.toggle('checker-dark', !isSample);
    }
  }

  // --- Reset Confirmation Modal & Full Reset Execution ---
  function openResetModal(mode) {
    state.resetModalAction = mode === 'photos' ? 'photos' : 'all';
    const photoCount = state.items.length;

    if (state.resetModalAction === 'photos') {
      if (photoCount === 0) return;
      if (resetModalHeading) resetModalHeading.textContent = 'Clear All Photos?';
      if (resetModalDesc) {
        resetModalDesc.textContent = 'This will remove all uploaded photos and their crop adjustments from the filmstrip. Your post text and layout selection will be kept.';
      }
      if (resetSummaryBox) {
        resetSummaryBox.textContent = `${photoCount} ${photoCount === 1 ? 'photo' : 'photos'} will be removed from local storage.`;
      }
      if (btnConfirmReset) btnConfirmReset.textContent = 'Clear Photos';
    } else {
      if (resetModalHeading) resetModalHeading.textContent = 'Reset Studio Progress?';
      if (resetModalDesc) {
        resetModalDesc.textContent = 'This will clear all uploaded photos, crop & zoom adjustments, custom templates, and edited post text from local storage, restoring the studio to factory defaults.';
      }
      const parts = [];
      if (photoCount > 0) parts.push(`${photoCount} uploaded ${photoCount === 1 ? 'photo' : 'photos'}`);
      parts.push('post text edits', 'layout & export settings');
      if (resetSummaryBox) {
        resetSummaryBox.textContent = `Will reset: ${parts.join(', ')}.`;
      }
      if (btnConfirmReset) btnConfirmReset.textContent = 'Reset Everything';
    }

    if (resetModal) resetModal.classList.add('open');
  }

  async function executeConfirmedReset() {
    if (resetModal) resetModal.classList.remove('open');

    if (state.resetModalAction === 'photos') {
      state.items.forEach(it => {
        if (it.objectUrl) URL.revokeObjectURL(it.objectUrl);
      });
      state.items = [];
      state.selectedItemId = null;
      state.editScope = 'global';
      imageGrid.querySelectorAll('.film-thumb').forEach(el => el.remove());
      await StudioDB.clearStore('items');
      persistWorkspaceMeta(true);
      syncInspectorFromActiveScope();
      updateStageAndPrimaryCTA();
      return;
    }

    // Full studio factory reset
    setSaveBadge(true, 'Resetting…');
    if (metaSaveTimer) clearTimeout(metaSaveTimer);
    itemSaveTimers.forEach(t => clearTimeout(t));
    itemSaveTimers.clear();

    state.items.forEach(it => {
      if (it.objectUrl) URL.revokeObjectURL(it.objectUrl);
    });

    await Promise.all([
      StudioDB.clearStore('items'),
      StudioDB.clearStore('meta')
    ]);

    try {
      localStorage.removeItem(WORKSPACE_LS_KEY);
      LEGACY_KEYS.forEach(k => localStorage.removeItem(k));
    } catch (e) {}

    Object.assign(state.settings, DEFAULT_SETTINGS);
    state.templateMode = 'preset';
    state.activePresetId = 'v3_01';
    state.presetSeriesFilter = 'all';
    state.presetSearchQuery = '';
    state.stageBackdrop = 'checker';
    state.customSvgText = null;
    state.customSvgName = '';
    state.postFields = Object.assign({}, defaultPostFields);
    state.items = [];
    state.selectedItemId = null;
    state.editScope = 'global';
    state.globalFormatOverride = 'ssc';
    state.borderStatus['4x3'] = 'sample';
    state.borderStatus['4:3'] = 'sample';
    state.borderStatus['16x9'] = 'sample';
    state.borderStatus['16:9'] = 'sample';

    imageGrid.querySelectorAll('.film-thumb').forEach(el => el.remove());

    await loadBorders();
    syncAllChromeControlsFromState();
    renderPresetGallery();
    syncInspectorFromActiveScope();
    updateTemplateModeUI();
    updateStageAndPrimaryCTA();
    setSaveBadge(false, 'Defaults restored');
    setTimeout(() => {
      if (pendingDbOps === 0) setSaveBadge(false, 'Saved locally');
    }, 1800);
  }

  function getSelectedItem() {
    if (!state.selectedItemId) return null;
    return state.items.find(i => i.id === state.selectedItemId) || null;
  }

  // --- Settings Save ---
  function saveSettings() {
    state.settings.resolutionPreset = settingResolution.value;
    state.settings.format = settingFormat.value;
    state.settings.prefix = settingPrefix.value.trim() || 'pubmat_';
    settingsModal.classList.remove('open');
    persistWorkspaceMeta(true);
    updateStageHeaderMeta();
    if (state.items.length > 0) reprocessAllItems();
  }

  // --- Inspector Scope Sync (Global vs Selected Photo) ---
  function syncInspectorFromActiveScope() {
    const sel = getSelectedItem();
    const hasItems = state.items.length > 0;
    if (inspectorScopeBar) inspectorScopeBar.hidden = !hasItems;

    if (!hasItems) state.editScope = 'global';
    if (editScopeTabs) {
      editScopeTabs.querySelectorAll('.mode-pill').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.scope === state.editScope);
      });
    }
    if (btnScopeItem && sel) {
      const idx = state.items.indexOf(sel) + 1;
      btnScopeItem.textContent = `Photo #${idx}`;
    }

    const editingItem = state.editScope === 'item' && sel;
    if (itemOverrideBanner) itemOverrideBanner.hidden = !editingItem;

    if (editingItem) {
      if (overridePhotoName) overridePhotoName.textContent = sel.name;
      if (chkItemCustomText) chkItemCustomText.checked = Boolean(sel.customFields);
      if (itemTemplateSelect) itemTemplateSelect.value = sel.overrideTemplateId || '';
    }

    const activeFields = (editingItem && sel.customFields) ? sel.customFields : state.postFields;
    if (chkShowStory) chkShowStory.checked = Boolean(activeFields.showStory);
    if (storyFieldsContainer) storyFieldsContainer.style.opacity = activeFields.showStory ? '1' : '0.42';
    if (inputCategory) inputCategory.value = activeFields.category != null ? activeFields.category : '';
    if (inputDate) inputDate.value = activeFields.date != null ? activeFields.date : '';
    if (inputHeading) inputHeading.value = activeFields.heading != null ? activeFields.heading : '';
    if (inputCaption) inputCaption.value = activeFields.caption != null ? activeFields.caption : '';

    if (inputOrgTitle) inputOrgTitle.value = state.postFields.orgTitle;
    if (inputOrgSubtitle) inputOrgSubtitle.value = state.postFields.orgSubtitle;
    if (inputFacebook) inputFacebook.value = state.postFields.facebook;
    if (inputEmail) inputEmail.value = state.postFields.email;
  }

  function commitInspectorEdit() {
    state.postFields.orgTitle = inputOrgTitle ? inputOrgTitle.value : '';
    state.postFields.orgSubtitle = inputOrgSubtitle ? inputOrgSubtitle.value : '';
    state.postFields.facebook = inputFacebook ? inputFacebook.value : '';
    state.postFields.email = inputEmail ? inputEmail.value : '';

    const sel = getSelectedItem();
    if (state.editScope === 'item' && sel) {
      if (chkItemCustomText) chkItemCustomText.checked = true;
      sel.customFields = {
        showStory: chkShowStory ? chkShowStory.checked : true,
        category: inputCategory ? inputCategory.value : '',
        date: inputDate ? inputDate.value : '',
        heading: inputHeading ? inputHeading.value : '',
        caption: inputCaption ? inputCaption.value : ''
      };
      if (storyFieldsContainer) storyFieldsContainer.style.opacity = sel.customFields.showStory ? '1' : '0.42';
      persistWorkspaceMeta(false);
      schedulePersistItem(sel);
      updateFilmstripThumbMeta(sel);
      renderSelectedStageRealtime();
      scheduleSingleItemCommit(sel);
      return;
    }

    state.postFields.showStory = chkShowStory ? chkShowStory.checked : true;
    state.postFields.category = inputCategory ? inputCategory.value : '';
    state.postFields.date = inputDate ? inputDate.value : '';
    state.postFields.heading = inputHeading ? inputHeading.value : '';
    state.postFields.caption = inputCaption ? inputCaption.value : '';
    if (storyFieldsContainer) storyFieldsContainer.style.opacity = state.postFields.showStory ? '1' : '0.42';

    persistWorkspaceMeta(false);
    scheduleGlobalUpdate(false);
  }

  // --- Preset Gallery ---
  function populatePerItemTemplateDropdown() {
    if (!itemTemplateSelect || !PT) return;
    itemTemplateSelect.innerHTML = '<option value="">Same as global layout</option>';
    PT.TEMPLATES.forEach(tpl => {
      const opt = document.createElement('option');
      opt.value = tpl.id;
      opt.textContent = tpl.name;
      itemTemplateSelect.appendChild(opt);
    });
  }

  function getThumbUrl(tplId) {
    if (thumbBlobUrls.has(tplId)) return thumbBlobUrls.get(tplId);
    const svgStr = PT.renderTemplateSVG(tplId, PT.DEFAULT_FIELDS, 2000, 1414);
    const url = URL.createObjectURL(new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' }));
    thumbBlobUrls.set(tplId, url);
    return url;
  }

  function cleanPresetTitle(rawName) {
    const parts = String(rawName || '').split('//');
    return parts.length > 1 ? parts[1].trim() : rawName;
  }

  function renderPresetGallery() {
    if (!presetGalleryGrid || !PT) return;
    const q = state.presetSearchQuery.trim().toLowerCase();
    const list = PT.TEMPLATES.filter(tpl => {
      if (state.presetSeriesFilter !== 'all' && tpl.series !== state.presetSeriesFilter) return false;
      if (q && !(tpl.name.toLowerCase().includes(q) || tpl.badge.toLowerCase().includes(q) || tpl.filename.toLowerCase().includes(q))) {
        return false;
      }
      return true;
    });

    const sel = getSelectedItem();
    const activeId = (state.editScope === 'item' && sel && sel.overrideTemplateId)
      ? sel.overrideTemplateId
      : state.activePresetId;

    presetGalleryGrid.innerHTML = '';
    list.forEach(tpl => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'preset-card' + (tpl.id === activeId ? ' active' : '');
      const code = tpl.id.toUpperCase().replace('_', '-');
      const shortTitle = cleanPresetTitle(tpl.name);
      btn.innerHTML = `
        <div class="preset-card-thumb">
          <img src="${getThumbUrl(tpl.id)}" loading="lazy" alt="${escapeHtml(tpl.name)}">
        </div>
        <div class="preset-card-meta">
          <span class="preset-code">${escapeHtml(code)}</span>
          <span class="preset-badge">${escapeHtml(tpl.badge)}</span>
        </div>
        <div class="preset-title" title="${escapeHtml(shortTitle)}">${escapeHtml(shortTitle)}</div>
      `;
      btn.addEventListener('click', () => {
        const curSel = getSelectedItem();
        if (state.editScope === 'item' && curSel) {
          curSel.overrideTemplateId = tpl.id;
          if (itemTemplateSelect) itemTemplateSelect.value = tpl.id;
          schedulePersistItem(curSel);
          updateFilmstripThumbMeta(curSel);
          renderPresetGallery();
          updateStageHeaderMeta();
          renderSelectedStageRealtime();
          scheduleSingleItemCommit(curSel);
        } else {
          state.activePresetId = tpl.id;
          state.templateMode = 'preset';
          persistWorkspaceMeta(true);
          updateTemplateModeUI();
          renderPresetGallery();
          scheduleGlobalUpdate(true);
        }
      });
      presetGalleryGrid.appendChild(btn);
    });
  }

  function updateTemplateModeUI() {
    if (templateModeTabs) {
      templateModeTabs.querySelectorAll('.mode-pill').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === state.templateMode);
      });
    }
    if (panelModePreset) panelModePreset.hidden = state.templateMode !== 'preset';
    if (panelModeSvg) panelModeSvg.hidden = state.templateMode !== 'svg';
    if (panelModePng) panelModePng.hidden = state.templateMode !== 'png';

    if (state.customSvgText) {
      if (customSvgFilename) customSvgFilename.textContent = state.customSvgName || 'custom.svg';
      if (badgeStatusSvg) {
        badgeStatusSvg.textContent = 'Active';
        badgeStatusSvg.classList.add('active');
      }
      if (previewCustomSvg && placeholderCustomSvg) {
        const rendered = PT ? PT.applyFieldsToCustomSVG(state.customSvgText, state.postFields) : state.customSvgText;
        previewCustomSvg.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(rendered);
        previewCustomSvg.hidden = false;
        placeholderCustomSvg.hidden = true;
      }
    } else {
      if (customSvgFilename) customSvgFilename.textContent = 'Upload .svg overlay';
      if (badgeStatusSvg) {
        badgeStatusSvg.textContent = 'Waiting';
        badgeStatusSvg.classList.remove('active');
      }
      if (previewCustomSvg && placeholderCustomSvg) {
        previewCustomSvg.hidden = true;
        placeholderCustomSvg.hidden = false;
      }
    }

    updateStageHeaderMeta();
  }

  // --- Stage & Primary Export CTA ---
  function getActiveRatioForStage() {
    const sel = getSelectedItem();
    if (sel) return sel.chosenFormat;
    return state.globalFormatOverride === 'auto' ? 'ssc' : state.globalFormatOverride;
  }

  function getTargetResolution(format) {
    const preset = RESOLUTION_PRESETS[state.settings.resolutionPreset] || RESOLUTION_PRESETS.highres;
    const key = normalizeFormatKey(format);
    return preset[format] || preset[key] || preset.ssc;
  }

  function updateStageHeaderMeta() {
    const sel = getSelectedItem();
    const res = getTargetResolution(getActiveRatioForStage());
    if (artboardWrap) {
      artboardWrap.style.aspectRatio = `${res.width} / ${res.height}`;
      artboardWrap.style.setProperty('--art-ratio', (res.width / res.height).toFixed(4));
    }
    if (stageResolutionMeta) {
      stageResolutionMeta.textContent = `${res.width} × ${res.height} px`;
    }
    if (activePresetNameEl) {
      if (state.templateMode === 'svg') {
        activePresetNameEl.textContent = state.customSvgName ? `SVG: ${state.customSvgName}` : 'Custom SVG Overlay';
      } else if (state.templateMode === 'png') {
        activePresetNameEl.textContent = 'Static PNG Border Mode';
      } else if (PT) {
        const tplId = (sel && sel.overrideTemplateId) ? sel.overrideTemplateId : state.activePresetId;
        activePresetNameEl.textContent = PT.getTemplateById(tplId).name;
      }
    }
  }

  function updateStageAndPrimaryCTA() {
    const count = state.items.length;
    const sel = getSelectedItem();

    if (primaryExportLabel) {
      if (count === 0) primaryExportLabel.textContent = 'Export Overlay PNG';
      else if (count === 1) primaryExportLabel.textContent = 'Download Post';
      else primaryExportLabel.textContent = `Export All (${count}) .ZIP`;
    }

    if (filmstripCountLabel) {
      filmstripCountLabel.textContent = `${count} ${count === 1 ? 'Photo' : 'Photos'}`;
    }
    if (filmstripSubHint) {
      filmstripSubHint.textContent = count === 0
        ? 'Add 1 photo for a single post, or drop an event folder to batch-export'
        : 'Click any photo below to adjust crop or customize its caption';
    }
    if (filmstripBatchActions) {
      filmstripBatchActions.hidden = count === 0;
    }

    const showPhotoCanvas = Boolean(sel);
    if (liveOverlayImg) liveOverlayImg.hidden = showPhotoCanvas;
    if (btnEmptyDropPrompt) btnEmptyDropPrompt.hidden = showPhotoCanvas;
    if (emptyStageBgToggle) emptyStageBgToggle.hidden = showPhotoCanvas;
    if (stageCanvas) stageCanvas.hidden = !showPhotoCanvas;
    if (stageFramingBar) stageFramingBar.hidden = !showPhotoCanvas;

    updateStageHeaderMeta();

    if (sel) {
      if (stageZoomSlider) stageZoomSlider.value = sel.zoom;
      if (stageZoomVal) stageZoomVal.textContent = `${sel.zoom.toFixed(2)}×`;
      renderSelectedStageRealtime();
    } else {
      updateEmptyStageOverlayPreview();
    }
  }

  function getActivePreviewSvgString(w, h) {
    if (state.templateMode === 'svg' && state.customSvgText) {
      return PT ? PT.applyFieldsToCustomSVG(state.customSvgText, state.postFields) : state.customSvgText;
    }
    if (PT) {
      return PT.renderTemplateSVG(state.activePresetId, state.postFields, w || 2000, h || 1414);
    }
    return '';
  }

  function updateEmptyStageOverlayPreview() {
    if (!liveOverlayImg || getSelectedItem()) return;
    const res = getTargetResolution(getActiveRatioForStage());
    if (state.templateMode === 'png') {
      const key = normalizeFormatKey(getActiveRatioForStage()) === '16x9' ? '16x9' : '4x3';
      liveOverlayImg.src = state.borderSources[key] || '';
      return;
    }
    const svgStr = getActivePreviewSvgString(res.width, res.height);
    if (!svgStr) return;
    liveOverlayImg.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr);
  }

  function scheduleGlobalUpdate(immediate) {
    if (livePreviewTimer) clearTimeout(livePreviewTimer);
    if (immediate) {
      if (getSelectedItem()) renderSelectedStageRealtime();
      else updateEmptyStageOverlayPreview();
    } else {
      livePreviewTimer = setTimeout(() => {
        if (getSelectedItem()) renderSelectedStageRealtime();
        else updateEmptyStageOverlayPreview();
      }, 50);
    }

    if (state.items.length > 0) {
      if (batchRenderTimer) clearTimeout(batchRenderTimer);
      batchRenderTimer = setTimeout(() => {
        reprocessAllItems();
      }, immediate ? 80 : 250);
    }
  }

  function scheduleSingleItemCommit(item) {
    if (panCommitTimer) clearTimeout(panCommitTimer);
    panCommitTimer = setTimeout(() => {
      renderItem(item);
    }, 170);
  }

  // --- SVG Image Loader & Caching ---
  function loadSvgAsImage(svgStr) {
    if (!svgStr) return Promise.resolve(null);
    if (svgImageCache.has(svgStr)) return Promise.resolve(svgImageCache.get(svgStr));
    const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr);
    return loadImageAsync(dataUrl).then(img => {
      if (img) {
        if (svgImageCache.size > 60) {
          svgImageCache.delete(svgImageCache.keys().next().value);
        }
        svgImageCache.set(svgStr, img);
      }
      return img;
    });
  }

  function getEffectiveFieldsForItem(item) {
    if (item && item.customFields) {
      return Object.assign({}, state.postFields, item.customFields);
    }
    return state.postFields;
  }

  function getEffectivePhotoBoxForItem(item, targetW, targetH) {
    if (!PT) return { x: 0, y: 0, w: 1, h: 1 };
    const tplId = (item && item.overrideTemplateId)
      ? item.overrideTemplateId
      : (state.templateMode === 'preset' ? state.activePresetId : null);
    if (!tplId) return { x: 0, y: 0, w: 1, h: 1 };
    return PT.getTemplatePhotoBox(tplId, targetW, targetH);
  }

  async function getOverlayImageForItem(item, targetW, targetH) {
    const fields = getEffectiveFieldsForItem(item);
    if (item && item.overrideTemplateId && PT) {
      return loadSvgAsImage(PT.renderTemplateSVG(item.overrideTemplateId, fields, targetW, targetH));
    }
    if (state.templateMode === 'preset' && PT) {
      return loadSvgAsImage(PT.renderTemplateSVG(state.activePresetId, fields, targetW, targetH));
    }
    if (state.templateMode === 'svg') {
      if (!state.customSvgText) return null;
      const svgStr = PT ? PT.applyFieldsToCustomSVG(state.customSvgText, fields) : state.customSvgText;
      return loadSvgAsImage(svgStr);
    }
    const fmt = normalizeFormatKey(item.chosenFormat) === '16x9' ? '16x9' : '4x3';
    return getBorderImage(fmt);
  }

  // --- Direct Stage Real-Time Canvas Render ---
  async function renderSelectedStageRealtime() {
    const item = getSelectedItem();
    if (!item || !stageCanvas) return;

    const targetRes = getTargetResolution(item.chosenFormat);
    if (stageCanvas.width !== targetRes.width || stageCanvas.height !== targetRes.height) {
      stageCanvas.width = targetRes.width;
      stageCanvas.height = targetRes.height;
    }

    const overlayImg = state.holdRawPreview
      ? null
      : await getOverlayImageForItem(item, stageCanvas.width, stageCanvas.height);

    if (getSelectedItem() !== item) return;

    const ctx = stageCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, stageCanvas.width, stageCanvas.height);

    const box = state.holdRawPreview
      ? { x: 0, y: 0, w: 1, h: 1 }
      : getEffectivePhotoBoxForItem(item, stageCanvas.width, stageCanvas.height);

    drawPhotoInsideBox(ctx, item.imgObj, stageCanvas.width, stageCanvas.height, box, item.zoom, item.panX, item.panY);

    if (overlayImg && overlayImg.complete && overlayImg.naturalWidth > 0) {
      ctx.drawImage(overlayImg, 0, 0, stageCanvas.width, stageCanvas.height);
    }
  }

  function drawPhotoInsideBox(ctx, img, canvasW, canvasH, normBox, zoom, panX, panY) {
    const bleedX = (normBox.x > 0 || normBox.w < 1) ? 3 : 0;
    const bleedY = (normBox.y > 0 || normBox.h < 1) ? 3 : 0;
    const bx = Math.max(0, Math.floor(normBox.x * canvasW) - bleedX);
    const by = Math.max(0, Math.floor(normBox.y * canvasH) - bleedY);
    const bw = Math.min(canvasW - bx, Math.ceil(normBox.w * canvasW) + bleedX * 2);
    const bh = Math.min(canvasH - by, Math.ceil(normBox.h * canvasH) + bleedY * 2);

    const baseScale = Math.max(bw / img.width, bh / img.height);
    const totalScale = baseScale * zoom;
    const drawW = img.width * totalScale;
    const drawH = img.height * totalScale;

    const defaultX = bx + (bw - drawW) / 2;
    const defaultY = by + (bh - drawH) / 2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(bx, by, bw, bh);
    ctx.clip();
    ctx.fillStyle = '#000000';
    ctx.fillRect(bx, by, bw, bh);
    ctx.drawImage(img, defaultX + panX, defaultY + panY, drawW, drawH);
    ctx.restore();
  }

  async function renderItem(item) {
    const targetRes = getTargetResolution(item.chosenFormat);
    const canvas = document.createElement('canvas');
    canvas.width = targetRes.width;
    canvas.height = targetRes.height;
    const ctx = canvas.getContext('2d');

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const photoBox = getEffectivePhotoBoxForItem(item, canvas.width, canvas.height);
    drawPhotoInsideBox(ctx, item.imgObj, canvas.width, canvas.height, photoBox, item.zoom, item.panX, item.panY);

    const overlayImg = await getOverlayImageForItem(item, canvas.width, canvas.height);
    if (overlayImg && overlayImg.complete && overlayImg.naturalWidth > 0) {
      ctx.drawImage(overlayImg, 0, 0, canvas.width, canvas.height);
    }

    const mimeType = state.settings.format;
    const quality = mimeType === 'image/jpeg' ? 0.93 : undefined;
    item.renderedDataUrl = canvas.toDataURL(mimeType, quality);

    return new Promise((resolve) => {
      canvas.toBlob((blob) => {
        item.renderedBlob = blob;
        updateFilmstripThumbMeta(item);
        if (getSelectedItem() === item) renderSelectedStageRealtime();
        resolve(item);
      }, mimeType, quality);
    });
  }

  async function reprocessAllItems() {
    const myGen = ++renderGen;
    if (state.items.length === 0) return;
    showProgress(5);
    for (let i = 0; i < state.items.length; i++) {
      if (myGen !== renderGen) return;
      await renderItem(state.items[i]);
      showProgress(((i + 1) / state.items.length) * 100);
    }
    setTimeout(hideProgress, 300);
  }

  // --- Filmstrip Management ---
  function selectItem(id) {
    state.selectedItemId = id;
    document.querySelectorAll('.film-thumb').forEach(el => {
      el.classList.toggle('active', el.dataset.itemId === id);
    });
    persistWorkspaceMeta(false);
    syncInspectorFromActiveScope();
    renderPresetGallery();
    updateStageAndPrimaryCTA();
  }

  function appendFilmstripThumb(item) {
    const div = document.createElement('div');
    div.id = `card_${item.id}`;
    div.className = 'film-thumb' + (item.id === state.selectedItemId ? ' active' : '');
    div.dataset.itemId = item.id;
    div.innerHTML = `
      <img id="img_${item.id}" src="${item.originalDataUrl}" alt="${escapeHtml(item.name)}">
      <span class="film-ratio-tag">${displayFormatLabel(item.chosenFormat)}</span>
      <span class="film-override-dot" ${item.customFields || item.overrideTemplateId ? '' : 'hidden'} title="Custom override active"></span>
      <button type="button" class="film-remove-btn" title="Remove photo" aria-label="Remove photo">&times;</button>
    `;
    div.addEventListener('click', (e) => {
      if (e.target.closest('.film-remove-btn')) return;
      selectItem(item.id);
    });
    div.querySelector('.film-remove-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      removeItem(item.id);
    });
    imageGrid.appendChild(div);
  }

  function updateFilmstripThumbMeta(item) {
    const el = document.getElementById(`card_${item.id}`);
    if (!el) return;
    const imgEl = document.getElementById(`img_${item.id}`);
    if (imgEl && item.renderedDataUrl) imgEl.src = item.renderedDataUrl;
    const tag = el.querySelector('.film-ratio-tag');
    if (tag) tag.textContent = displayFormatLabel(item.chosenFormat);
    const dot = el.querySelector('.film-override-dot');
    if (dot) dot.hidden = !(item.customFields || item.overrideTemplateId);
  }

  async function removeItem(id) {
    const idx = state.items.findIndex(i => i.id === id);
    if (idx === -1) return;
    const [removed] = state.items.splice(idx, 1);
    if (removed && removed.objectUrl) URL.revokeObjectURL(removed.objectUrl);

    const el = document.getElementById(`card_${id}`);
    if (el) el.remove();

    setSaveBadge(true);
    pendingDbOps++;
    try {
      await StudioDB.del('items', id);
    } finally {
      pendingDbOps = Math.max(0, pendingDbOps - 1);
    }

    if (state.selectedItemId === id) {
      const next = state.items[idx] || state.items[idx - 1] || null;
      state.selectedItemId = next ? next.id : null;
    }
    persistWorkspaceMeta(true);

    if (state.selectedItemId) {
      selectItem(state.selectedItemId);
    } else {
      syncInspectorFromActiveScope();
      updateStageAndPrimaryCTA();
    }
  }

  // --- Handling File Drops & Uploads ---
  function isValidImageFile(file) {
    return /\.(jpe?g|png|webp)$/i.test(file.name);
  }

  async function handleNewFiles(files) {
    showProgress(5);
    let firstNewId = null;

    for (let i = 0; i < files.length; i++) {
      try {
        const item = await createItemFromFile(files[i]);
        state.items.push(item);
        if (!firstNewId) firstNewId = item.id;
        if (!state.selectedItemId) state.selectedItemId = item.id;
        appendFilmstripThumb(item);
        await persistItemNow(item, state.items.length - 1);
        await renderItem(item);
      } catch (err) {
        console.error('Error loading photo:', files[i].name, err);
      }
      showProgress(((i + 1) / files.length) * 100);
    }

    persistWorkspaceMeta(true);
    if (firstNewId) selectItem(firstNewId);
    setTimeout(hideProgress, 350);
  }

  function createItemFromFile(file) {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const width = img.naturalWidth || img.width;
        const height = img.naturalHeight || img.height;
        const ratio = width / height;
        const detectedFormat = Math.abs(ratio - 4 / 3) <= Math.abs(ratio - 16 / 9) ? '4:3' : '16:9';
        const chosenFormat = state.globalFormatOverride === 'auto'
          ? detectedFormat
          : state.globalFormatOverride;

        resolve({
          id: 'item_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9),
          file,
          blob: file,
          objectUrl,
          imgObj: img,
          name: file.name,
          originalWidth: width,
          originalHeight: height,
          originalDataUrl: objectUrl,
          ratio,
          detectedFormat,
          chosenFormat,
          panX: 0,
          panY: 0,
          zoom: 1.0,
          overrideTemplateId: null,
          customFields: null,
          renderedDataUrl: null,
          renderedBlob: null
        });
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('Invalid image'));
      };
      img.src = objectUrl;
    });
  }

  // --- Static PNG Borders ---
  function loadImageAsync(src) {
    return new Promise((resolve) => {
      if (!src) return resolve(null);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
      if (img.complete && img.naturalWidth > 0) resolve(img);
    });
  }

  async function loadBorders() {
    let custom4x3 = null;
    let custom16x9 = null;
    let status4x3 = 'sample';
    let status16x9 = 'sample';

    const idbBorders = await StudioDB.get('meta', 'borders');
    if (idbBorders) {
      custom4x3 = idbBorders.src4x3 || null;
      custom16x9 = idbBorders.src16x9 || null;
      if (idbBorders.status4x3) status4x3 = idbBorders.status4x3;
      if (idbBorders.status16x9) status16x9 = idbBorders.status16x9;
    }

    if (status4x3 === 'custom' && status16x9 !== 'custom') status16x9 = 'none';
    else if (status16x9 === 'custom' && status4x3 !== 'custom') status4x3 = 'none';

    state.borderStatus['4x3'] = status4x3;
    state.borderStatus['4:3'] = status4x3;
    state.borderStatus['16x9'] = status16x9;
    state.borderStatus['16:9'] = status16x9;

    const default4 = window.DEFAULT_BORDERS && (window.DEFAULT_BORDERS['4x3'] || window.DEFAULT_BORDERS['4:3']);
    const default16 = window.DEFAULT_BORDERS && (window.DEFAULT_BORDERS['16x9'] || window.DEFAULT_BORDERS['16:9']);

    const src4x3 = status4x3 === 'custom' ? custom4x3 : (status4x3 === 'sample' ? (default4 || '4x3.png') : null);
    const src16x9 = status16x9 === 'custom' ? custom16x9 : (status16x9 === 'sample' ? (default16 || '16x9.png') : null);

    state.borderSources['4x3'] = src4x3;
    state.borderSources['4:3'] = src4x3;
    state.borderSources['16x9'] = src16x9;
    state.borderSources['16:9'] = src16x9;

    let [img4, img16] = await Promise.all([
      status4x3 !== 'none' ? loadImageAsync(src4x3) : Promise.resolve(null),
      status16x9 !== 'none' ? loadImageAsync(src16x9) : Promise.resolve(null)
    ]);

    if (!img4 && src4x3 && src4x3 !== '4x3.png' && status4x3 === 'sample') img4 = await loadImageAsync('4x3.png');
    if (!img16 && src16x9 && src16x9 !== '16x9.png' && status16x9 === 'sample') img16 = await loadImageAsync('16x9.png');

    state.borderImages['4x3'] = img4;
    state.borderImages['4:3'] = img4;
    state.borderImages['16x9'] = img16;
    state.borderImages['16:9'] = img16;

    updatePngSlotsUI();
  }

  function updatePngSlotsUI() {
    const s4 = state.borderStatus['4x3'];
    if (badgeStatus4x3) {
      badgeStatus4x3.textContent = s4 === 'custom' ? 'Custom' : (s4 === 'sample' ? 'Demo' : 'None');
      badgeStatus4x3.classList.toggle('active', s4 === 'custom');
    }
    if (previewBorder4x3 && placeholder4x3) {
      const has4 = s4 !== 'none' && Boolean(state.borderSources['4x3']);
      previewBorder4x3.hidden = !has4;
      placeholder4x3.hidden = has4;
      if (has4) previewBorder4x3.src = state.borderSources['4x3'];
    }

    const s16 = state.borderStatus['16x9'];
    if (badgeStatus16x9) {
      badgeStatus16x9.textContent = s16 === 'custom' ? 'Custom' : (s16 === 'sample' ? 'Demo' : 'None');
      badgeStatus16x9.classList.toggle('active', s16 === 'custom');
    }
    if (previewBorder16x9 && placeholder16x9) {
      const has16 = s16 !== 'none' && Boolean(state.borderSources['16x9']);
      previewBorder16x9.hidden = !has16;
      placeholder16x9.hidden = has16;
      if (has16) previewBorder16x9.src = state.borderSources['16x9'];
    }
  }

  async function getBorderImage(format) {
    const key = normalizeFormatKey(format) === '16x9' ? '16x9' : '4x3';
    if (state.borderStatus[key] === 'none') return null;
    if (state.borderImages[key]) return state.borderImages[key];
    await loadBorders();
    return state.borderStatus[key] === 'none' ? null : state.borderImages[key];
  }

  function handleCustomBorderUpload(format, file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      const img = await loadImageAsync(e.target.result);
      if (!img) {
        alert('Please select a valid PNG file.');
        return;
      }
      const normKey = normalizeFormatKey(format) === '16x9' ? '16x9' : '4x3';
      const otherKey = normKey === '4x3' ? '16x9' : '4x3';

      state.borderStatus[normKey] = 'custom';
      state.borderSources[normKey] = e.target.result;
      state.borderImages[normKey] = img;

      if (state.borderStatus[otherKey] !== 'custom') {
        state.borderStatus[otherKey] = 'none';
        state.borderSources[otherKey] = null;
        state.borderImages[otherKey] = null;
      }

      state.borderStatus['4:3'] = state.borderStatus['4x3'];
      state.borderStatus['16:9'] = state.borderStatus['16x9'];
      state.borderSources['4:3'] = state.borderSources['4x3'];
      state.borderSources['16:9'] = state.borderSources['16x9'];
      state.borderImages['4:3'] = state.borderImages['4x3'];
      state.borderImages['16:9'] = state.borderImages['16x9'];

      await persistBordersState();
      updatePngSlotsUI();
      scheduleGlobalUpdate(true);
    };
    reader.readAsDataURL(file);
  }

  async function setBorderToNone(format) {
    const normKey = normalizeFormatKey(format) === '16x9' ? '16x9' : '4x3';
    state.borderStatus[normKey] = 'none';
    state.borderSources[normKey] = null;
    state.borderImages[normKey] = null;
    if (normKey === '4x3') {
      state.borderStatus['4:3'] = 'none';
      state.borderSources['4:3'] = null;
      state.borderImages['4:3'] = null;
    } else {
      state.borderStatus['16:9'] = 'none';
      state.borderSources['16:9'] = null;
      state.borderImages['16:9'] = null;
    }
    await persistBordersState();
    updatePngSlotsUI();
    scheduleGlobalUpdate(true);
  }

  async function revertBorderToSample(format) {
    const normKey = normalizeFormatKey(format) === '16x9' ? '16x9' : '4x3';
    state.borderStatus[normKey] = 'sample';
    if (normKey === '4x3') state.borderStatus['4:3'] = 'sample';
    else state.borderStatus['16:9'] = 'sample';

    const defaultBorder = window.DEFAULT_BORDERS && window.DEFAULT_BORDERS[normKey];
    const src = defaultBorder || (normKey === '4x3' ? '4x3.png' : '16x9.png');
    state.borderSources[normKey] = src;
    if (normKey === '4x3') state.borderSources['4:3'] = src;
    else state.borderSources['16:9'] = src;

    const img = await loadImageAsync(src);
    state.borderImages[normKey] = img;
    if (normKey === '4x3') state.borderImages['4:3'] = img;
    else state.borderImages['16:9'] = img;

    await persistBordersState();
    updatePngSlotsUI();
    scheduleGlobalUpdate(true);
  }

  // --- Exporters ---
  function exportActiveTransparentSvg() {
    const svgStr = getActivePreviewSvgString(2000, 1414);
    if (!svgStr) return;
    const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    triggerDownloadBlob(blob, `${state.activePresetId}_transparent_editable.svg`);
  }

  async function exportActiveTransparentPng() {
    const svgStr = getActivePreviewSvgString(2000, 1414);
    if (!svgStr) return;
    const img = await loadSvgAsImage(svgStr);
    if (!img) return;
    const canvas = document.createElement('canvas');
    canvas.width = 2000;
    canvas.height = 1414;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 2000, 1414);
    ctx.drawImage(img, 0, 0, 2000, 1414);
    canvas.toBlob((blob) => {
      if (blob) triggerDownloadBlob(blob, `${state.activePresetId}_transparent_2000x1414.png`);
    }, 'image/png');
  }

  function getOutputFilename(originalName) {
    const ext = state.settings.format === 'image/jpeg' ? '.jpg' : '.png';
    const baseName = originalName.replace(/\.[^/.]+$/, '');
    return `${state.settings.prefix}${baseName}${ext}`;
  }

  function triggerDownloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }, 250);
  }

  async function downloadSingleItem(item) {
    if (!item) return;
    if (!item.renderedBlob) await renderItem(item);
    if (item.renderedBlob) {
      triggerDownloadBlob(item.renderedBlob, getOutputFilename(item.name));
    }
  }

  async function downloadAllAsZip() {
    if (state.items.length === 0) return;
    if (!window.JSZip) {
      state.items.forEach(item => downloadSingleItem(item));
      return;
    }

    const zip = new window.JSZip();
    showProgress(5);
    btnPrimaryExport.disabled = true;
    isExportingZip = true;

    for (let i = 0; i < state.items.length; i++) {
      const item = state.items[i];
      if (!item.renderedBlob) await renderItem(item);
      zip.file(getOutputFilename(item.name), item.renderedBlob);
      showProgress(((i + 1) / state.items.length) * 55);
    }

    try {
      const zipBlob = await zip.generateAsync({ type: 'blob' }, (meta) => {
        showProgress(55 + meta.percent * 0.45);
      });
      triggerDownloadBlob(zipBlob, `ssc_pubmats_${new Date().toISOString().slice(0, 10)}.zip`);
    } catch (err) {
      console.error('ZIP export failed:', err);
      alert('Failed to generate ZIP archive.');
    } finally {
      isExportingZip = false;
      btnPrimaryExport.disabled = false;
      setTimeout(hideProgress, 450);
    }
  }

  // --- Event Listeners ---
  function setupEventListeners() {
    // Flush synchronous metadata backup before page hide / refresh + protect active DB writes
    window.addEventListener('pagehide', () => {
      writeSnapshotToLocalStorageSync(buildWorkspaceSnapshot());
    });

    window.addEventListener('beforeunload', (e) => {
      writeSnapshotToLocalStorageSync(buildWorkspaceSnapshot());
      if (pendingDbOps > 0 || isExportingZip) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    // Add Photos triggers
    [btnAddPhotosTop, btnFilmstripAdd, btnEmptyDropPrompt].forEach(btn => {
      if (btn) btn.addEventListener('click', () => fileInput.click());
    });

    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files).filter(isValidImageFile);
      if (files.length > 0) handleNewFiles(files);
      fileInput.value = '';
    });

    // Drag & Drop anywhere on Center Stage
    ['dragenter', 'dragover'].forEach(ev => {
      dropzone.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add('dragover');
      });
    });

    ['dragleave', 'drop'].forEach(ev => {
      dropzone.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove('dragover');
      });
    });

    dropzone.addEventListener('drop', (e) => {
      const files = Array.from(e.dataTransfer.files).filter(isValidImageFile);
      if (files.length > 0) handleNewFiles(files);
    });

    // Primary Export & Reset Buttons
    btnPrimaryExport.addEventListener('click', () => {
      if (state.items.length === 0) exportActiveTransparentPng();
      else if (state.items.length === 1) downloadSingleItem(state.items[0]);
      else downloadAllAsZip();
    });

    if (btnDownloadCurrent) {
      btnDownloadCurrent.addEventListener('click', () => {
        const sel = getSelectedItem();
        if (sel) downloadSingleItem(sel);
      });
    }
    if (btnDownloadAllZip) btnDownloadAllZip.addEventListener('click', downloadAllAsZip);
    if (btnClearAll) btnClearAll.addEventListener('click', () => openResetModal('photos'));
    if (btnResetWorkspace) btnResetWorkspace.addEventListener('click', () => openResetModal('all'));

    // Reset Confirmation Modal Controls
    if (btnCloseResetModal) btnCloseResetModal.addEventListener('click', () => resetModal.classList.remove('open'));
    if (btnCancelReset) btnCancelReset.addEventListener('click', () => resetModal.classList.remove('open'));
    if (btnConfirmReset) btnConfirmReset.addEventListener('click', executeConfirmedReset);
    if (resetModal) {
      resetModal.addEventListener('click', (e) => {
        if (e.target === resetModal) resetModal.classList.remove('open');
      });
    }

    // Top Aspect Ratio Switcher
    if (ratioSegmented) {
      ratioSegmented.querySelectorAll('.seg-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          state.globalFormatOverride = btn.dataset.ratio;
          ratioSegmented.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b === btn));
          state.items.forEach(item => {
            item.chosenFormat = state.globalFormatOverride === 'auto' ? item.detectedFormat : state.globalFormatOverride;
            persistItemNow(item);
          });
          persistWorkspaceMeta(true);
          updateStageAndPrimaryCTA();
          if (state.items.length > 0) reprocessAllItems();
        });
      });
    }

    // Mobile Workspace Tabs
    if (mobileWorkspaceTabs) {
      mobileWorkspaceTabs.querySelectorAll('.mob-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          mobileWorkspaceTabs.querySelectorAll('.mob-tab').forEach(t => t.classList.toggle('active', t === tab));
          const target = tab.dataset.pane;
          paneStage.classList.toggle('active-mobile-pane', target === 'stage');
          paneTemplates.classList.toggle('active-mobile-pane', target === 'templates');
          paneInspector.classList.toggle('active-mobile-pane', target === 'inspector');
        });
      });
    }

    // Left Drawer Mode Pills & Filters
    if (templateModeTabs) {
      templateModeTabs.querySelectorAll('.mode-pill').forEach(btn => {
        btn.addEventListener('click', () => {
          state.templateMode = btn.dataset.mode;
          persistWorkspaceMeta(true);
          updateTemplateModeUI();
          scheduleGlobalUpdate(true);
        });
      });
    }

    if (presetSeriesFilter) {
      presetSeriesFilter.querySelectorAll('.filter-tab').forEach(btn => {
        btn.addEventListener('click', () => {
          state.presetSeriesFilter = btn.dataset.series;
          presetSeriesFilter.querySelectorAll('.filter-tab').forEach(b => b.classList.toggle('active', b === btn));
          persistWorkspaceMeta(false);
          renderPresetGallery();
        });
      });
    }

    if (presetSearchInput) {
      presetSearchInput.addEventListener('input', () => {
        state.presetSearchQuery = presetSearchInput.value;
        persistWorkspaceMeta(false);
        renderPresetGallery();
      });
    }

    // Custom SVG Upload
    if (btnUploadCustomSvg && inputCustomSvg) {
      btnUploadCustomSvg.addEventListener('click', () => inputCustomSvg.click());
      inputCustomSvg.addEventListener('change', () => {
        const file = inputCustomSvg.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
          state.customSvgText = String(e.target.result || '');
          state.customSvgName = file.name;
          state.templateMode = 'svg';
          persistWorkspaceMeta(true);
          updateTemplateModeUI();
          scheduleGlobalUpdate(true);
        };
        reader.readAsText(file);
        inputCustomSvg.value = '';
      });
    }
    if (btnClearCustomSvg) {
      btnClearCustomSvg.addEventListener('click', () => {
        state.customSvgText = null;
        state.customSvgName = '';
        persistWorkspaceMeta(true);
        updateTemplateModeUI();
        scheduleGlobalUpdate(true);
      });
    }

    // Static PNG Slot Buttons
    if (btnUploadBorder4x3 && inputCustomBorder4x3) {
      btnUploadBorder4x3.addEventListener('click', () => inputCustomBorder4x3.click());
      inputCustomBorder4x3.addEventListener('change', () => {
        handleCustomBorderUpload('4x3', inputCustomBorder4x3.files[0]);
        inputCustomBorder4x3.value = '';
      });
    }
    if (btnNone4x3) btnNone4x3.addEventListener('click', () => setBorderToNone('4x3'));
    if (btnSample4x3) btnSample4x3.addEventListener('click', () => revertBorderToSample('4x3'));

    if (btnUploadBorder16x9 && inputCustomBorder16x9) {
      btnUploadBorder16x9.addEventListener('click', () => inputCustomBorder16x9.click());
      inputCustomBorder16x9.addEventListener('change', () => {
        handleCustomBorderUpload('16x9', inputCustomBorder16x9.files[0]);
        inputCustomBorder16x9.value = '';
      });
    }
    if (btnNone16x9) btnNone16x9.addEventListener('click', () => setBorderToNone('16x9'));
    if (btnSample16x9) btnSample16x9.addEventListener('click', () => revertBorderToSample('16x9'));
    if (btnResetBorders) {
      btnResetBorders.addEventListener('click', async () => {
        await StudioDB.del('meta', 'borders');
        state.borderStatus['4x3'] = 'sample';
        state.borderStatus['4:3'] = 'sample';
        state.borderStatus['16x9'] = 'sample';
        state.borderStatus['16:9'] = 'sample';
        await loadBorders();
        scheduleGlobalUpdate(true);
      });
    }

    // Stage Toolbar Controls
    if (btnLiveBgChecker && btnLiveBgSample && artboardWrap) {
      btnLiveBgChecker.addEventListener('click', () => {
        state.stageBackdrop = 'checker';
        btnLiveBgChecker.classList.add('active');
        btnLiveBgSample.classList.remove('active');
        artboardWrap.classList.add('checker-dark');
        artboardWrap.classList.remove('sample-backdrop');
        persistWorkspaceMeta(false);
      });
      btnLiveBgSample.addEventListener('click', () => {
        state.stageBackdrop = 'sample';
        btnLiveBgSample.classList.add('active');
        btnLiveBgChecker.classList.remove('active');
        artboardWrap.classList.add('sample-backdrop');
        artboardWrap.classList.remove('checker-dark');
        persistWorkspaceMeta(false);
      });
    }

    if (btnExportActiveSvg) btnExportActiveSvg.addEventListener('click', exportActiveTransparentSvg);
    if (btnExportActivePng) btnExportActivePng.addEventListener('click', exportActiveTransparentPng);

    setupDirectStageInteractions();

    // Right Inspector Scope & Fields
    if (editScopeTabs) {
      editScopeTabs.querySelectorAll('.mode-pill').forEach(btn => {
        btn.addEventListener('click', () => {
          state.editScope = btn.dataset.scope;
          persistWorkspaceMeta(false);
          syncInspectorFromActiveScope();
          renderPresetGallery();
        });
      });
    }

    if (chkItemCustomText) {
      chkItemCustomText.addEventListener('change', () => {
        const sel = getSelectedItem();
        if (!sel) return;
        if (chkItemCustomText.checked) {
          sel.customFields = {
            showStory: state.postFields.showStory,
            category: state.postFields.category,
            date: state.postFields.date,
            heading: state.postFields.heading,
            caption: state.postFields.caption
          };
        } else {
          sel.customFields = null;
        }
        schedulePersistItem(sel);
        syncInspectorFromActiveScope();
        updateFilmstripThumbMeta(sel);
        renderSelectedStageRealtime();
        scheduleSingleItemCommit(sel);
      });
    }

    if (itemTemplateSelect) {
      itemTemplateSelect.addEventListener('change', () => {
        const sel = getSelectedItem();
        if (!sel) return;
        sel.overrideTemplateId = itemTemplateSelect.value || null;
        schedulePersistItem(sel);
        updateFilmstripThumbMeta(sel);
        renderPresetGallery();
        updateStageHeaderMeta();
        renderSelectedStageRealtime();
        scheduleSingleItemCommit(sel);
      });
    }

    if (btnResetItemOverrides) {
      btnResetItemOverrides.addEventListener('click', () => {
        const sel = getSelectedItem();
        if (!sel) return;
        sel.customFields = null;
        sel.overrideTemplateId = null;
        schedulePersistItem(sel);
        syncInspectorFromActiveScope();
        updateFilmstripThumbMeta(sel);
        renderPresetGallery();
        updateStageHeaderMeta();
        renderSelectedStageRealtime();
        scheduleSingleItemCommit(sel);
      });
    }

    [inputCategory, inputDate, inputHeading, inputCaption, inputOrgTitle, inputOrgSubtitle, inputFacebook, inputEmail].forEach(el => {
      if (el) el.addEventListener('input', commitInspectorEdit);
    });

    if (chkShowStory) {
      chkShowStory.addEventListener('change', commitInspectorEdit);
    }

    document.querySelectorAll('.preset-cat-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        if (inputCategory) inputCategory.value = chip.dataset.cat || '';
        if (chkShowStory && chip.dataset.cat) chkShowStory.checked = true;
        commitInspectorEdit();
      });
    });

    if (btnSetToday) {
      btnSetToday.addEventListener('click', () => {
        const d = new Date();
        const months = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
        if (inputDate) inputDate.value = `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} • LARENA, SIQUIJOR`;
        commitInspectorEdit();
      });
    }

    if (btnClearHeading) {
      btnClearHeading.addEventListener('click', () => {
        if (inputHeading) inputHeading.value = '';
        commitInspectorEdit();
      });
    }

    if (btnClearCaption) {
      btnClearCaption.addEventListener('click', () => {
        if (inputCaption) inputCaption.value = '';
        commitInspectorEdit();
      });
    }

    if (btnResetTextDefaults) {
      btnResetTextDefaults.addEventListener('click', () => {
        Object.assign(state.postFields, defaultPostFields);
        syncInspectorFromActiveScope();
        persistWorkspaceMeta(true);
        scheduleGlobalUpdate(true);
      });
    }

    // Settings Modal
    if (btnOpenSettings) btnOpenSettings.addEventListener('click', () => settingsModal.classList.add('open'));
    if (btnCloseSettingsModal) btnCloseSettingsModal.addEventListener('click', () => settingsModal.classList.remove('open'));
    if (btnCancelSettings) btnCancelSettings.addEventListener('click', () => settingsModal.classList.remove('open'));
    if (btnSaveSettings) btnSaveSettings.addEventListener('click', saveSettings);
    settingsModal.addEventListener('click', (e) => {
      if (e.target === settingsModal) settingsModal.classList.remove('open');
    });

    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        settingsModal.classList.remove('open');
        if (resetModal) resetModal.classList.remove('open');
        return;
      }
      const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (state.items.length > 1 && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        const curIdx = state.items.findIndex(i => i.id === state.selectedItemId);
        if (curIdx === -1) return;
        const nextIdx = e.key === 'ArrowRight'
          ? (curIdx + 1) % state.items.length
          : (curIdx - 1 + state.items.length) % state.items.length;
        selectItem(state.items[nextIdx].id);
      }
    });
  }

  function setupDirectStageInteractions() {
    if (!stageCanvas) return;

    const startDrag = (x, y) => {
      if (!getSelectedItem()) return;
      state.stageDrag.active = true;
      state.stageDrag.startX = x;
      state.stageDrag.startY = y;
    };

    const moveDrag = (x, y) => {
      if (!state.stageDrag.active) return;
      const item = getSelectedItem();
      if (!item) return;
      const rect = stageCanvas.getBoundingClientRect();
      const scaleX = stageCanvas.width / Math.max(1, rect.width);
      const scaleY = stageCanvas.height / Math.max(1, rect.height);
      item.panX += (x - state.stageDrag.startX) * scaleX;
      item.panY += (y - state.stageDrag.startY) * scaleY;
      state.stageDrag.startX = x;
      state.stageDrag.startY = y;
      renderSelectedStageRealtime();
      scheduleSingleItemCommit(item);
      schedulePersistItem(item);
    };

    const endDrag = () => {
      state.stageDrag.active = false;
    };

    stageCanvas.addEventListener('mousedown', (e) => startDrag(e.clientX, e.clientY));
    window.addEventListener('mousemove', (e) => moveDrag(e.clientX, e.clientY));
    window.addEventListener('mouseup', endDrag);

    stageCanvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        e.preventDefault();
        startDrag(e.touches[0].clientX, e.touches[0].clientY);
      }
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1 && state.stageDrag.active) {
        moveDrag(e.touches[0].clientX, e.touches[0].clientY);
      }
    });
    window.addEventListener('touchend', endDrag);

    stageCanvas.addEventListener('wheel', (e) => {
      const item = getSelectedItem();
      if (!item) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.06 : -0.06;
      item.zoom = Math.min(3.0, Math.max(1.0, item.zoom + delta));
      if (stageZoomSlider) stageZoomSlider.value = item.zoom;
      if (stageZoomVal) stageZoomVal.textContent = `${item.zoom.toFixed(2)}×`;
      renderSelectedStageRealtime();
      scheduleSingleItemCommit(item);
      schedulePersistItem(item);
    }, { passive: false });

    if (stageZoomSlider) {
      stageZoomSlider.addEventListener('input', () => {
        const item = getSelectedItem();
        if (!item) return;
        item.zoom = parseFloat(stageZoomSlider.value);
        if (stageZoomVal) stageZoomVal.textContent = `${item.zoom.toFixed(2)}×`;
        renderSelectedStageRealtime();
        scheduleSingleItemCommit(item);
        schedulePersistItem(item);
      });
    }

    if (btnStageResetCrop) {
      btnStageResetCrop.addEventListener('click', () => {
        const item = getSelectedItem();
        if (!item) return;
        item.panX = 0;
        item.panY = 0;
        item.zoom = 1.0;
        if (stageZoomSlider) stageZoomSlider.value = 1.0;
        if (stageZoomVal) stageZoomVal.textContent = '1.00×';
        renderSelectedStageRealtime();
        scheduleSingleItemCommit(item);
        schedulePersistItem(item);
      });
    }

    if (btnToggleRawHold) {
      const setRaw = (val) => {
        if (state.holdRawPreview === val) return;
        state.holdRawPreview = val;
        renderSelectedStageRealtime();
      };
      btnToggleRawHold.addEventListener('mousedown', () => setRaw(true));
      btnToggleRawHold.addEventListener('mouseup', () => setRaw(false));
      btnToggleRawHold.addEventListener('mouseleave', () => setRaw(false));
      btnToggleRawHold.addEventListener('touchstart', (e) => { e.preventDefault(); setRaw(true); }, { passive: false });
      btnToggleRawHold.addEventListener('touchend', () => setRaw(false));
    }
  }

  // --- Progress & Helpers ---
  function showProgress(pct) {
    if (!progressBarContainer || !progressBar) return;
    progressBarContainer.hidden = false;
    progressBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  }

  function hideProgress() {
    if (!progressBarContainer || !progressBar) return;
    progressBarContainer.hidden = true;
    progressBar.style.width = '0%';
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>'"]/g, tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag));
  }

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
