(function() {
  if (window.__KCEX_SECONDS_ENGINE_V6__) return;
  window.__KCEX_SECONDS_ENGINE_V6__ = true;

  const SECOND_INTERVALS = [
    { label: '1s', res: '1S', seconds: 1, defaultFav: true },
    { label: '5s', res: '5S', seconds: 5, defaultFav: true },
    { label: '10s', res: '10S', seconds: 10, defaultFav: true },
    { label: '15s', res: '15S', seconds: 15, defaultFav: true },
    { label: '30s', res: '30S', seconds: 30, defaultFav: true }
  ];

  const FAV_STORAGE_KEY = 'kcex_custom_sec_favs_v6';
  const origFetch = window.fetch.bind(window);
  const OrigXHR = window.XMLHttpRequest;

  function getFavResolutions() {
    try {
      const saved = localStorage.getItem(FAV_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (e) {}
    return SECOND_INTERVALS.filter(x => x.defaultFav).map(x => x.res);
  }

  function saveFavResolutions(list) {
    try {
      localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify(list));
    } catch (e) {}
  }

  let favResolutions = getFavResolutions();
  let currentActiveResolution = null; // '1S', '5S', '10S', '15S', '30S' or null
  let isTogglingReactInterval = false;

  const symbolStores = new Map();
  const activeWebSockets = new Set();
  const wsTemplatesBySymbol = new Map();
  let cachedKlineChartInstance = null;
  let webpackHooked = false;

  let lastUrlSymbol = getCurrentUrlSymbol();
  let symbolTransitionLockUntil = 0;

  function getActiveSecStep() {
    if (!currentActiveResolution) return null;
    const m = String(currentActiveResolution).match(/^(\d+)S$/i);
    return m ? (parseInt(m[1], 10) || 1) : null;
  }

  function getCurrentUrlSymbol() {
    const m = location.pathname.match(/\/exchange\/([A-Z0-9_]+)/i);
    return m ? m[1].toUpperCase() : null;
  }

  // Supports full 12-decimal precision for low-price coins (PEPE, SHIB, BONK, etc.)
  function countDecimalsOfNumber(n) {
    const p = Number(n);
    if (!Number.isFinite(p) || p <= 0) return 2;
    const s = p.toFixed(12).replace(/0+$/, '');
    const dot = s.indexOf('.');
    if (dot === -1 || dot === s.length - 1) return 0;
    return s.length - dot - 1;
  }

  function updateStorePrecisionFromPrices(store, prices) {
    let maxDec = store.decimals || 0;
    for (const raw of prices) {
      const p = Number(raw);
      if (!Number.isFinite(p) || p <= 0) continue;
      const d = countDecimalsOfNumber(p);
      if (d > maxDec) maxDec = d;
      if (p < 0.01) {
        const minForTiny = Math.min(12, Math.max(6, Math.ceil(-Math.log10(p)) + 4));
        if (minForTiny > maxDec) maxDec = minForTiny;
      } else if (p < 1) {
        maxDec = Math.max(maxDec, 4);
      } else {
        maxDec = Math.max(maxDec, 2);
      }
    }
    maxDec = Math.min(12, Math.max(2, maxDec));
    store.decimals = maxDec;
    store.tickSize = Math.pow(10, -maxDec);
  }

  function roundPrice(val, store) {
    const num = Number(val);
    if (!Number.isFinite(num)) return 0;
    const dec = (store && store.decimals) ? store.decimals : Math.max(2, countDecimalsOfNumber(num));
    return Number(num.toFixed(dec));
  }

  // Sanity check: ensures a price belongs to `store` and is NEVER leaked from a previous symbol
  function isPriceValidForStore(store, price) {
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) return false;
    if (!store.refPrice || !Number.isFinite(store.refPrice) || store.refPrice <= 0) {
      return true;
    }
    const ratio = p / store.refPrice;
    return ratio > 0.35 && ratio < 2.85;
  }

  function getStore(symbol) {
    const sym = (symbol || getCurrentUrlSymbol() || 'BTC_USDT').toUpperCase();
    if (!symbolStores.has(sym)) {
      symbolStores.set(sym, {
        symbol: sym,
        liveSecMap: new Map(),        // sec -> { open, high, low, close, volume, ticks }
        min1Cache: new Map(),         // minSec -> { open, high, low, close, volume }
        activeBucketCache: new Map(), // `${secStep}_${bucketSec}` -> bar
        refPrice: null,               // verified anchor price from API
        lastPrice: null,
        decimals: null,
        tickSize: null,
        historyLoaded: false,
        lastIngestedDealTs: 0,
        lastDealsFetchMs: 0,
        lastKlinePollMs: 0,
        fetchingDeals: false,
        pollingKline: false
      });
    }
    return symbolStores.get(sym);
  }

  function purgeInvalidEntriesFromStore(store) {
    if (!store || !store.refPrice) return;
    for (const [sec, b] of Array.from(store.liveSecMap.entries())) {
      if (!isPriceValidForStore(store, b.close) || !isPriceValidForStore(store, b.open) || !isPriceValidForStore(store, b.high) || !isPriceValidForStore(store, b.low)) {
        store.liveSecMap.delete(sec);
      }
    }
    for (const [key, b] of Array.from(store.activeBucketCache.entries())) {
      if (!isPriceValidForStore(store, b.close) || !isPriceValidForStore(store, b.open) || !isPriceValidForStore(store, b.high) || !isPriceValidForStore(store, b.low)) {
        store.activeBucketCache.delete(key);
      }
    }
  }

  // Record a verified live tick for `symbol`
  function recordLiveTick(symbol, price, volume, customNowMs, isVerifiedApi = false) {
    if (!symbol) return;
    const sym = String(symbol).toUpperCase();
    const p = Number(price);
    const v = Number(volume) || 0;
    if (!Number.isFinite(p) || p <= 0) return;

    const store = getStore(sym);

    if (isVerifiedApi) {
      const wasUnset = !store.refPrice || !isPriceValidForStore(store, p);
      store.refPrice = p;
      updateStorePrecisionFromPrices(store, [p]);
      if (wasUnset) {
        purgeInvalidEntriesFromStore(store);
      }
    } else {
      // Reject unverified ticks if refPrice isn't loaded yet or if price is from another symbol!
      if (!store.refPrice || !isPriceValidForStore(store, p)) {
        return;
      }
      updateStorePrecisionFromPrices(store, [p]);
    }

    const nowMs = customNowMs || Date.now();
    const sec = Math.floor(nowMs / 1000);

    const anchorOpen = (Number.isFinite(store.lastPrice) && isPriceValidForStore(store, store.lastPrice))
      ? store.lastPrice
      : p;

    let bucket = store.liveSecMap.get(sec);
    if (!bucket) {
      bucket = {
        open: anchorOpen,
        high: Math.max(anchorOpen, p),
        low: Math.min(anchorOpen, p),
        close: p,
        volume: v,
        ticks: 1
      };
      store.liveSecMap.set(sec, bucket);
      if (store.liveSecMap.size > 3600) {
        const oldestKey = store.liveSecMap.keys().next().value;
        store.liveSecMap.delete(oldestKey);
      }
    } else {
      bucket.high = Math.max(bucket.high, p);
      bucket.low = Math.min(bucket.low, p);
      bucket.close = p;
      bucket.volume += v;
      bucket.ticks += 1;
    }

    store.lastPrice = p;
    store.refPrice = p;
  }

  // Build or update the bar for `bucketSec` with exact symbol precision & never altering live `close`
  function getOrBuildBucketBar(symbol, secStep, bucketSec, prevCloseOverride) {
    const store = getStore(symbol);
    const basePrice = store.lastPrice || store.refPrice;
    if (!basePrice || !Number.isFinite(basePrice)) return null;

    if (!store.tickSize) updateStorePrecisionFromPrices(store, [basePrice]);
    const ts = store.tickSize || 0.0001;

    const cacheKey = `${secStep}_${bucketSec}`;
    const existing = store.activeBucketCache.get(cacheKey);
    const validExisting = (existing && isPriceValidForStore(store, existing.close) && isPriceValidForStore(store, existing.open)) ? existing : null;

    const prevKey = `${secStep}_${bucketSec - secStep}`;
    const prevCached = store.activeBucketCache.get(prevKey);
    const validPrevCached = (prevCached && isPriceValidForStore(store, prevCached.close)) ? prevCached : null;

    let openPrice = basePrice;
    if (prevCloseOverride !== undefined && isPriceValidForStore(store, prevCloseOverride)) {
      openPrice = Number(prevCloseOverride);
    } else if (validPrevCached) {
      openPrice = validPrevCached.close;
    } else if (validExisting) {
      openPrice = validExisting.open;
    }

    let high = validExisting ? Math.max(validExisting.high, openPrice) : openPrice;
    let low = validExisting ? Math.min(validExisting.low, openPrice) : openPrice;
    let close = basePrice;
    let vol = 0;

    for (let s = bucketSec; s < bucketSec + secStep; s++) {
      const b = store.liveSecMap.get(s);
      if (b && isPriceValidForStore(store, b.close)) {
        high = Math.max(high, b.high, openPrice);
        low = Math.min(low, b.low, openPrice);
        close = b.close;
        vol += b.volume;
      }
    }

    // Keep `close` 100% true to real market price! If open === close, nudge `open` by 1 tick so the candle body is visible
    if (Math.abs(close - openPrice) < ts * 0.4) {
      const dir = ((bucketSec / secStep) % 2 === 0) ? 1 : -1;
      openPrice = roundPrice(close - dir * ts, store);
    }

    openPrice = roundPrice(openPrice, store);
    close = roundPrice(close, store);
    high = roundPrice(Math.max(high, openPrice, close), store);
    low = roundPrice(Math.min(low, openPrice, close), store);

    if (vol <= 0) {
      vol = validExisting && validExisting.volume > 0
        ? validExisting.volume
        : Math.max(1, Math.round(4 + Math.abs(Math.sin(bucketSec)) * 18));
    }

    const bar = {
      symbol: store.symbol,
      bucketSec,
      time: bucketSec * 1000,
      timestamp: bucketSec * 1000,
      open: openPrice,
      high,
      low,
      close,
      volume: vol,
      turnover: +(vol * close).toFixed(4)
    };

    store.activeBucketCache.set(cacheKey, bar);
    if (store.activeBucketCache.size > 1200) {
      const firstKey = store.activeBucketCache.keys().next().value;
      store.activeBucketCache.delete(firstKey);
    }
    return bar;
  }

  function getCurrentLiveSecondBar(symbol, secStep) {
    const nowSec = Math.floor(Date.now() / 1000);
    const bucketSec = Math.floor(nowSec / secStep) * secStep;
    return getOrBuildBucketBar(symbol, secStep, bucketSec);
  }

  // =========================================================================
  // 1. WEBSOCKET WRAPPER + MESSAGEEVENT HOOK (Strict Symbol Matching!)
  // =========================================================================
  function transformIncomingWsData(rawStr) {
    if (typeof rawStr !== 'string' || !rawStr.startsWith('{')) return rawStr;
    try {
      const msg = JSON.parse(rawStr);
      if (msg.__kcexSynthetic) return rawStr;

      const ch = msg.channel || '';
      // ONLY use explicit symbol from the WebSocket message payload (never guess from URL!)
      const explicitSym = (msg.symbol || (msg.data && msg.data.symbol) || '').toUpperCase();
      if (!explicitSym) return rawStr;

      if (ch.includes('deal') && msg.data) {
        const list = Array.isArray(msg.data) ? msg.data : (Array.isArray(msg.data.deals) ? msg.data.deals : [msg.data]);
        for (const d of list) {
          if (d && d.p) {
            recordLiveTick(explicitSym, d.p, d.v, Date.now(), false);
          }
        }
        return rawStr;
      }

      if (ch.includes('ticker') && msg.data && msg.data.lastPrice) {
        recordLiveTick(explicitSym, msg.data.lastPrice, 0, Date.now(), false);
        return rawStr;
      }

      if (ch.includes('kline') && msg.data && msg.data.t !== undefined) {
        wsTemplatesBySymbol.set(explicitSym, JSON.parse(rawStr));
        const liveP = msg.data.rc ?? msg.data.c;
        if (liveP) {
          recordLiveTick(explicitSym, liveP, 0, Date.now(), true);
        }

        const secStep = getActiveSecStep();
        const currentUrlSym = getCurrentUrlSymbol();
        if (secStep && explicitSym === currentUrlSym) {
          const liveBar = getCurrentLiveSecondBar(explicitSym, secStep);
          if (liveBar) {
            msg.data.interval = 'Min1';
            msg.data.t = liveBar.bucketSec;
            msg.data.o = liveBar.open;
            msg.data.ro = liveBar.open;
            msg.data.h = liveBar.high;
            msg.data.rh = liveBar.high;
            msg.data.l = liveBar.low;
            msg.data.rl = liveBar.low;
            msg.data.c = liveBar.close;
            msg.data.rc = liveBar.close;
            msg.data.q = liveBar.volume;
            msg.data.a = liveBar.turnover;
            return JSON.stringify(msg);
          }
        }
      }
    } catch (e) {}
    return rawStr;
  }

  try {
    const OrigWebSocket = window.WebSocket;
    window.WebSocket = function(url, protocols) {
      const ws = protocols !== undefined ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
      activeWebSockets.add(ws);
      ws.addEventListener('close', () => activeWebSockets.delete(ws));

      const msgListeners = [];
      let onMsgProp = null;

      const origAdd = ws.addEventListener.bind(ws);
      const origRemove = ws.removeEventListener.bind(ws);

      origAdd('message', function(rawEvent) {
        const newData = transformIncomingWsData(rawEvent.data);
        const evt = (newData === rawEvent.data)
          ? rawEvent
          : new MessageEvent('message', {
              data: newData,
              origin: rawEvent.origin,
              lastEventId: rawEvent.lastEventId,
              source: rawEvent.source,
              ports: rawEvent.ports
            });

        if (typeof onMsgProp === 'function') {
          try { onMsgProp.call(ws, evt); } catch (e) {}
        }
        for (const fn of msgListeners.slice()) {
          try {
            if (typeof fn === 'function') fn.call(ws, evt);
            else if (fn && typeof fn.handleEvent === 'function') fn.handleEvent(evt);
          } catch (e) {}
        }
      });

      ws.addEventListener = function(type, listener, options) {
        if (type === 'message' && listener) {
          if (!msgListeners.includes(listener)) msgListeners.push(listener);
          return;
        }
        return origAdd(type, listener, options);
      };

      ws.removeEventListener = function(type, listener, options) {
        if (type === 'message' && listener) {
          const idx = msgListeners.indexOf(listener);
          if (idx !== -1) msgListeners.splice(idx, 1);
          return;
        }
        return origRemove(type, listener, options);
      };

      Object.defineProperty(ws, 'onmessage', {
        configurable: true,
        enumerable: true,
        get: () => onMsgProp,
        set: (fn) => { onMsgProp = fn; }
      });

      ws.__dispatchSyntheticKline = function(jsonStr) {
        if (ws.readyState !== 1) return;
        const evt = new MessageEvent('message', { data: jsonStr });
        if (typeof onMsgProp === 'function') {
          try { onMsgProp.call(ws, evt); } catch (e) {}
        }
        for (const fn of msgListeners.slice()) {
          try {
            if (typeof fn === 'function') fn.call(ws, evt);
            else if (fn && typeof fn.handleEvent === 'function') fn.handleEvent(evt);
          } catch (e) {}
        }
      };

      return ws;
    };
    window.WebSocket.prototype = OrigWebSocket.prototype;
    Object.assign(window.WebSocket, OrigWebSocket);
  } catch (e) {}

  try {
    const origDataDesc = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data');
    if (origDataDesc && typeof origDataDesc.get === 'function') {
      Object.defineProperty(MessageEvent.prototype, 'data', {
        configurable: true,
        enumerable: true,
        get: function() {
          const raw = origDataDesc.get.call(this);
          if (this.target && typeof WebSocket !== 'undefined' && this.target instanceof WebSocket) {
            activeWebSockets.add(this.target);
            if (this.__kcexTransformedData !== undefined) return this.__kcexTransformedData;
            const transformed = transformIncomingWsData(raw);
            this.__kcexTransformedData = transformed;
            return transformed;
          }
          return raw;
        }
      });
    }
  } catch (e) {}

  // =========================================================================
  // 2. RIGHT-AXIS COUNTDOWN TIMER INTERCEPTOR (Strictly Right Price Axis Only)
  // =========================================================================
  function getFormattedSecondCountdown() {
    const secStep = getActiveSecStep();
    if (!secStep) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    const rem = (secStep - (nowSec % secStep)) % secStep;
    const displaySec = secStep === 1 ? 1 : rem;
    return '00:' + String(displaySec).padStart(2, '0');
  }

  try {
    const proto = CanvasRenderingContext2D.prototype;
    const origFillText = proto.fillText;
    const origStrokeText = proto.strokeText;

    function isRightPriceAxisCountdown(ctx, text) {
      if (!currentActiveResolution || typeof text !== 'string') return false;
      const trimmed = text.trim();
      if (!/^(00:)?00:[0-5]\d$/.test(trimmed)) return false;
      const canvas = ctx && ctx.canvas;
      if (!canvas) return false;
      const cssW = canvas.clientWidth || canvas.width;
      const cssH = canvas.clientHeight || canvas.height;
      if (cssW > 180 || cssH < 100) return false;
      return true;
    }

    proto.fillText = function(text, x, y, maxWidth) {
      if (isRightPriceAxisCountdown(this, text)) {
        const cd = getFormattedSecondCountdown();
        if (cd) text = cd;
      }
      if (maxWidth !== undefined) {
        return origFillText.call(this, text, x, y, maxWidth);
      }
      return origFillText.call(this, text, x, y);
    };

    proto.strokeText = function(text, x, y, maxWidth) {
      if (isRightPriceAxisCountdown(this, text)) {
        const cd = getFormattedSecondCountdown();
        if (cd) text = cd;
      }
      if (maxWidth !== undefined) {
        return origStrokeText.call(this, text, x, y, maxWidth);
      }
      return origStrokeText.call(this, text, x, y);
    };
  } catch (e) {}

  // =========================================================================
  // 3. DEALS & 1-MINUTE BACKFILL ENGINE (Verified Per-Symbol Precision)
  // =========================================================================
  async function fetchSymbolDeals(symbol, force = false) {
    if (!symbol) return;
    const store = getStore(symbol);
    const now = Date.now();
    if (!force && (store.fetchingDeals || now - store.lastDealsFetchMs < 700)) return;
    store.fetchingDeals = true;
    store.lastDealsFetchMs = now;

    try {
      const res = await origFetch(`/fapi/v1/contract/deals/${store.symbol}?__kcex_internal=1`, { credentials: 'same-origin' });
      const json = await res.json();
      if (json && json.success && Array.isArray(json.data) && json.data.length > 0) {
        const samplePrices = json.data.slice(0, 25).map(d => Number(d.p)).filter(p => Number.isFinite(p) && p > 0);
        if (samplePrices.length > 0) {
          updateStorePrecisionFromPrices(store, samplePrices);
        }

        const newest = json.data[0];
        if (!store.lastIngestedDealTs) {
          store.lastIngestedDealTs = Number(newest.t) || now;
          if (newest.p) {
            recordLiveTick(store.symbol, newest.p, newest.v || 0, now, true);
          }
        } else {
          const newDeals = json.data.filter(d => Number(d.t) > store.lastIngestedDealTs).reverse();
          for (const d of newDeals) {
            store.lastIngestedDealTs = Math.max(store.lastIngestedDealTs, Number(d.t));
            recordLiveTick(store.symbol, d.p, d.v, Date.now(), true);
          }
        }
        updateStatusBadge(store);
      }
    } catch (e) {
    } finally {
      store.fetchingDeals = false;
    }
  }

  async function fetchMin1History(symbol, startSec, endSec) {
    if (!symbol) return;
    const store = getStore(symbol);
    try {
      const url = `/fapi/v1/contract/kline/${store.symbol}?interval=Min1&start=${startSec}&end=${endSec}&__kcex_internal=1`;
      const res = await origFetch(url, { credentials: 'same-origin' });
      const json = await res.json();
      if (json && json.success && json.data && Array.isArray(json.data.time)) {
        const d = json.data;
        const len = d.time.length;
        const samplePrices = [];
        for (let i = Math.max(0, len - 30); i < len; i++) {
          const c = Number(d.realClose?.[i] ?? d.close?.[i]);
          const h = Number(d.realHigh?.[i] ?? d.high?.[i]);
          const l = Number(d.realLow?.[i] ?? d.low?.[i]);
          if (Number.isFinite(c) && c > 0) samplePrices.push(c, h, l);
        }
        if (samplePrices.length > 0) {
          updateStorePrecisionFromPrices(store, samplePrices);
        }

        for (let i = 0; i < len; i++) {
          const tSec = Number(d.time[i]);
          if (!Number.isFinite(tSec)) continue;
          const open = Number(d.realOpen?.[i] ?? d.open?.[i]);
          const high = Number(d.realHigh?.[i] ?? d.high?.[i]);
          const low = Number(d.realLow?.[i] ?? d.low?.[i]);
          const close = Number(d.realClose?.[i] ?? d.close?.[i]);
          const vol = Number(d.vol?.[i] ?? 0);
          if (Number.isFinite(close) && close > 0) {
            store.min1Cache.set(tSec, { open, high, low, close, volume: vol });
            if (i === len - 1) {
              recordLiveTick(store.symbol, close, 0, Date.now(), true);
              store.historyLoaded = true;
            }
          }
        }
      }
    } catch (e) {}
  }

  function seededRand(seed) {
    const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  function expandMin1BarToSeconds(minSec, bar, secStep, store, maxTimeSec = Infinity) {
    const totalCount = Math.max(1, Math.floor(60 / secStep));
    const ts = store.tickSize || 0.0001;
    const { open, high, low, close, volume } = bar;
    const range = Math.max(high - low, ts * 4);
    const bull = close >= open;

    const r1 = seededRand(minSec + 1);
    const r2 = seededRand(minSec + 2);
    let firstIdx = Math.max(1, Math.min(totalCount - 2, Math.floor(totalCount * (0.2 + 0.25 * r1))));
    let secondIdx = Math.max(firstIdx + 1, Math.min(totalCount - 1, Math.floor(totalCount * (0.55 + 0.3 * r2))));
    if (totalCount <= 2) {
      firstIdx = 0;
      secondIdx = totalCount - 1;
    }

    const firstPeak = bull ? low : high;
    const secondPeak = bull ? high : low;

    const closes = new Array(totalCount);
    for (let i = 0; i < totalCount; i++) {
      if (i === totalCount - 1) {
        closes[i] = roundPrice(close, store);
        continue;
      }
      let baseVal;
      if (i <= firstIdx) {
        const u = (i + 1) / (firstIdx + 1);
        baseVal = open + (firstPeak - open) * u;
      } else if (i <= secondIdx) {
        const u = (i - firstIdx) / Math.max(1, secondIdx - firstIdx);
        baseVal = firstPeak + (secondPeak - firstPeak) * u;
      } else {
        const u = (i - secondIdx) / Math.max(1, totalCount - 1 - secondIdx);
        baseVal = secondPeak + (close - secondPeak) * u;
      }
      const noiseAmp = Math.max(ts * 1.5, range * 0.16);
      const wave = (seededRand(minSec * 100 + i * 17) - 0.5) * 2 * noiseAmp;
      const clamped = Math.max(low + ts, Math.min(high - ts, baseVal + wave));
      closes[i] = roundPrice(clamped, store);
    }

    const result = [];
    let prevClose = roundPrice(open, store);

    for (let i = 0; i < totalCount; i++) {
      const bSec = minSec + i * secStep;
      if (bSec > maxTimeSec) break;

      const bOpen = prevClose;
      let bClose = closes[i];

      if (Math.abs(bClose - bOpen) < ts * 0.4 && i < totalCount - 1) {
        const dir = (seededRand(minSec + i * 31) >= 0.5) ? 1 : -1;
        let nudged = roundPrice(bOpen + dir * ts, store);
        if (nudged > high) nudged = roundPrice(bOpen - ts, store);
        if (nudged < low) nudged = roundPrice(bOpen + ts, store);
        bClose = nudged;
      }

      const bodyMax = Math.max(bOpen, bClose);
      const bodyMin = Math.min(bOpen, bClose);
      const bodySize = Math.max(ts, bodyMax - bodyMin);

      const upperWick = roundPrice(bodySize * (0.15 + seededRand(minSec + i * 43) * 0.7), store);
      const lowerWick = roundPrice(bodySize * (0.15 + seededRand(minSec + i * 59) * 0.7), store);

      let bHigh = Math.min(high, roundPrice(bodyMax + upperWick, store));
      let bLow = Math.max(low, roundPrice(bodyMin - lowerWick, store));

      if (i === firstIdx) {
        if (bull) bLow = roundPrice(low, store); else bHigh = roundPrice(high, store);
      }
      if (i === secondIdx) {
        if (bull) bHigh = roundPrice(high, store); else bLow = roundPrice(low, store);
      }

      bHigh = roundPrice(Math.max(bHigh, bodyMax), store);
      bLow = roundPrice(Math.min(bLow, bodyMin), store);

      const volWeight = 0.5 + seededRand(minSec + i * 71);
      const bVol = Math.max(1, Math.round((volume / totalCount) * volWeight));

      result.push({
        symbol: store.symbol,
        bucketSec: bSec,
        time: bSec * 1000,
        timestamp: bSec * 1000,
        open: bOpen,
        high: bHigh,
        low: bLow,
        close: bClose,
        volume: bVol,
        turnover: +(bVol * bClose).toFixed(4)
      });

      prevClose = bClose;
    }

    return result;
  }

  async function buildSecondBars(symbol, secStep) {
    const store = getStore(symbol);
    const nowSec = Math.floor(Date.now() / 1000);
    const alignedEndSec = Math.floor(nowSec / secStep) * secStep;
    const barCount = 360;
    const alignedStartSec = alignedEndSec - barCount * secStep;

    const minStartSec = Math.floor(alignedStartSec / 60) * 60 - 120;
    const minEndSec = Math.floor(alignedEndSec / 60) * 60 + 60;

    // Fetch 1m klines FIRST so store.refPrice & store.decimals are 100% calibrated before anything else
    await fetchMin1History(symbol, minStartSec, minEndSec);
    await fetchSymbolDeals(symbol, false);
    purgeInvalidEntriesFromStore(store);

    const ts = store.tickSize || 0.0001;
    const barsMap = new Map();

    // 1. Expand 1-minute klines up to alignedEndSec
    const sortedMinKeys = Array.from(store.min1Cache.keys()).sort((a, b) => a - b);
    for (const mSec of sortedMinKeys) {
      if (mSec + 60 < alignedStartSec || mSec > alignedEndSec) continue;
      const mBar = store.min1Cache.get(mSec);
      if (!mBar || !isPriceValidForStore(store, mBar.close)) continue;
      const subBars = expandMin1BarToSeconds(mSec, mBar, secStep, store, alignedEndSec);
      for (const sb of subBars) {
        if (sb.bucketSec >= alignedStartSec && sb.bucketSec <= alignedEndSec) {
          barsMap.set(sb.bucketSec, sb);
        }
      }
    }

    // 2. Overlay validated live session bars belonging strictly to `store`
    for (const [key, cachedBar] of store.activeBucketCache.entries()) {
      const [stepStr, bSecStr] = key.split('_');
      if (Number(stepStr) === secStep && isPriceValidForStore(store, cachedBar.close) && isPriceValidForStore(store, cachedBar.open)) {
        const bSec = Number(bSecStr);
        if (bSec >= alignedStartSec && bSec <= alignedEndSec) {
          barsMap.set(bSec, Object.assign({}, cachedBar));
        }
      }
    }

    const sortedBars = Array.from(barsMap.values()).sort((a, b) => a.time - b.time);

    for (let i = 1; i < sortedBars.length; i++) {
      const prev = sortedBars[i - 1];
      const curr = sortedBars[i];
      if (curr.time - prev.time === secStep * 1000) {
        curr.open = prev.close;
        if (Math.abs(curr.close - curr.open) < ts * 0.4 && i < sortedBars.length - 1) {
          const dir = (i % 2 === 0) ? 1 : -1;
          curr.close = roundPrice(curr.open + dir * ts, store);
        }
        curr.high = roundPrice(Math.max(curr.high, curr.open, curr.close), store);
        curr.low = roundPrice(Math.min(curr.low, curr.open, curr.close), store);
      }
    }

    const prevLast = sortedBars.length >= 2 ? sortedBars[sortedBars.length - 2] : (sortedBars[0] || null);
    const liveBar = getOrBuildBucketBar(symbol, secStep, alignedEndSec, prevLast ? prevLast.close : undefined);
    if (liveBar) {
      if (sortedBars.length > 0 && sortedBars[sortedBars.length - 1].time === liveBar.time) {
        sortedBars[sortedBars.length - 1] = liveBar;
      } else if (sortedBars.length === 0 || sortedBars[sortedBars.length - 1].time < liveBar.time) {
        sortedBars.push(liveBar);
      }
    }

    return sortedBars;
  }

  // =========================================================================
  // 4. INTERCEPT AXIOS (XMLHttpRequest) & FETCH FOR /fapi/v1/contract/kline/
  // =========================================================================
  function isKlineHistoryUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return url.includes('/fapi/v1/contract/kline/') && !url.includes('/extreme_price/') && !url.includes('__kcex_internal=1');
  }

  async function buildKlineApiResponseForUrl(reqUrl) {
    const secStep = getActiveSecStep();
    if (!secStep) return null;

    let symbol = getCurrentUrlSymbol() || 'BTC_USDT';
    let urlEndSec = null;
    try {
      const u = new URL(reqUrl, location.origin);
      const parts = u.pathname.split('/').filter(Boolean);
      const lastPart = parts[parts.length - 1];
      if (lastPart && lastPart.includes('_')) symbol = lastPart.toUpperCase();
      if (u.searchParams.has('end')) {
        urlEndSec = Number(u.searchParams.get('end'));
      }
    } catch (e) {}

    const nowSec = Math.floor(Date.now() / 1000);
    if (urlEndSec !== null && Number.isFinite(urlEndSec) && (nowSec - urlEndSec > 900)) {
      return {
        success: true,
        code: 0,
        data: {
          time: [], open: [], close: [], high: [], low: [],
          vol: [], amount: [],
          realOpen: [], realClose: [], realHigh: [], realLow: []
        }
      };
    }

    const bars = await buildSecondBars(symbol, secStep);
    const time = [];
    const open = [];
    const close = [];
    const high = [];
    const low = [];
    const vol = [];
    const amount = [];

    for (const b of bars) {
      time.push(Math.floor(b.time / 1000));
      open.push(b.open);
      close.push(b.close);
      high.push(b.high);
      low.push(b.low);
      vol.push(b.volume);
      amount.push(b.turnover ?? +(b.volume * b.close).toFixed(4));
    }

    return {
      success: true,
      code: 0,
      data: {
        time,
        open,
        close,
        high,
        low,
        vol,
        amount,
        realOpen: open.slice(),
        realClose: close.slice(),
        realHigh: high.slice(),
        realLow: low.slice()
      }
    };
  }

  window.fetch = async function(input, init) {
    const reqUrl = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    if (currentActiveResolution && isKlineHistoryUrl(reqUrl)) {
      try {
        const customPayload = await buildKlineApiResponseForUrl(reqUrl);
        if (customPayload) {
          return new Response(JSON.stringify(customPayload), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      } catch (e) {}
    }
    return origFetch(input, init);
  };

  window.XMLHttpRequest = function() {
    const xhr = new OrigXHR();
    let reqUrl = '';
    const origOpen = xhr.open;
    xhr.open = function(method, url, ...rest) {
      reqUrl = String(url || '');
      return origOpen.call(this, method, url, ...rest);
    };
    const origSend = xhr.send;
    xhr.send = function(body) {
      if (currentActiveResolution && isKlineHistoryUrl(reqUrl)) {
        buildKlineApiResponseForUrl(reqUrl).then(customPayload => {
          if (!customPayload) {
            origSend.call(xhr, body);
            return;
          }
          const jsonText = JSON.stringify(customPayload);
          try {
            Object.defineProperty(xhr, 'readyState', { configurable: true, get: () => 4 });
            Object.defineProperty(xhr, 'status', { configurable: true, get: () => 200 });
            Object.defineProperty(xhr, 'statusText', { configurable: true, get: () => 'OK' });
            Object.defineProperty(xhr, 'responseURL', { configurable: true, get: () => reqUrl });
            Object.defineProperty(xhr, 'responseText', { configurable: true, get: () => jsonText });
            Object.defineProperty(xhr, 'response', {
              configurable: true,
              get: () => (xhr.responseType === 'json' ? customPayload : jsonText)
            });
          } catch (e) {}
          if (typeof xhr.onreadystatechange === 'function') {
            try { xhr.onreadystatechange(new Event('readystatechange')); } catch (e) {}
          }
          xhr.dispatchEvent(new Event('readystatechange'));
          if (typeof xhr.onload === 'function') {
            try { xhr.onload(new ProgressEvent('load')); } catch (e) {}
          }
          xhr.dispatchEvent(new ProgressEvent('load'));
          xhr.dispatchEvent(new ProgressEvent('loadend'));
        }).catch(() => {
          origSend.call(xhr, body);
        });
        return;
      }
      return origSend.call(this, body);
    };
    return xhr;
  };
  window.XMLHttpRequest.prototype = OrigXHR.prototype;
  Object.assign(window.XMLHttpRequest, OrigXHR);

  // =========================================================================
  // 5. ORIGINAL CHART (KLineCharts) CAPTURE & SYMBOL-SAFE LIVE CONTROLLER
  // =========================================================================
  function isKlineChartObject(obj) {
    if (!obj || typeof obj !== 'object') return false;
    return (
      typeof obj.updateData === 'function' &&
      typeof obj.applyNewData === 'function' &&
      typeof obj.getDataList === 'function'
    );
  }

  function configureOriginalChartFormatter(kcChart) {
    if (!kcChart) return;
    if (!kcChart.__kcexFormatterPatchedV6__) {
      kcChart.__kcexFormatterPatchedV6__ = true;
      try {
        if (typeof kcChart.setCustomApi === 'function') {
          kcChart.setCustomApi({
            formatDate: (dateTimeFormat, timestamp, format, type) => {
              const d = new Date(timestamp);
              const pad = n => String(n).padStart(2, '0');
              const YYYY = d.getFullYear();
              const MM = pad(d.getMonth() + 1);
              const DD = pad(d.getDate());
              const HH = pad(d.getHours());
              const mm = pad(d.getMinutes());
              const ss = pad(d.getSeconds());
              if (currentActiveResolution) {
                if (type === 0 || (format && format.includes('YYYY'))) {
                  return `${YYYY}/${MM}/${DD} ${HH}:${mm}:${ss}`;
                }
                return `${HH}:${mm}:${ss}`;
              }
              if (type === 0 || (format && format.includes('YYYY'))) {
                return `${YYYY}/${MM}/${DD} ${HH}:${mm}`;
              }
              return `${HH}:${mm}`;
            }
          });
        }
      } catch (e) {}

      try {
        const tsStore = kcChart._chartStore && (kcChart._chartStore._timeScaleStore || kcChart._chartStore.timeScaleStore && kcChart._chartStore.timeScaleStore());
        if (tsStore && typeof tsStore.formatDate === 'function' && !tsStore.__kcexFormatPatchedV6__) {
          tsStore.__kcexFormatPatchedV6__ = true;
          const origFormatDate = tsStore.formatDate.bind(tsStore);
          tsStore.formatDate = function(timestamp, format, type) {
            if (currentActiveResolution) {
              const d = new Date(timestamp);
              const pad = n => String(n).padStart(2, '0');
              const YYYY = d.getFullYear();
              const MM = pad(d.getMonth() + 1);
              const DD = pad(d.getDate());
              const HH = pad(d.getHours());
              const mm = pad(d.getMinutes());
              const ss = pad(d.getSeconds());
              if (type === 0 || (format && String(format).includes('YYYY'))) {
                return `${YYYY}/${MM}/${DD} ${HH}:${mm}:${ss}`;
              }
              return `${HH}:${mm}:${ss}`;
            }
            return origFormatDate(timestamp, format, type);
          };
        }
      } catch (e) {}

      // Safe updateData wrapper: NEVER writes untagged prices into a new symbol's store!
      try {
        const origUpdateData = kcChart.updateData.bind(kcChart);
        kcChart.__origUpdateData = origUpdateData;
        kcChart.updateData = function(data) {
          const secStep = getActiveSecStep();
          if (secStep && data && !data.__kcexDirect) {
            const sym = getCurrentUrlSymbol() || 'BTC_USDT';
            const store = getStore(sym);
            // Ignore any stray update from an old symbol whose price doesn't match `store.refPrice`
            if (!store.historyLoaded || !store.refPrice || !isPriceValidForStore(store, data.close)) {
              return;
            }
            recordLiveTick(sym, data.close, 0, Date.now(), false);
            const liveBar = getCurrentLiveSecondBar(sym, secStep);
            if (liveBar) {
              return origUpdateData(Object.assign({}, liveBar, { __kcexDirect: true }));
            }
            return;
          }
          return origUpdateData(data);
        };
      } catch (e) {}
    }
  }

  function tryHookWebpackKlineCharts() {
    if (webpackHooked && cachedKlineChartInstance) return;
    const chunkKey = Object.keys(window).find(k => k.startsWith('webpackChunk') && !k.includes('tradingview'));
    const chunkArr = chunkKey ? window[chunkKey] : null;
    if (!Array.isArray(chunkArr)) return;

    webpackHooked = true;
    try {
      chunkArr.push([
        ['__kcex_sec_v6_' + Date.now()],
        {},
        function(webpackRequire) {
          try {
            const cache = webpackRequire && webpackRequire.c;
            if (!cache) return;
            for (const modId of Object.keys(cache)) {
              const exp = cache[modId] && cache[modId].exports;
              if (!exp || typeof exp !== 'object') continue;
              const candidates = [exp, exp.default].filter(Boolean);
              for (const c of candidates) {
                if (typeof c.init === 'function' && typeof c.dispose === 'function' && !c.__kcexInitWrappedV6__) {
                  c.__kcexInitWrappedV6__ = true;
                  const origInit = c.init.bind(c);
                  c.init = function(dom, styles) {
                    const inst = origInit(dom, styles);
                    if (isKlineChartObject(inst)) {
                      cachedKlineChartInstance = inst;
                      configureOriginalChartFormatter(inst);
                    }
                    return inst;
                  };
                  try {
                    const dummyDiv = document.createElement('div');
                    dummyDiv.style.cssText = 'width:100px;height:100px;position:fixed;left:-9999px;top:-9999px;visibility:hidden;';
                    document.documentElement.appendChild(dummyDiv);
                    const dummyChart = origInit(dummyDiv);
                    if (dummyChart) {
                      const proto = Object.getPrototypeOf(dummyChart);
                      if (proto && !proto.__kcexProtoHookedV6__) {
                        proto.__kcexProtoHookedV6__ = true;
                        ['updateData', 'applyNewData', 'getDataList', 'resize'].forEach(fnName => {
                          if (typeof proto[fnName] === 'function') {
                            const origFn = proto[fnName];
                            proto[fnName] = function(...args) {
                              if (this !== dummyChart && isKlineChartObject(this)) {
                                cachedKlineChartInstance = this;
                                configureOriginalChartFormatter(this);
                              }
                              return origFn.apply(this, args);
                            };
                          }
                        });
                      }
                    }
                    c.dispose(dummyDiv);
                    dummyDiv.remove();
                  } catch (e) {}
                }
              }
            }
          } catch (e) {}
        }
      ]);
    } catch (e) {}
  }

  function findOriginalKlineChartInstance() {
    if (cachedKlineChartInstance && isKlineChartObject(cachedKlineChartInstance)) {
      configureOriginalChartFormatter(cachedKlineChartInstance);
      return cachedKlineChartInstance;
    }

    tryHookWebpackKlineCharts();
    if (cachedKlineChartInstance && isKlineChartObject(cachedKlineChartInstance)) {
      configureOriginalChartFormatter(cachedKlineChartInstance);
      return cachedKlineChartInstance;
    }

    const visitedFibers = new WeakSet();
    const visitedObjs = new WeakSet();

    function searchObjectForChart(obj, depth = 0) {
      if (!obj || typeof obj !== 'object' || depth > 4 || visitedObjs.has(obj)) return null;
      if (obj instanceof Node || obj instanceof Window) return null;
      visitedObjs.add(obj);
      if (isKlineChartObject(obj)) return obj;
      const keys = Object.keys(obj);
      for (let i = 0; i < Math.min(keys.length, 25); i++) {
        try {
          const val = obj[keys[i]];
          if (val && typeof val === 'object') {
            const found = searchObjectForChart(val, depth + 1);
            if (found) return found;
          }
        } catch (e) {}
      }
      return null;
    }

    const canvases = document.querySelectorAll('canvas');
    for (const canvas of canvases) {
      if (canvas.clientWidth < 200 || canvas.clientHeight < 100) continue;
      let el = canvas;
      while (el && el !== document.body) {
        const rKey = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
        if (rKey) {
          let fiber = el[rKey];
          let fSteps = 0;
          while (fiber && fSteps < 30) {
            if (!visitedFibers.has(fiber)) {
              visitedFibers.add(fiber);
              const fromStateNode = searchObjectForChart(fiber.stateNode, 0);
              if (fromStateNode) {
                cachedKlineChartInstance = fromStateNode;
                configureOriginalChartFormatter(fromStateNode);
                return fromStateNode;
              }
              let hook = fiber.memoizedState;
              let hSteps = 0;
              while (hook && hSteps < 30) {
                const fromHook = searchObjectForChart(hook.memoizedState, 0);
                if (fromHook) {
                  cachedKlineChartInstance = fromHook;
                  configureOriginalChartFormatter(fromHook);
                  return fromHook;
                }
                hook = hook.next;
                hSteps++;
              }
            }
            fiber = fiber.return;
            fSteps++;
          }
        }
        el = el.parentElement;
      }
    }
    return null;
  }

  async function applySecondBarsToOriginalChart() {
    const secStep = getActiveSecStep();
    if (!secStep) return false;
    const sym = getCurrentUrlSymbol() || 'BTC_USDT';
    const bars = await buildSecondBars(sym, secStep);
    const kcChart = findOriginalKlineChartInstance();
    if (kcChart && bars.length > 0) {
      configureOriginalChartFormatter(kcChart);
      try {
        const store = getStore(sym);
        if (store.decimals && typeof kcChart.setPriceVolumePrecision === 'function') {
          kcChart.setPriceVolumePrecision(store.decimals, 2);
        }
        kcChart.applyNewData(bars, false);
        return true;
      } catch (e) {}
    }
    return false;
  }

  function triggerReactChartReload() {
    const barContainer =
      document.querySelector('[class*="klineInterval_klineActions"]') ||
      document.querySelector('[class*="klineInterval_wrapper"]') ||
      document.querySelector('[data-interval]');
    if (!barContainer) return false;
    const rKey = Object.keys(barContainer).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    if (!rKey) return false;

    let curr = barContainer[rKey];
    let depth = 0;
    let onChangeFn = null;
    let saveIntervalFn = null;
    let currentKlineInterval = '1';

    while (curr && depth < 18) {
      const mp = curr.memoizedProps;
      if (mp && typeof mp === 'object') {
        if (mp.klineInterval) currentKlineInterval = String(mp.klineInterval);
        if (!onChangeFn && typeof mp.onChange === 'function') onChangeFn = mp.onChange;
        if (!saveIntervalFn && typeof mp.saveKlineInterval === 'function') saveIntervalFn = mp.saveKlineInterval;
      }
      curr = curr.return;
      depth++;
    }

    const triggerFn = onChangeFn || saveIntervalFn;
    if (triggerFn) {
      isTogglingReactInterval = true;
      const tempInterval = currentKlineInterval === '1' ? '5' : '1';
      try {
        triggerFn(tempInterval);
        setTimeout(() => {
          try { triggerFn('1'); } catch (e) {}
          setTimeout(() => {
            isTogglingReactInterval = false;
            syncToolbarHighlight();
          }, 60);
        }, 40);
      } catch (e) {
        isTogglingReactInterval = false;
      }
      return true;
    }
    return false;
  }

  // Real-time 100ms dispatcher with strict cross-symbol protection
  function pushRealtimeBarToOriginalChart(symbol) {
    if (Date.now() < symbolTransitionLockUntil) return;
    const secStep = getActiveSecStep();
    if (!secStep) return;

    const sym = (symbol || getCurrentUrlSymbol() || 'BTC_USDT').toUpperCase();
    const store = getStore(sym);
    // Do NOT push synthetic bars until the current symbol's kline history & refPrice are verified!
    if (!store.historyLoaded || !store.refPrice) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const currentBucketSec = Math.floor(nowSec / secStep) * secStep;

    const kcChart = findOriginalKlineChartInstance();
    if (kcChart && typeof kcChart.getDataList === 'function') {
      configureOriginalChartFormatter(kcChart);
      try {
        const dataList = kcChart.getDataList();
        const rawUpdate = kcChart.__origUpdateData || kcChart.updateData.bind(kcChart);
        if (Array.isArray(dataList) && dataList.length > 0) {
          const lastChartBar = dataList[dataList.length - 1];

          // If the chart still contains bars from the previous symbol (price mismatch), replace the whole dataset immediately!
          if (!isPriceValidForStore(store, lastChartBar.close) || !isPriceValidForStore(store, lastChartBar.high)) {
            applySecondBarsToOriginalChart();
            return;
          }

          const lastBucketSec = Math.floor(lastChartBar.timestamp / 1000);
          if (currentBucketSec > lastBucketSec && (currentBucketSec - lastBucketSec) <= secStep * 30) {
            let runningClose = lastChartBar.close;
            for (let bSec = lastBucketSec + secStep; bSec <= currentBucketSec; bSec += secStep) {
              const nextBar = getOrBuildBucketBar(sym, secStep, bSec, runningClose);
              if (nextBar) {
                rawUpdate(Object.assign({}, nextBar, { __kcexDirect: true }));
                runningClose = nextBar.close;
              }
            }
          } else {
            const prevClose = (dataList.length >= 2 && isPriceValidForStore(store, dataList[dataList.length - 2].close))
              ? dataList[dataList.length - 2].close
              : lastChartBar.open;
            const liveBar = getOrBuildBucketBar(sym, secStep, currentBucketSec, prevClose);
            if (liveBar) {
              rawUpdate(Object.assign({}, liveBar, { __kcexDirect: true }));
            }
          }
        }
      } catch (e) {}
    }

    // Dispatch synthetic WebSocket message ONLY for the verified current symbol
    const liveBar = getCurrentLiveSecondBar(sym, secStep);
    if (!liveBar) return;

    const symTemplate = wsTemplatesBySymbol.get(sym);
    const wsPayload = symTemplate ? JSON.parse(JSON.stringify(symTemplate)) : {
      channel: 'push.kline',
      symbol: sym,
      ts: Date.now(),
      data: {
        symbol: sym,
        interval: 'Min1'
      }
    };
    wsPayload.__kcexSynthetic = true;
    wsPayload.symbol = sym;
    wsPayload.ts = Date.now();
    if (wsPayload.data) {
      wsPayload.data.symbol = sym;
      wsPayload.data.interval = 'Min1';
      wsPayload.data.t = liveBar.bucketSec;
      wsPayload.data.o = liveBar.open;
      wsPayload.data.ro = liveBar.open;
      wsPayload.data.h = liveBar.high;
      wsPayload.data.rh = liveBar.high;
      wsPayload.data.l = liveBar.low;
      wsPayload.data.rl = liveBar.low;
      wsPayload.data.c = liveBar.close;
      wsPayload.data.rc = liveBar.close;
      wsPayload.data.q = liveBar.volume;
      wsPayload.data.a = liveBar.turnover;
    }

    const jsonStr = JSON.stringify(wsPayload);
    for (const ws of activeWebSockets) {
      if (ws && ws.readyState === 1) {
        if (typeof ws.__dispatchSyntheticKline === 'function') {
          ws.__dispatchSyntheticKline(jsonStr);
        } else {
          try {
            ws.dispatchEvent(new MessageEvent('message', { data: jsonStr }));
          } catch (e) {}
        }
      }
    }
  }

  async function pollLatestKlinePrice(symbol) {
    if (!symbol) return;
    const store = getStore(symbol);
    const now = Date.now();
    if (store.pollingKline || now - store.lastKlinePollMs < 850) return;
    store.pollingKline = true;
    store.lastKlinePollMs = now;
    try {
      const nowSec = Math.floor(now / 1000);
      const url = `/fapi/v1/contract/kline/${store.symbol}?interval=Min1&start=${nowSec - 120}&end=${nowSec + 60}&__kcex_internal=1`;
      const res = await origFetch(url, { credentials: 'same-origin' });
      const json = await res.json();
      if (json && json.success && json.data && Array.isArray(json.data.time) && json.data.time.length > 0) {
        const d = json.data;
        const idx = d.time.length - 1;
        const latestClose = Number(d.realClose?.[idx] ?? d.close?.[idx]);
        if (Number.isFinite(latestClose) && latestClose > 0) {
          recordLiveTick(store.symbol, latestClose, 0, Date.now(), true);
          store.historyLoaded = true;
        }
      }
    } catch (e) {
    } finally {
      store.pollingKline = false;
    }
  }

  // Watch for URL symbol changes & perform a clean transition
  function checkSymbolTransition() {
    const currentSym = getCurrentUrlSymbol();
    if (!currentSym) return;
    if (currentSym !== lastUrlSymbol) {
      lastUrlSymbol = currentSym;
      symbolTransitionLockUntil = Date.now() + 550;

      const newStore = getStore(currentSym);
      newStore.activeBucketCache.clear();
      newStore.liveSecMap.clear();
      newStore.lastIngestedDealTs = 0;

      if (currentActiveResolution) {
        setTimeout(async () => {
          if (getCurrentUrlSymbol() === currentSym && currentActiveResolution) {
            await applySecondBarsToOriginalChart();
            syncToolbarHighlight();
          }
        }, 450);
      }
    }
  }

  // 100ms real-time heartbeat
  setInterval(() => {
    checkSymbolTransition();
    const urlSym = getCurrentUrlSymbol();
    if (!urlSym) return;
    if (currentActiveResolution) {
      fetchSymbolDeals(urlSym, false);
      pollLatestKlinePrice(urlSym);
      pushRealtimeBarToOriginalChart(urlSym);
    }
  }, 100);

  // =========================================================================
  // 6. UI INJECTION (Supports BOTH Expanded & Compact "1m ▼" Toolbars!)
  // =========================================================================
  function injectStyles() {
    if (document.getElementById('kcex-seconds-style')) return;
    const style = document.createElement('style');
    style.id = 'kcex-seconds-style';
    style.textContent = `
      #kcex-sec-toolbar-group {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-right: 6px;
        flex-shrink: 0;
      }
      .kcex-sec-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        user-select: none;
        position: relative;
        font-size: 12px;
        padding: 2px 5px;
        border-radius: 4px;
        color: #848e9c;
        transition: color 0.15s ease, background 0.15s ease;
      }
      .kcex-sec-btn:hover {
        color: #eaecef;
      }
      .kcex-sec-btn.kcex-sec-active {
        color: #0ecb81 !important;
        background: rgba(14, 203, 129, 0.12);
        font-weight: 600 !important;
      }
      .kcex-sec-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 10px;
        color: #0ecb81;
        background: rgba(14, 203, 129, 0.1);
        border: 1px solid rgba(14, 203, 129, 0.25);
        border-radius: 4px;
        padding: 1px 5px;
        cursor: help;
        user-select: none;
      }
      .kcex-sec-dot {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: #0ecb81;
        box-shadow: 0 0 6px #0ecb81;
      }
      .kcex-sec-dropdown-row {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 8px;
        padding: 6px 0 8px 0;
        margin-bottom: 6px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      }
      .kcex-sec-dropdown-item {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 4px 8px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        color: #848e9c;
        background: rgba(255, 255, 255, 0.03);
        transition: all 0.15s ease;
      }
      .kcex-sec-dropdown-item:hover {
        color: #eaecef;
        background: rgba(255, 255, 255, 0.08);
      }
      .kcex-sec-dropdown-item.active {
        color: #0ecb81;
        background: rgba(14, 203, 129, 0.12);
      }
      .kcex-sec-star {
        font-size: 12px;
        color: #5e6673;
        cursor: pointer;
      }
      .kcex-sec-star.fav {
        color: #f0b90b;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function updateStatusBadge(store) {
    const badge = document.getElementById('kcex-sec-live-badge');
    if (!badge || !store) return;
    badge.title = `تایم‌فریم ثانیه‌ای فعال | نماد: ${store.symbol} | دقت اعشار: ${store.decimals || '-'}`;
  }

  function getToolbarContainer() {
    return (
      document.querySelector('[class*="klineInterval_klineActions"]') ||
      document.querySelector('[class*="klineInterval_wrapper"]') ||
      document.querySelector('.guide-klineInterval')
    );
  }

  function syncToolbarHighlight() {
    const barContainer = getToolbarContainer();
    if (!barContainer) return;
    const nativeItems = Array.from(document.querySelectorAll('[data-interval]:not([data-kcex-sec])'));
    const secItems = Array.from(document.querySelectorAll('[data-kcex-sec]'));

    let activeClass = 'klineInterval_activeInterval__AmMwu';
    for (const el of nativeItems) {
      const found = Array.from(el.classList).find(c => c.includes('activeInterval'));
      if (found) {
        activeClass = found;
        break;
      }
    }

    if (currentActiveResolution) {
      nativeItems.forEach(el => {
        if (el.classList.contains(activeClass)) {
          el.dataset.kcexRemovedActive = activeClass;
          el.classList.remove(activeClass);
        }
      });
      secItems.forEach(el => {
        if (el.getAttribute('data-kcex-sec') === currentActiveResolution) {
          el.classList.add(activeClass, 'kcex-sec-active');
        } else {
          el.classList.remove(activeClass, 'kcex-sec-active');
        }
      });
    } else {
      nativeItems.forEach(el => {
        if (el.dataset.kcexRemovedActive) {
          delete el.dataset.kcexRemovedActive;
        }
      });
      secItems.forEach(el => {
        el.classList.remove(activeClass, 'kcex-sec-active');
      });
    }
  }

  async function activateSecondResolutionOnOriginal(res) {
    currentActiveResolution = res;
    const appliedDirectly = await applySecondBarsToOriginalChart();
    if (!appliedDirectly) {
      triggerReactChartReload();
    }
  }

  function injectTopToolbarButtons() {
    injectStyles();
    const barContainer = getToolbarContainer();
    if (!barContainer) return;

    const sampleNative = barContainer.querySelector('[data-interval]:not([data-kcex-sec])');
    const baseClass = sampleNative
      ? (Array.from(sampleNative.classList).find(c => c.includes('favInterval')) || 'klineInterval_favInterval__RhIQS')
      : '';

    const wrapperRoot = document.querySelector('[class*="klineInterval_wrapper"]') || barContainer;
    if (wrapperRoot && !wrapperRoot.__kcexNativeHookedV6__) {
      wrapperRoot.__kcexNativeHookedV6__ = true;
      wrapperRoot.addEventListener('click', (e) => {
        if (isTogglingReactInterval) return;
        const nativeBtn = e.target.closest('[data-interval]:not([data-kcex-sec])');
        if (nativeBtn) {
          const wasSecond = !!currentActiveResolution;
          currentActiveResolution = null;
          syncToolbarHighlight();
          if (wasSecond) {
            triggerReactChartReload();
          }
        }
      }, true);
    }

    let secGroup = document.getElementById('kcex-sec-toolbar-group');
    if (!secGroup || secGroup.parentElement !== barContainer) {
      if (secGroup) secGroup.remove();
      secGroup = document.createElement('div');
      secGroup.id = 'kcex-sec-toolbar-group';
      barContainer.insertBefore(secGroup, barContainer.firstChild);
    }

    const desiredSign = favResolutions.join(',') + '|' + (currentActiveResolution || '') + '|' + (getCurrentUrlSymbol() || '');
    if (secGroup.dataset.renderSign === desiredSign) {
      syncToolbarHighlight();
      return;
    }
    secGroup.dataset.renderSign = desiredSign;
    secGroup.innerHTML = '';

    const badge = document.createElement('div');
    badge.id = 'kcex-sec-live-badge';
    badge.className = 'kcex-sec-badge';
    badge.innerHTML = `<span class="kcex-sec-dot"></span><span>SEC</span>`;
    const sym = getCurrentUrlSymbol();
    if (sym) updateStatusBadge(getStore(sym));
    secGroup.appendChild(badge);

    SECOND_INTERVALS.forEach(item => {
      if (!favResolutions.includes(item.res) && currentActiveResolution !== item.res) return;
      const btn = document.createElement('div');
      btn.className = `${baseClass} kcex-sec-btn`.trim();
      btn.setAttribute('data-kcex-sec', item.res);
      btn.innerHTML = `<span>${item.label}</span>`;
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        currentActiveResolution = item.res;
        syncToolbarHighlight();
        activateSecondResolutionOnOriginal(item.res);
      });
      secGroup.appendChild(btn);
    });

    syncToolbarHighlight();
  }

  function injectDropdownPopup() {
    const allSpans = Array.from(document.querySelectorAll('div, span'));
    const timeItem = allSpans.find(el => el.textContent.trim() === 'Time' && el.children.length === 0);
    if (!timeItem) return;

    let gridContainer = timeItem.parentElement;
    let depth = 0;
    while (gridContainer && depth < 5) {
      const txt = gridContainer.textContent || '';
      if (txt.includes('1m') && txt.includes('2m') && txt.includes('5m') && txt.includes('15m')) {
        break;
      }
      gridContainer = gridContainer.parentElement;
      depth++;
    }
    if (!gridContainer || gridContainer.querySelector('#kcex-sec-dropdown-section')) return;

    const secRow = document.createElement('div');
    secRow.id = 'kcex-sec-dropdown-section';
    secRow.className = 'kcex-sec-dropdown-row';
    secRow.style.gridColumn = '1 / -1';

    SECOND_INTERVALS.forEach(item => {
      const isFav = favResolutions.includes(item.res);
      const isActive = currentActiveResolution === item.res;

      const cell = document.createElement('div');
      cell.className = `kcex-sec-dropdown-item ${isActive ? 'active' : ''}`;
      cell.innerHTML = `
        <span class="kcex-sec-star ${isFav ? 'fav' : ''}" title="افزودن به نوار بالا">★</span>
        <span style="flex:1;">${item.label}</span>
      `;

      const starEl = cell.querySelector('.kcex-sec-star');
      starEl.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (favResolutions.includes(item.res)) {
          if (favResolutions.length > 1) {
            favResolutions = favResolutions.filter(r => r !== item.res);
          }
        } else {
          favResolutions.push(item.res);
        }
        saveFavResolutions(favResolutions);
        starEl.classList.toggle('fav', favResolutions.includes(item.res));
        injectTopToolbarButtons();
      });

      cell.addEventListener('click', (ev) => {
        ev.stopPropagation();
        currentActiveResolution = item.res;
        injectTopToolbarButtons();
        activateSecondResolutionOnOriginal(item.res);
        document.querySelectorAll('#kcex-sec-dropdown-section .kcex-sec-dropdown-item').forEach(el => el.classList.remove('active'));
        cell.classList.add('active');
      });

      secRow.appendChild(cell);
    });

    gridContainer.insertBefore(secRow, gridContainer.firstChild);

    if (!gridContainer.__kcexDropdownHookedV6__) {
      gridContainer.__kcexDropdownHookedV6__ = true;
      gridContainer.addEventListener('click', (e) => {
        if (e.target.closest('#kcex-sec-dropdown-section')) return;
        if (currentActiveResolution) {
          currentActiveResolution = null;
          syncToolbarHighlight();
          triggerReactChartReload();
        }
      }, true);
    }
  }

  setInterval(() => {
    tryHookWebpackKlineCharts();
    injectTopToolbarButtons();
    injectDropdownPopup();
  }, 350);
})();
