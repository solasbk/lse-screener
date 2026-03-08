/* app.js — LSE Stock Screener */
(function () {
  'use strict';

  // ===== THEME TOGGLE =====
  const themeToggle = document.querySelector('[data-theme-toggle]');
  const root = document.documentElement;
  let theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  root.setAttribute('data-theme', theme);
  updateThemeIcon();

  function updateThemeIcon() {
    if (!themeToggle) return;
    themeToggle.innerHTML = theme === 'dark'
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
      : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    themeToggle.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`);
  }

  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      theme = theme === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', theme);
      updateThemeIcon();
    });
  }

  // ===== DATA =====
  const rawData = window.LSE_DATA;
  const ohlcvData = window.LSE_OHLCV || null;
  const SECTORS = rawData.sectors.sort();
  const ALL_INDUSTRIES = rawData.industries.sort();

  // ===== DVT ENGINE =====
  // Computes DVT (Daily Value Traded = close * volume) and averages over N trading days
  // Prices in GBp (pence), so DVT = close_pence * volume / 100 → gives £ GBP value traded
  function computeDVT(symbol, nDays) {
    if (!ohlcvData || !ohlcvData.stocks[symbol]) return { dvt: null, avg_dvt: null };
    const sd = ohlcvData.stocks[symbol];
    const closes = sd.c;
    const volumes = sd.v;
    const len = closes.length;
    // Work backwards from the most recent day
    const dvts = [];
    for (let i = len - 1; i >= 0 && dvts.length < nDays; i--) {
      if (closes[i] != null && volumes[i] != null && volumes[i] > 0) {
        // close is in pence for GBp stocks, divide by 100 for £
        dvts.push(closes[i] * volumes[i] / 100);
      }
    }
    if (dvts.length === 0) return { dvt: null, avg_dvt: null };
    const latestDvt = dvts[0];
    const avgDvt = dvts.reduce((a, b) => a + b, 0) / dvts.length;
    return { dvt: latestDvt, avg_dvt: avgDvt };
  }

  // Compute DVT change % between the last two trading days
  function computeDVTChange(symbol) {
    if (!ohlcvData || !ohlcvData.stocks[symbol]) return null;
    const sd = ohlcvData.stocks[symbol];
    const closes = sd.c;
    const volumes = sd.v;
    const len = closes.length;
    if (len < 2) return null;
    // Find the last two valid DVT values
    let dvtLatest = null;
    let dvtPrev = null;
    for (let i = len - 1; i >= 0; i--) {
      if (closes[i] != null && volumes[i] != null && volumes[i] > 0) {
        const dvt = closes[i] * volumes[i] / 100;
        if (dvtLatest === null) { dvtLatest = dvt; }
        else if (dvtPrev === null) { dvtPrev = dvt; break; }
      }
    }
    if (dvtLatest === null || dvtPrev === null || dvtPrev === 0) return null;
    return ((dvtLatest / dvtPrev) - 1) * 100;
  }

  // Pre-compute DVT cache keyed by period
  let dvtCache = {};

  function computeDVTForPeriod(period) {
    if (dvtCache[period]) return dvtCache[period];
    const cache = {};
    stocks.forEach(s => {
      cache[s.symbol] = computeDVT(s.symbol, period);
    });
    dvtCache[period] = cache;
    return cache;
  }

  // Pre-process stocks — use OHLCV closing price instead of FMP quote price
  const stocks = rawData.stocks.map(s => {
    const mc = s.market_cap || 0;
    const currency = s.currency || 'GBp';
    const mcGBP = mc;
    // Prefer OHLCV closing price over FMP quote price (FMP returns last traded, not official close)
    let closingPrice = s.price || null;
    if (ohlcvData && ohlcvData.stocks[s.symbol]) {
      const closes = ohlcvData.stocks[s.symbol].c;
      // Walk backwards to find the last non-null closing price
      for (let i = closes.length - 1; i >= 0; i--) {
        if (closes[i] != null) { closingPrice = closes[i]; break; }
      }
    }
    return {
      symbol: s.symbol,
      company_name: s.company_name,
      sector: s.sector,
      industry: s.industry,
      currency: currency,
      market_cap: mc,
      market_cap_gbp: mcGBP,
      price: closingPrice,
      change: s.change || null,
      changes_percentage: s.changes_percentage || null,
      volume: s.volume || null,
      avg_volume: s.avg_volume || null,
      year_high: s.year_high || null,
      year_low: s.year_low || null,
      advt_5d: null,
      advt_10d: null,
      advt_20d: null,
      dvt_change_pct: null,
      is_etf: s.is_etf === 'true' || s.is_etf === true,
      is_fund: s.is_fund === 'true' || s.is_fund === true,
      is_actively_trading: true
    };
  });

  // Apply initial DVT values for all three periods
  function updateStockDVT() {
    const cache5 = computeDVTForPeriod(5);
    const cache10 = computeDVTForPeriod(10);
    const cache20 = computeDVTForPeriod(20);
    stocks.forEach(s => {
      const d5 = cache5[s.symbol] || { dvt: null, avg_dvt: null };
      const d10 = cache10[s.symbol] || { dvt: null, avg_dvt: null };
      const d20 = cache20[s.symbol] || { dvt: null, avg_dvt: null };
      s.advt_5d = d5.avg_dvt;
      s.advt_10d = d10.avg_dvt;
      s.advt_20d = d20.avg_dvt;
      s.dvt_change_pct = computeDVTChange(s.symbol);
    });
  }
  updateStockDVT();

  // Build sector -> industries map
  const sectorIndustries = {};
  stocks.forEach(s => {
    if (!sectorIndustries[s.sector]) sectorIndustries[s.sector] = new Set();
    sectorIndustries[s.sector].add(s.industry);
  });

  // ===== STATE =====
  let state = {
    search: '',
    sectors: [],
    industries: [],
    mcapMin: null,
    mcapMax: null,
    advtValMin: null,
    advtValMax: null,
    changeMin: null,
    changeMax: null,
    includeEtfFunds: false,
    dvtSpikeFilter: false,
    sortKey: 'market_cap_gbp',
    sortDir: 'desc',
    page: 1,
    pageSize: 50,
    activePreset: null
  };

  let filteredStocks = [];

  // ===== DOM REFS =====
  const $stockCount = document.getElementById('stockCount');
  const $searchInput = document.getElementById('searchInput');
  const $mcapMin = document.getElementById('mcapMin');
  const $mcapMax = document.getElementById('mcapMax');
  const $etfToggle = document.getElementById('etfToggle');
  const $etfToggleLabel = document.getElementById('etfToggleLabel');
  const $advtValMin = document.getElementById('advtValMin');
  const $advtValMax = document.getElementById('advtValMax');
  const $changeMin = document.getElementById('changeMin');
  const $changeMax = document.getElementById('changeMax');
  const $dvtSpikeBtn = document.getElementById('dvtSpikeBtn');
  const $clearBtn = document.getElementById('clearBtn');
  const $tableBody = document.getElementById('tableBody');
  const $pageInfo = document.getElementById('pageInfo');
  const $pageControls = document.getElementById('pageControls');
  const $statCount = document.getElementById('statCount');
  const $statAvgCap = document.getElementById('statAvgCap');
  const $sectorBars = document.getElementById('sectorBars');
  const $modalBackdrop = document.getElementById('modalBackdrop');
  const $modalTitle = document.getElementById('modalTitle');
  const $modalSymbol = document.getElementById('modalSymbol');
  const $modalBody = document.getElementById('modalBody');
  const $modalClose = document.getElementById('modalClose');
  const $filterToggle = document.getElementById('filterToggle');
  const $filterContent = document.getElementById('filterContent');

  // ===== MARKET CAP PRESETS =====
  const PRESETS = {
    micro: { min: 0, max: 50e6, label: 'Micro <50M' },
    small: { min: 50e6, max: 250e6, label: 'Small 50–250M' },
    mid: { min: 250e6, max: 2e9, label: 'Mid 250M–2B' },
    large: { min: 2e9, max: 10e9, label: 'Large 2–10B' },
    mega: { min: 10e9, max: null, label: 'Mega >10B' }
  };

  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.preset;
      if (state.activePreset === key) {
        // Deactivate
        state.activePreset = null;
        state.mcapMin = null;
        state.mcapMax = null;
        $mcapMin.value = '';
        $mcapMax.value = '';
      } else {
        state.activePreset = key;
        const p = PRESETS[key];
        state.mcapMin = p.min;
        state.mcapMax = p.max;
        $mcapMin.value = p.min ? formatMcapInput(p.min) : '';
        $mcapMax.value = p.max ? formatMcapInput(p.max) : '';
      }
      updatePresetButtons();
      state.page = 1;
      applyFilters();
    });
  });

  function formatMcapInput(val) {
    if (val >= 1e9) return (val / 1e9) + 'B';
    if (val >= 1e6) return (val / 1e6) + 'M';
    return val.toString();
  }

  function parseMcapInput(str) {
    if (!str) return null;
    str = str.trim().toUpperCase().replace(/[£,]/g, '');
    let multiplier = 1;
    if (str.endsWith('B')) { multiplier = 1e9; str = str.slice(0, -1); }
    else if (str.endsWith('M')) { multiplier = 1e6; str = str.slice(0, -1); }
    else if (str.endsWith('K')) { multiplier = 1e3; str = str.slice(0, -1); }
    else { multiplier = 1e6; } // Default to millions
    const num = parseFloat(str);
    return isNaN(num) ? null : num * multiplier;
  }

  function updatePresetButtons() {
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.preset === state.activePreset);
    });
  }

  // ===== MULTI-SELECT COMPONENT =====
  function initMultiSelect(el, options, onChange) {
    const trigger = el.querySelector('.multi-select-trigger');
    const dropdown = el.querySelector('.multi-select-dropdown');
    const textEl = trigger.querySelector('.multi-select-text');
    let selected = [];
    let allOptions = options;
    let searchText = '';

    function render() {
      const filtered = searchText
        ? allOptions.filter(o => o.toLowerCase().includes(searchText.toLowerCase()))
        : allOptions;

      dropdown.innerHTML = `
        <input type="text" class="multi-select-search" placeholder="Search…" value="${searchText}">
        ${filtered.map(o => `
          <div class="multi-select-option ${selected.includes(o) ? 'selected' : ''}" data-value="${o}" role="option" aria-selected="${selected.includes(o)}">
            <div class="multi-select-checkbox">${selected.includes(o) ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' : ''}</div>
            <span>${o}</span>
          </div>
        `).join('')}
        ${filtered.length === 0 ? '<div style="padding:var(--space-3);color:var(--color-text-faint);font-size:var(--text-sm);">No matches</div>' : ''}
      `;

      // Bind option clicks
      dropdown.querySelectorAll('.multi-select-option').forEach(opt => {
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          const val = opt.dataset.value;
          if (selected.includes(val)) {
            selected = selected.filter(s => s !== val);
          } else {
            selected.push(val);
          }
          render();
          updateDisplay();
          onChange(selected);
        });
      });

      // Bind search
      const searchEl = dropdown.querySelector('.multi-select-search');
      if (searchEl) {
        searchEl.addEventListener('input', (e) => {
          searchText = e.target.value;
          render();
        });
        searchEl.addEventListener('click', e => e.stopPropagation());
        if (el.classList.contains('open')) {
          setTimeout(() => searchEl.focus(), 0);
        }
      }
    }

    function updateDisplay() {
      if (selected.length === 0) {
        textEl.className = 'multi-select-text placeholder';
        textEl.textContent = el.dataset.type === 'sector' ? 'All sectors' : 'All industries';
        const existing = trigger.querySelector('.multi-select-count');
        if (existing) existing.remove();
      } else {
        textEl.className = 'multi-select-text has-value';
        textEl.textContent = selected.length === 1 ? selected[0] : `${selected.length} selected`;
        let countEl = trigger.querySelector('.multi-select-count');
        if (!countEl) {
          countEl = document.createElement('span');
          countEl.className = 'multi-select-count';
          trigger.insertBefore(countEl, trigger.querySelector('.multi-select-chevron'));
        }
        countEl.textContent = selected.length;
      }
    }

    function open() {
      el.classList.add('open');
      trigger.classList.add('focused');
      trigger.setAttribute('aria-expanded', 'true');
      searchText = '';
      render();
    }

    function close() {
      el.classList.remove('open');
      trigger.classList.remove('focused');
      trigger.setAttribute('aria-expanded', 'false');
    }

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (el.classList.contains('open')) close();
      else open();
    });

    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (el.classList.contains('open')) close();
        else open();
      }
      if (e.key === 'Escape') close();
    });

    dropdown.addEventListener('click', e => e.stopPropagation());

    return {
      getSelected: () => selected,
      setSelected: (vals) => { selected = vals; updateDisplay(); render(); },
      setOptions: (opts) => { allOptions = opts; render(); },
      close,
      reset: () => { selected = []; searchText = ''; updateDisplay(); }
    };
  }

  // Init sector and industry selects
  const sectorMS = initMultiSelect(document.getElementById('sectorSelect'), SECTORS, (sel) => {
    state.sectors = sel;
    // Update industry options based on selected sectors
    updateIndustryOptions();
    state.page = 1;
    applyFilters();
  });

  const industryMS = initMultiSelect(document.getElementById('industrySelect'), ALL_INDUSTRIES, (sel) => {
    state.industries = sel;
    state.page = 1;
    applyFilters();
  });

  function updateIndustryOptions() {
    if (state.sectors.length === 0) {
      industryMS.setOptions(ALL_INDUSTRIES);
    } else {
      const relevantIndustries = new Set();
      state.sectors.forEach(sec => {
        (sectorIndustries[sec] || new Set()).forEach(ind => relevantIndustries.add(ind));
      });
      const sorted = [...relevantIndustries].sort();
      industryMS.setOptions(sorted);
      // Remove any selected industries that are no longer available
      const current = industryMS.getSelected().filter(i => relevantIndustries.has(i));
      if (current.length !== industryMS.getSelected().length) {
        industryMS.setSelected(current);
        state.industries = current;
      }
    }
  }

  // Close dropdowns when clicking outside
  document.addEventListener('click', () => {
    sectorMS.close();
    industryMS.close();
  });

  // ===== SEARCH =====
  let searchTimeout;
  $searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.search = $searchInput.value;
      state.page = 1;
      applyFilters();
    }, 150);
  });

  // ===== MCAP INPUTS =====
  $mcapMin.addEventListener('change', () => {
    state.mcapMin = parseMcapInput($mcapMin.value);
    state.activePreset = null;
    updatePresetButtons();
    state.page = 1;
    applyFilters();
  });
  $mcapMax.addEventListener('change', () => {
    state.mcapMax = parseMcapInput($mcapMax.value);
    state.activePreset = null;
    updatePresetButtons();
    state.page = 1;
    applyFilters();
  });

  // ===== AVG DVT / CHANGE INPUTS =====
  function parseDvtInput(str) {
    if (!str) return null;
    str = str.trim().toUpperCase().replace(/[£,]/g, '');
    let multiplier = 1;
    if (str.endsWith('B')) { multiplier = 1e9; str = str.slice(0, -1); }
    else if (str.endsWith('M')) { multiplier = 1e6; str = str.slice(0, -1); }
    else if (str.endsWith('K')) { multiplier = 1e3; str = str.slice(0, -1); }
    const num = parseFloat(str);
    return isNaN(num) ? null : num * multiplier;
  }

  function parseChangeInput(str) {
    if (!str) return null;
    str = str.trim().replace(/%/g, '');
    const num = parseFloat(str);
    return isNaN(num) ? null : num;
  }

  $advtValMin.addEventListener('change', () => { state.advtValMin = parseDvtInput($advtValMin.value); state.page = 1; applyFilters(); });
  $advtValMax.addEventListener('change', () => { state.advtValMax = parseDvtInput($advtValMax.value); state.page = 1; applyFilters(); });
  $changeMin.addEventListener('change', () => { state.changeMin = parseChangeInput($changeMin.value); state.page = 1; applyFilters(); });
  $changeMax.addEventListener('change', () => { state.changeMax = parseChangeInput($changeMax.value); state.page = 1; applyFilters(); });

  // ===== DVT SPIKE FILTER =====
  $dvtSpikeBtn.addEventListener('click', () => {
    state.dvtSpikeFilter = !state.dvtSpikeFilter;
    $dvtSpikeBtn.classList.toggle('active', state.dvtSpikeFilter);
    if (state.dvtSpikeFilter) {
      // Auto-sort by DVT change % descending when activating
      state.sortKey = 'dvt_change_pct';
      state.sortDir = 'desc';
    }
    state.page = 1;
    applyFilters();
  });

  // ===== ETF/FUND TOGGLE =====
  function toggleEtf() {
    state.includeEtfFunds = !state.includeEtfFunds;
    $etfToggle.classList.toggle('active', state.includeEtfFunds);
    $etfToggle.setAttribute('aria-checked', state.includeEtfFunds);
    $etfToggleLabel.textContent = state.includeEtfFunds ? 'On' : 'Off';
    state.page = 1;
    applyFilters();
  }

  $etfToggle.addEventListener('click', toggleEtf);
  $etfToggle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleEtf(); }
  });

  // ===== CLEAR ALL =====
  $clearBtn.addEventListener('click', () => {
    state.search = '';
    state.sectors = [];
    state.industries = [];
    state.mcapMin = null;
    state.mcapMax = null;
    state.advtValMin = null;
    state.advtValMax = null;
    state.changeMin = null;
    state.changeMax = null;
    state.includeEtfFunds = false;
    state.dvtSpikeFilter = false;
    state.activePreset = null;
    state.page = 1;

    $searchInput.value = '';
    $mcapMin.value = '';
    $mcapMax.value = '';
    $advtValMin.value = '';
    $advtValMax.value = '';
    $changeMin.value = '';
    $changeMax.value = '';
    $etfToggle.classList.remove('active');
    $etfToggle.setAttribute('aria-checked', 'false');
    $etfToggleLabel.textContent = 'Off';
    $dvtSpikeBtn.classList.remove('active');
    sectorMS.reset();
    industryMS.reset();
    updatePresetButtons();
    updateIndustryOptions();
    applyFilters();
  });

  // ===== MOBILE FILTER TOGGLE =====
  $filterToggle.addEventListener('click', () => {
    const open = $filterContent.classList.toggle('open');
    $filterToggle.classList.toggle('active', open);
    $filterToggle.setAttribute('aria-expanded', open);
  });

  // ===== SORTING =====
  document.querySelectorAll('.data-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = key;
        const descByDefault = ['market_cap_gbp', 'price', 'volume', 'advt_5d', 'advt_10d', 'advt_20d', 'dvt_change_pct', 'changes_percentage'];
        state.sortDir = descByDefault.includes(key) ? 'desc' : 'asc';
      }
      state.page = 1;
      applyFilters();
    });
  });

  // ===== FORMAT HELPERS =====
  function formatMarketCap(gbp) {
    if (!gbp || gbp <= 0) return '—';
    if (gbp >= 1e12) return '£' + (gbp / 1e12).toFixed(1) + 'T';
    if (gbp >= 1e9) return '£' + (gbp / 1e9).toFixed(1) + 'B';
    if (gbp >= 1e6) return '£' + (gbp / 1e6).toFixed(1) + 'M';
    if (gbp >= 1e3) return '£' + (gbp / 1e3).toFixed(0) + 'K';
    return '£' + gbp.toFixed(0);
  }

  function formatNumber(n) {
    return n.toLocaleString('en-GB');
  }

  function formatVolume(v) {
    if (v == null || v === 0) return '—';
    if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
    return v.toFixed(0);
  }

  function formatDVT(v) {
    if (v == null || v === 0) return '—';
    if (v >= 1e9) return '£' + (v / 1e9).toFixed(1) + 'B';
    if (v >= 1e6) return '£' + (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return '£' + (v / 1e3).toFixed(0) + 'K';
    return '£' + v.toFixed(0);
  }

  function formatPrice(p, currency) {
    if (p == null) return '—';
    const sym = (currency === 'GBp') ? '' : '£';
    const suffix = (currency === 'GBp') ? 'p' : '';
    return sym + p.toFixed(2) + suffix;
  }

  function formatChange(c) {
    if (c == null) return '—';
    const sign = c > 0 ? '+' : '';
    return sign + c.toFixed(2) + '%';
  }

  // ===== SECTOR COLORS =====
  const SECTOR_COLORS = {
    'Basic Materials': '#64748b',
    'Communication Services': '#8b5cf6',
    'Consumer Cyclical': '#f59e0b',
    'Consumer Defensive': '#10b981',
    'Energy': '#ef4444',
    'Financial Services': '#3b82f6',
    'Healthcare': '#06b6d4',
    'Industrials': '#6366f1',
    'Real Estate': '#f97316',
    'Technology': '#a855f7',
    'Utilities': '#84cc16'
  };

  // ===== APPLY FILTERS =====
  function applyFilters() {
    const search = state.search.toLowerCase().trim();

    filteredStocks = stocks.filter(s => {
      // ETF/Fund filter
      if (!state.includeEtfFunds && (s.is_etf || s.is_fund)) return false;

      // Search
      if (search && !s.symbol.toLowerCase().includes(search) && !s.company_name.toLowerCase().includes(search)) return false;

      // Sector
      if (state.sectors.length > 0 && !state.sectors.includes(s.sector)) return false;

      // Industry
      if (state.industries.length > 0 && !state.industries.includes(s.industry)) return false;

      // Market cap
      if (state.mcapMin !== null && s.market_cap_gbp < state.mcapMin) return false;
      if (state.mcapMax !== null && s.market_cap_gbp > state.mcapMax) return false;

      // Avg DVT (value traded) — filter on 5D ADVT
      if (state.advtValMin !== null && (s.advt_5d == null || s.advt_5d < state.advtValMin)) return false;
      if (state.advtValMax !== null && (s.advt_5d == null || s.advt_5d > state.advtValMax)) return false;

      // Price Change %
      if (state.changeMin !== null && (s.changes_percentage == null || s.changes_percentage < state.changeMin)) return false;
      if (state.changeMax !== null && (s.changes_percentage == null || s.changes_percentage > state.changeMax)) return false;

      // DVT Spike filter — only stocks with >10% DVT increase
      if (state.dvtSpikeFilter) {
        if (s.dvt_change_pct == null || s.dvt_change_pct <= 10) return false;
      }

      return true;
    });

    // Sort
    filteredStocks.sort((a, b) => {
      let aVal = a[state.sortKey];
      let bVal = b[state.sortKey];
      if (typeof aVal === 'string') aVal = aVal.toLowerCase();
      if (typeof bVal === 'string') bVal = bVal.toLowerCase();
      if (aVal == null) aVal = state.sortDir === 'asc' ? Infinity : -Infinity;
      if (bVal == null) bVal = state.sortDir === 'asc' ? Infinity : -Infinity;
      if (aVal < bVal) return state.sortDir === 'asc' ? -1 : 1;
      if (aVal > bVal) return state.sortDir === 'asc' ? 1 : -1;
      return 0;
    });

    renderAll();
  }

  // ===== RENDER =====
  function renderAll() {
    renderStockCount();
    renderSortHeaders();
    renderTable();
    renderPagination();
    renderStats();
  }

  function renderStockCount() {
    $stockCount.textContent = `${formatNumber(filteredStocks.length)} of ${formatNumber(stocks.length)} stocks`;
  }

  function renderSortHeaders() {
    document.querySelectorAll('.data-table th[data-sort]').forEach(th => {
      const key = th.dataset.sort;
      const isSorted = state.sortKey === key;
      th.classList.toggle('sorted', isSorted);
      const icon = th.querySelector('.sort-icon');
      if (isSorted) {
        icon.textContent = state.sortDir === 'asc' ? '↑' : '↓';
      } else {
        icon.textContent = '↕';
      }
    });
  }

  function renderTable() {
    const start = (state.page - 1) * state.pageSize;
    const end = start + state.pageSize;
    const pageStocks = filteredStocks.slice(start, end);

    if (pageStocks.length === 0) {
      $tableBody.innerHTML = `
        <tr>
          <td colspan="12" style="padding:0;border:none;">
            <div class="empty-state">
              <div class="empty-state-icon">
                <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="11" cy="11" r="8"/>
                  <path d="m21 21-4.35-4.35"/>
                  <path d="M8 11h6"/>
                </svg>
              </div>
              <h3>No stocks found</h3>
              <p>Try adjusting your filters or search query to find what you're looking for.</p>
              <button class="clear-btn" onclick="document.getElementById('clearBtn').click()">Clear All Filters</button>
            </div>
          </td>
        </tr>
      `;
      return;
    }

    $tableBody.innerHTML = pageStocks.map(s => {
      const changeClass = s.changes_percentage > 0 ? 'change-pos' : s.changes_percentage < 0 ? 'change-neg' : '';
      const dvtChgClass = s.dvt_change_pct > 0 ? 'change-pos' : s.dvt_change_pct < 0 ? 'change-neg' : '';
      const dvtChgStr = s.dvt_change_pct != null ? ((s.dvt_change_pct > 0 ? '+' : '') + s.dvt_change_pct.toFixed(1) + '%') : '—';
      return `
      <tr data-symbol="${s.symbol}">
        <td class="col-symbol">${s.symbol}</td>
        <td class="col-company">${escapeHtml(s.company_name)}</td>
        <td class="col-sector">${s.sector}</td>
        <td class="col-mcap">${formatMarketCap(s.market_cap_gbp)}</td>
        <td class="col-price">${formatPrice(s.price, s.currency)}</td>
        <td class="col-change ${changeClass}">${formatChange(s.changes_percentage)}</td>
        <td class="col-volume">${formatVolume(s.volume)}</td>
        <td class="col-advt">${formatDVT(s.advt_5d)}</td>
        <td class="col-advt">${formatDVT(s.advt_10d)}</td>
        <td class="col-advt">${formatDVT(s.advt_20d)}</td>
        <td class="col-dvtchg ${dvtChgClass}">${dvtChgStr}</td>
        <td class="col-currency">${s.currency}</td>
      </tr>`;
    }).join('');

    // Row click handlers
    $tableBody.querySelectorAll('tr[data-symbol]').forEach(tr => {
      tr.addEventListener('click', () => openModal(tr.dataset.symbol));
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function renderPagination() {
    const totalPages = Math.max(1, Math.ceil(filteredStocks.length / state.pageSize));
    const start = (state.page - 1) * state.pageSize + 1;
    const end = Math.min(state.page * state.pageSize, filteredStocks.length);

    if (filteredStocks.length === 0) {
      $pageInfo.textContent = '0 results';
      $pageControls.innerHTML = '';
      return;
    }

    $pageInfo.textContent = `${formatNumber(start)}–${formatNumber(end)} of ${formatNumber(filteredStocks.length)}`;

    let buttons = '';

    // Prev
    buttons += `<button class="page-btn" ${state.page <= 1 ? 'disabled' : ''} data-page="${state.page - 1}" aria-label="Previous page">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
    </button>`;

    // Page numbers
    const pages = getPageNumbers(state.page, totalPages);
    pages.forEach(p => {
      if (p === '...') {
        buttons += `<span class="page-btn" style="cursor:default;">…</span>`;
      } else {
        buttons += `<button class="page-btn ${p === state.page ? 'active' : ''}" data-page="${p}">${p}</button>`;
      }
    });

    // Next
    buttons += `<button class="page-btn" ${state.page >= totalPages ? 'disabled' : ''} data-page="${state.page + 1}" aria-label="Next page">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
    </button>`;

    $pageControls.innerHTML = buttons;

    $pageControls.querySelectorAll('button[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = parseInt(btn.dataset.page);
        if (p >= 1 && p <= totalPages) {
          state.page = p;
          renderTable();
          renderPagination();
          document.getElementById('main-table').scrollTop = 0;
        }
      });
    });
  }

  function getPageNumbers(current, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const pages = [];
    if (current <= 4) {
      for (let i = 1; i <= 5; i++) pages.push(i);
      pages.push('...');
      pages.push(total);
    } else if (current >= total - 3) {
      pages.push(1);
      pages.push('...');
      for (let i = total - 4; i <= total; i++) pages.push(i);
    } else {
      pages.push(1);
      pages.push('...');
      for (let i = current - 1; i <= current + 1; i++) pages.push(i);
      pages.push('...');
      pages.push(total);
    }
    return pages;
  }

  function renderStats() {
    $statCount.textContent = formatNumber(filteredStocks.length);

    // Average market cap
    const withMcap = filteredStocks.filter(s => s.market_cap_gbp > 0);
    if (withMcap.length > 0) {
      const avg = withMcap.reduce((sum, s) => sum + s.market_cap_gbp, 0) / withMcap.length;
      $statAvgCap.textContent = formatMarketCap(avg);
    } else {
      $statAvgCap.textContent = '—';
    }

    // Sector breakdown
    const sectorCounts = {};
    filteredStocks.forEach(s => {
      sectorCounts[s.sector] = (sectorCounts[s.sector] || 0) + 1;
    });

    const total = filteredStocks.length || 1;
    $sectorBars.innerHTML = SECTORS
      .filter(sec => sectorCounts[sec])
      .map(sec => {
        const count = sectorCounts[sec];
        const pct = (count / total * 100).toFixed(1);
        const color = SECTOR_COLORS[sec] || '#888';
        return `<div class="sector-bar-segment" style="flex:${count};background:${color};" title="${sec}: ${count}">
          <div class="sector-tooltip">${sec} · ${count} (${pct}%)</div>
        </div>`;
      }).join('');
  }

  // ===== MODAL =====
  function openModal(symbol) {
    const stock = stocks.find(s => s.symbol === symbol);
    if (!stock) return;

    $modalTitle.textContent = stock.company_name;
    $modalSymbol.textContent = stock.symbol;

    let typeLabel = 'Stock';
    let typeClass = 'stock';
    if (stock.is_etf) { typeLabel = 'ETF'; typeClass = 'etf'; }
    else if (stock.is_fund) { typeLabel = 'Fund'; typeClass = 'fund'; }

    const changeClass = stock.changes_percentage > 0 ? 'change-pos' : stock.changes_percentage < 0 ? 'change-neg' : '';
    const changeHtml = stock.changes_percentage != null
      ? `<span class="${changeClass}">${formatChange(stock.changes_percentage)}</span>`
      : '—';

    // Build last 10 trading days table from OHLCV data
    let historyHtml = '';
    if (ohlcvData && ohlcvData.stocks[symbol]) {
      const sd = ohlcvData.stocks[symbol];
      const dates = ohlcvData.dates;
      const len = sd.c.length;
      const rows = [];
      // Walk backwards from most recent, collect up to 10 valid days
      for (let i = len - 1; i >= 0 && rows.length < 10; i--) {
        const close = sd.c[i];
        const vol = sd.v[i];
        if (close != null && vol != null) {
          const dvt = close * vol / 100;
          // Format date nicely: e.g. "Mon 02 Mar"
          const d = new Date(dates[i] + 'T00:00:00');
          const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
          const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
          const dateStr = dayNames[d.getDay()] + ' ' + String(d.getDate()).padStart(2,'0') + ' ' + monthNames[d.getMonth()];
          rows.push({ date: dateStr, close, vol, dvt });
        }
      }

      if (rows.length > 0) {
        historyHtml = `
          <div class="history-section">
            <div class="history-title">Last ${rows.length} Trading Days</div>
            <table class="history-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Close</th>
                  <th>Volume</th>
                  <th>DVT</th>
                </tr>
              </thead>
              <tbody>
                ${rows.map((r, idx) => {
                  // Compute day-over-day change for close
                  const prev = rows[idx + 1];
                  let chgClass = '';
                  if (prev) {
                    chgClass = r.close > prev.close ? 'change-pos' : r.close < prev.close ? 'change-neg' : '';
                  }
                  return `<tr>
                    <td class="hist-date">${r.date}</td>
                    <td class="hist-num ${chgClass}">${formatPrice(r.close, stock.currency)}</td>
                    <td class="hist-num">${formatVolume(r.vol)}</td>
                    <td class="hist-num">${formatDVT(r.dvt)}</td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        `;
      }
    }

    $modalBody.innerHTML = `
      <div class="detail-grid">
        <div class="detail-item" style="grid-column: 1/-1;">
          <div class="detail-label">Market Capitalisation</div>
          <div class="detail-value large">${formatMarketCap(stock.market_cap_gbp)}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Price</div>
          <div class="detail-value">${formatPrice(stock.price, stock.currency)}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Change %</div>
          <div class="detail-value">${changeHtml}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Volume</div>
          <div class="detail-value">${formatVolume(stock.volume)}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">5D ADVT</div>
          <div class="detail-value">${formatDVT(stock.advt_5d)}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">10D ADVT</div>
          <div class="detail-value">${formatDVT(stock.advt_10d)}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">20D ADVT</div>
          <div class="detail-value">${formatDVT(stock.advt_20d)}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">52W High</div>
          <div class="detail-value">${formatPrice(stock.year_high, stock.currency)}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">52W Low</div>
          <div class="detail-value">${formatPrice(stock.year_low, stock.currency)}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Sector</div>
          <div class="detail-value">${stock.sector}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Industry</div>
          <div class="detail-value">${stock.industry}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Currency</div>
          <div class="detail-value">${stock.currency}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Type</div>
          <div class="detail-value"><span class="detail-badge ${typeClass}">${typeLabel}</span></div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Trading Status</div>
          <div class="detail-value"><span class="detail-badge" style="background:var(--color-success-highlight);color:var(--color-success);">Active</span></div>
        </div>
      </div>
      ${historyHtml}
    `;

    $modalBackdrop.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    $modalBackdrop.classList.remove('open');
    document.body.style.overflow = '';
  }

  $modalClose.addEventListener('click', closeModal);
  $modalBackdrop.addEventListener('click', (e) => {
    if (e.target === $modalBackdrop) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $modalBackdrop.classList.contains('open')) closeModal();
  });

  // ===== SET PRICE DATE =====
  if (ohlcvData && ohlcvData.dates && ohlcvData.dates.length > 0) {
    const lastDate = ohlcvData.dates[ohlcvData.dates.length - 1];
    const d = new Date(lastDate + 'T00:00:00');
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const dateStr = dayNames[d.getDay()] + ' ' + String(d.getDate()).padStart(2,'0') + ' ' + monthNames[d.getMonth()] + ' ' + d.getFullYear();
    const $priceDate = document.getElementById('priceDate');
    if ($priceDate) $priceDate.textContent = dateStr;
  }

  // ===== INITIAL RENDER =====
  applyFilters();

})();
