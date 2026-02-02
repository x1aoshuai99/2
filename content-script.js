(() => {
  'use strict';

  const VERSION = 'v14';
  const STATE_KEY = 'wiza_agent_state_v14';
  const STORAGE_KEY = 'wiza_agent_memory_v14';

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const jitter = (base = 120, variance = 80) => base + Math.floor(Math.random() * variance);

  const state = {
    running: false,
    teachMode: false,
    busyMode: false,
    dwellMs: 3000,
    teachBuffer: new Map(),
  };

  const memory = {
    strongM: new Set(),
    strongF: new Set(),
    weakM: new Set(),
    weakF: new Set(),
    blocked: new Set(),
  };

  const loadMemory = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      ['strongM', 'strongF', 'weakM', 'weakF', 'blocked'].forEach((key) => {
        if (Array.isArray(parsed[key])) {
          memory[key] = new Set(parsed[key]);
        }
      });
    } catch (error) {
      console.warn('[Wiza]', error);
    }
  };

  const saveMemory = () => {
    const payload = {
      strongM: Array.from(memory.strongM),
      strongF: Array.from(memory.strongF),
      weakM: Array.from(memory.weakM),
      weakF: Array.from(memory.weakF),
      blocked: Array.from(memory.blocked),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  };

  const persistState = () => {
    const payload = {
      running: state.running,
      teachMode: state.teachMode,
      busyMode: state.busyMode,
      version: VERSION,
    };
    localStorage.setItem(STATE_KEY, JSON.stringify(payload));
  };

  const loadState = () => {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      state.running = Boolean(parsed.running);
      state.teachMode = Boolean(parsed.teachMode);
      state.busyMode = Boolean(parsed.busyMode);
    } catch (error) {
      console.warn('[Wiza]', error);
    }
  };

  const normalize = (value) => value.replace(/\s+/g, ' ').trim();

  const getRowName = (row) => {
    const nameEl = row.querySelector('[data-person-name], .entity-result__title-text, .artdeco-entity-lockup__title');
    if (!nameEl) return '';
    return normalize(nameEl.textContent || '');
  };

  const getRowJob = (row) => {
    const jobEl = row.querySelector('[data-person-job], .entity-result__primary-subtitle, .artdeco-entity-lockup__subtitle');
    if (!jobEl) return '';
    return normalize(jobEl.textContent || '');
  };

  const getRowKey = (row) => {
    const name = getRowName(row);
    const job = getRowJob(row);
    return normalize(`${name}||${job}`);
  };

  const getRowHint = (row) => {
    const hintEl = row.querySelector('[data-gender-hint]');
    if (hintEl) {
      const hint = (hintEl.getAttribute('data-gender-hint') || '').toLowerCase();
      return {
        hintM: hint === 'm' || hint === 'male',
        hintF: hint === 'f' || hint === 'female',
        neutral: hint === 'neutral',
      };
    }
    return { hintM: false, hintF: false, neutral: false };
  };

  const getRowProbability = (row) => {
    const probEl = row.querySelector('[data-probability]');
    if (!probEl) return null;
    const value = parseFloat(probEl.getAttribute('data-probability') || '');
    return Number.isFinite(value) ? value : null;
  };

  const getRowData = (row) => ({
    key: getRowKey(row),
    name: getRowName(row),
    job: getRowJob(row),
    hint: getRowHint(row),
    probability: getRowProbability(row),
  });

  const rowSelector = [
    '[data-person-row]',
    '.entity-result',
    '.reusable-search__result-container',
  ].join(',');

  const findRowFromElement = (element) => element.closest(rowSelector);

  const isNeutralName = (name) => !name || name.length < 2;

  const repairConsistency = () => {
    memory.strongM.forEach((key) => {
      memory.strongF.delete(key);
      memory.blocked.delete(key);
    });
    memory.strongF.forEach((key) => {
      memory.strongM.delete(key);
      memory.blocked.delete(key);
    });
    memory.blocked.forEach((key) => {
      memory.strongM.delete(key);
      memory.strongF.delete(key);
    });
  };

  const commitTeachBuffer = () => {
    state.teachBuffer.forEach((action, key) => {
      if (action === 'check') {
        memory.strongM.add(key);
        memory.blocked.delete(key);
        memory.strongF.delete(key);
      }
      if (action === 'uncheck') {
        memory.blocked.add(key);
        memory.strongF.add(key);
        memory.strongM.delete(key);
      }
    });
    repairConsistency();
    saveMemory();
    state.teachBuffer.clear();
  };

  const handleTeachClick = (row, checked) => {
    const { key } = getRowData(row);
    if (!key) return;
    state.teachBuffer.set(key, checked ? 'check' : 'uncheck');
  };

  const autoLearnWeak = (row) => {
    if (!state.busyMode) return;
    const data = getRowData(row);
    if (!data.key || isNeutralName(data.name) || data.hint.neutral) return;
    const p = data.probability;
    if (typeof p !== 'number') return;
    if (p >= 0.99 && data.hint.hintM) {
      memory.weakM.add(data.key);
      memory.weakF.delete(data.key);
      memory.blocked.delete(data.key);
    }
    if (p <= 0.03 && data.hint.hintF) {
      memory.weakF.add(data.key);
      memory.weakM.delete(data.key);
      memory.blocked.delete(data.key);
    }
  };

  const clickCheckbox = async (checkbox) => {
    if (!checkbox || checkbox.disabled) return;
    await sleep(jitter());
    checkbox.click();
  };

  const collectRows = () => Array.from(document.querySelectorAll(rowSelector));

  const scrollNextPage = () => {
    const container = document.scrollingElement || document.documentElement;
    container.scrollBy({ top: window.innerHeight * 0.9, behavior: 'smooth' });
  };

  const busyLoop = async () => {
    while (state.running && state.busyMode) {
      const rows = collectRows();
      rows.forEach((row) => autoLearnWeak(row));
      await sleep(state.dwellMs);
      if (!state.running || !state.busyMode) break;
      scrollNextPage();
      await sleep(jitter(200, 200));
    }
  };

  const onDocumentClick = (event) => {
    const checkbox = event.target.closest('input[type="checkbox"]');
    if (!checkbox) return;
    const row = findRowFromElement(checkbox);
    if (!row) return;
    if (state.teachMode) {
      handleTeachClick(row, checkbox.checked);
    }
  };

  const createButton = (id, label) => {
    const button = document.createElement('button');
    button.id = id;
    button.textContent = label;
    button.style.cssText = 'margin:4px;padding:6px 10px;font-size:12px;';
    return button;
  };

  const mountUi = () => {
    if (document.getElementById('wiza-agent-ui')) return;
    const wrapper = document.createElement('div');
    wrapper.id = 'wiza-agent-ui';
    wrapper.style.cssText = [
      'position:fixed',
      'bottom:16px',
      'right:16px',
      'background:#ffffff',
      'border:1px solid #ddd',
      'box-shadow:0 2px 8px rgba(0,0,0,0.1)',
      'padding:8px',
      'z-index:999999',
      'font-family:system-ui, sans-serif',
    ].join(';');

    const startBtn = createButton('wiza-start', 'Start');
    const teachBtn = createButton('wiza-teach', 'Teach');
    const saveBtn = createButton('wiza-save', 'Save');
    const stopBtn = createButton('wiza-stop', 'Stop');
    const exportBtn = createButton('wiza-export', 'Export');

    wrapper.append(startBtn, teachBtn, saveBtn, stopBtn, exportBtn);
    document.body.appendChild(wrapper);

    bindButton('wiza-start', () => {
      state.running = true;
      state.busyMode = true;
      persistState();
      busyLoop();
    });

    bindButton('wiza-teach', () => {
      state.teachMode = !state.teachMode;
      state.busyMode = false;
      persistState();
    });

    bindButton('wiza-save', () => {
      if (state.teachMode) {
        commitTeachBuffer();
      }
    });

    bindButton('wiza-stop', () => {
      state.running = false;
      state.busyMode = false;
      state.teachMode = false;
      persistState();
    });

    bindButton('wiza-export', () => {
      saveMemory();
      const data = {
        strongM: Array.from(memory.strongM),
        strongF: Array.from(memory.strongF),
        weakM: Array.from(memory.weakM),
        weakF: Array.from(memory.weakF),
        blocked: Array.from(memory.blocked),
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'wiza-memory.json';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    });
  };

  const bindButton = (id, handler) => {
    const element = document.getElementById(id);
    if (!element) return;
    element.addEventListener('click', () => {
      handler();
    });
  };

  const init = () => {
    loadMemory();
    loadState();
    mountUi();
    document.addEventListener('click', onDocumentClick, true);
    if (state.running && state.busyMode) {
      busyLoop();
    }
  };

  init();
})();
