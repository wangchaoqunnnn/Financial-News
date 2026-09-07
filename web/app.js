/* ============================================================
 * 财讯雷达 · 前端（v1.2 实时版）
 * - live 模式：从本机 Node 后端（/api/*）拉取真实快讯/公告/行情/K线/分时
 * - demo 模式：后端不可达时降级为内置模拟数据（data.js），并明确提示
 * 对应需求：FR-01~11、FR-17 / DP-1~7 / DR-05~12 / R-1 / COM-4/5
 * ============================================================ */
(function () {
  'use strict';

  /* ---------- 基础 ---------- */
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function fmtRel(ts) { var d = Date.now() - ts; if (d < 60e3) return '刚刚'; if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前'; if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前'; return Math.floor(d / 86400e3) + ' 天前'; }
  function fmtClock(ts) { var d = new Date(ts), p = function (n) { return (n < 10 ? '0' : '') + n; }; return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
  function fmtDT(ts) { var d = new Date(ts); return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + fmtClock(ts); }
  function isToday(ts) { return new Date(ts).toDateString() === new Date().toDateString(); }
  function num(v, d) { v = +v; if (!isFinite(v)) return '-'; return v.toFixed(d == null ? 2 : d); }
  function fmtChg(n) { n = +n; if (!isFinite(n)) return '-'; return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; }
  function chgCls(n) { return +n > 0 ? 'up-c' : (+n < 0 ? 'down-c' : ''); }
  function loadLS(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function saveLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  function uid() { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  var SENTI = { up: '偏多', neu: '中性', down: '偏空' };
  var SENTI_CLS = { up: 'up', neu: 'neu', down: 'down' };

  /* ---------- 全局状态 ---------- */
  var MODE = 'demo';                 // live | demo
  var meta = null;
  var items = [];                    // 统一内部条目（按 time 倒序渲染前重排）
  var itemMap = new Map();
  var seenNew = new Set();           // （保留：预留新到达高亮）
  var state = { type: '全部', market: '全部', ind: '全部', onlyImportant: false, hot: 'realtime' };
  var watch = loadLS('fn_watch', ['600519', '300750', '688981']);
  var watchQuotes = {};
  var pushEntries = [];               // 推送记录（live=服务端日志 / demo=本地模拟）
  var indOptions = [];
  var demoStocks = {};
  if (window.FN && FN.STOCKS) FN.STOCKS.forEach(function (s) { demoStocks[s.code] = s; });

  /* ---------- API（支持独立后端地址：?api=… 或本地存储 fn_api_base） ---------- */
  var apiBase = '';
  try { var _q = new URLSearchParams(location.search).get('api'); if (_q) apiBase = _q.replace(/\/+$/, ''); } catch (e) { /* */ }
  if (!apiBase) apiBase = loadLS('fn_api_base', '');
  function apiUrl(path) { return apiBase + path; }
  async function api(path) {
    var r = await fetch(apiUrl(path), { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  async function api2(path, body) {
    var r = await fetch(apiUrl(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  /* ---------- 统一条目 ---------- */
  function upsert(list) {
    var added = [];
    list.forEach(function (it) {
      if (!it || !it.id || !it.title) return;
      var isNew = !itemMap.has(it.id);
      it.ts = it.time || it.ts || Date.now();
      it.codes = (it.codes || []).filter(function (c) { return c && c.code; });
      itemMap.set(it.id, it);
      if (isNew) added.push(it);
    });
    items = [...itemMap.values()];
    if (items.length > 2600) {
      items.sort(function (a, b) { return b.ts - a.ts; });
      var drop = items.slice(2600);
      drop.forEach(function (x) { itemMap.delete(x.id); });
      items = [...itemMap.values()];
    }
    return added;
  }
  function demoItems() {
    if (!window.FN) return [];
    var now = Date.now();
    return (FN.NEWS || []).map(function (n, i) {
      return {
        id: 'demo' + i, type: n.t, title: n.ti, summary: n.sum, body: n.body, source: n.src,
        link: n.rumor ? '' : '#', time: now - (n.mins || 0) * 60e3, ts: now - (n.mins || 0) * 60e3,
        market: n.m, ind: n.ind || '宏观', codes: (n.codes || []).map(function (c) { var s = demoStocks[c]; return { code: c, name: s ? s.name : c, ind: s ? s.ind : '' }; }),
        annType: n.ann || null, senti: n.st || 'neu', imp: !!n.imp, rumor: !!n.rumor, merged: (n.rel && n.rel.length ? n.rel.length + 1 : 1)
      };
    });
  }

  /* ---------- 过滤 ---------- */
  function filtered() {
    var f = items.filter(function (it) {
      if (state.type !== '全部' && it.type !== state.type) return false;
      if (state.market !== '全部' && it.market !== state.market) return false;
      if (state.ind !== '全部' && it.ind !== state.ind) return false;
      if (state.onlyImportant && !it.imp) return false;
      return true;
    });
    return f.sort(function (a, b) { return b.ts - a.ts; });
  }
  function hotScore(it) {
    var min = Math.max(0, (Date.now() - it.ts) / 60e3);
    var rec = Math.max(0, 100 - min * 0.15);
    var mul = Math.min((it.merged || 1) * 5, 45);
    var im = it.imp ? 40 : 0;
    return rec + mul + im;
  }
  function hotWindow(it) {
    var min = (Date.now() - it.ts) / 60e3;
    if (min < 180) return 'realtime';
    if (isToday(it.ts)) return 'today';
    return 'week';
  }

  /* ---------- 渲染：卡片 ---------- */
  function codeChips(it) {
    return (it.codes || []).map(function (c) {
      return '<span class="stock-chip" data-act="stock" data-code="' + esc(c.code) + '" title="点击查看走势图">' +
        esc(c.name) + ' <span class="chg-neu" style="color:#98a2b3;font-size:10.5px">' + esc(c.code) + '</span></span>';
    }).join('');
  }
  function flagsHTML(it) {
    var a = [];
    if (it.imp) a.push('<span class="flag imp">⭐重要</span>');
    if ((it.merged || 1) >= 3) a.push('<span class="flag hotf">多源×' + (it.merged || 1) + '</span>');
    if (it.rumor) a.push('<span class="flag rumor">未经证实</span>');
    if (it.annType) a.push('<span class="flag imp" style="background:#f0fdf4;color:#166534">' + esc(it.annType) + '</span>');
    return a.join('');
  }
  function cardHTML(it, opts) {
    opts = opts || {};
    var rumorBox = '';
    if (it.rumor) {
      rumorBox = '<div class="rumor-box">⚠️ <b>未经证实</b>：该消息来自媒体转载/社交线索（' + esc(it.source) + '），未经上市公司官方披露，仅作辅助参考，不构成投资依据（COM-4）。' +
        (it.link ? ' <a class="link-like" href="' + esc(it.link) + '" target="_blank" rel="noopener noreferrer">查看原文</a>' : '') + '</div>';
    }
    var annKpi = it.annType ? '<span class="kpi">' + esc(it.annType) + '</span>' : '';
    return '<article class="card" data-act="card" data-id="' + esc(it.id) + '">' +
      '<div class="card-head">' +
        '<span class="type-badge t-' + esc(it.type) + '">' + esc(it.type) + '</span>' + annKpi +
        '<span class="src-tag">' + esc(it.source) + '</span>' +
        (it.market !== 'A股' ? '<span class="src-tag">' + esc(it.market) + '</span>' : '') +
        (it.ind && it.ind !== '宏观' ? '<span class="src-tag">' + esc(it.ind) + '</span>' : '') +
        '<span class="news-time">' + fmtRel(it.ts) + ' · ' + fmtClock(it.ts) + '</span>' +
        '<span class="flag-row">' + flagsHTML(it) + '</span>' +
      '</div>' +
      '<div class="card-title">' + esc(it.title) + '</div>' +
      '<div class="card-sum">' + esc(it.summary || it.body || '') + '</div>' +
      rumorBox +
      '<div class="stock-chips">' + codeChips(it) +
        '<span class="senti ' + SENTI_CLS[it.senti] + '">倾向：' + (SENTI[it.senti] || it.senti) + '</span>' +
        '<span class="senti" style="margin-left:8px">' + (it.merged > 1 ? '已合并 ' + it.merged + ' 家来源' : '单源首发') + '</span>' +
      '</div>' +
    '</article>';
  }

  /* ---------- 渲染：主信息流 ---------- */
  function renderFeed() {
    var list = filtered();
    $('feed').innerHTML = list.map(function (it) { return cardHTML(it); }).join('');
    $('feedEmpty').classList.toggle('hidden', list.length > 0);
    var parts = [];
    if (state.type !== '全部') parts.push(state.type);
    if (state.market !== '全部') parts.push(state.market);
    if (state.ind !== '全部') parts.push(state.ind);
    if (state.onlyImportant) parts.push('只看重要');
    $('feedTitle').textContent = (parts.length ? parts.join(' / ') : '实时信息流') + ' · 共 ' + list.length + ' 条（时间倒序，保留 7 日）';
  }

  /* ---------- 重要消息 / 热点榜 ---------- */
  function renderImportant() {
    var list = items.filter(function (x) { return x.imp && x.type !== '传闻'; }).sort(function (a, b) { return b.ts - a.ts; }).slice(0, 7);
    $('importantList').innerHTML = list.map(function (it) {
      return '<li class="mini-item" data-act="card" data-id="' + esc(it.id) + '">' +
        '<div class="mi-meta"><span class="type-badge t-' + esc(it.type) + '">' + esc(it.type) + '</span>' +
        '<span>' + esc(it.source) + '</span><span>' + fmtRel(it.ts) + '</span></div>' +
        '<div class="mi-title">' + esc(it.title) + '</div></li>';
    }).join('') || '<li style="color:var(--muted);font-size:12px">暂无（判定规则：停复牌/立案/业绩预告/重组/政策等，见 DP-4）</li>';
  }
  function renderHot() {
    var lbl = { realtime: '近3小时', today: '今日', week: '近7日' };
    var list = items.filter(function (it) { return state.hot === 'week' || hotWindow(it) === state.hot; })
      .sort(function (a, b) { return hotScore(b) - hotScore(a); }).slice(0, 10);
    $('hotList').innerHTML = list.map(function (it) {
      return '<li data-act="card" data-id="' + esc(it.id) + '">' + esc(it.title) +
        '<span class="hm">' + esc(it.type) + ' · ' + esc(it.source) + ' · 热度分 ' + Math.round(hotScore(it)) + (it.imp ? ' · 重要' : '') + ' · ' + fmtRel(it.ts) + '</span></li>';
    }).join('') || '<li>暂无</li>';
  }

  /* ---------- 自选股 ---------- */
  function renderWatch() {
    var rows = watch.map(function (code) {
      var name = code;
      var it = items.find(function (x) { return x.codes.some(function (c) { return c.code === code; }); });
      if (it) { var cc = it.codes.find(function (c) { return c.code === code; }); if (cc) name = cc.name; }
      var q = watchQuotes[code];
      var body;
      if (q) {
        body = '<span class="w-chg ' + chgCls(q.pct) + '">' + num(q.price, 2) + ' ' + fmtChg(q.pct) + '</span>';
      } else {
        body = '<span class="w-chg" style="color:var(--muted);font-weight:400">' + (MODE === 'live' ? '加载行情…' : '—') + '</span>';
      }
      var abn = q && Math.abs(q.pct) >= 5 ? '<span class="flag abn">' + (q.pct > 0 ? '异动' : '大跌') + '</span>' : '';
      return '<li class="watch-item" data-act="watch-open" data-code="' + esc(code) + '">' +
        '<span>🔔</span><div><div class="w-name">' + esc(name) + abn + '</div>' +
        '<div class="w-code">' + esc(code) + '</div></div>' + body +
        '<button class="w-del" data-act="watch-del" data-code="' + esc(code) + '" title="取消订阅">×</button></li>';
    }).join('');
    $('watchList').innerHTML = rows || '<li class="watch-tip">暂无自选。点击资讯/公告中的股票标签，或从搜索添加。</li>';
  }
  function addWatch(code) {
    if (watch.indexOf(code) >= 0) { toast('已在自选股中', 'info'); return; }
    watch.push(code); saveLS('fn_watch', watch); renderWatch(); refreshWatchQuotes();
    toast('已订阅 ' + code + '（重要消息将进入企微推送候选）', 'ok');
  }
  async function refreshWatchQuotes() {
    if (!watch.length || MODE !== 'live') return;
    try {
      var j = await api('/api/quote?codes=' + watch.slice(0, 20).join(','));
      watchQuotes = {};
      (j.quotes || []).forEach(function (q) { watchQuotes[q.code] = q; });
      renderWatch();
    } catch (e) { /* 静默 */ }
  }

  /* ---------- 详情 ---------- */
  function openDetail(id) {
    var it = itemMap.get(id);
    if (!it) { var d = items.find(function (x) { return x.id === id; }); if (d) it = d; }
    if (!it) return;
    try { if (targetIdFromUrl() !== it.id) history.replaceState(null, '', '#n=' + encodeURIComponent(it.id)); } catch (e) { /* 忽略 */ }
    var link = it.link && it.link !== '#' ? '<p style="font-size:12px;margin-top:8px">🔗 原文链接：<a class="source-link" href="' + esc(it.link) + '" target="_blank" rel="noopener noreferrer">' + esc(it.link) + '</a></p>' : '';
    var rumor = it.rumor ? '<div class="disclaimer-box">⚠️ <b>未经证实</b>：本条由 ' + esc(it.source) + ' 报道/转载，未经上市公司官方披露，请以公司公告与交易所信息为准；仅作辅助参考，不作为投资依据。（COM-4/FR-08）</div>' : '';
    var mergedNote = (it.merged > 1) ? '<div class="related-box"><b>多源去重（DP-1）</b>：本事件共 ' + it.merged + ' 家来源报道，已合并为一条主记录。</div>' : '';
    var annPdf = it.type === '公告' && it.link ? '<div style="margin-top:6px"><a class="btn btn-outline btn-sm" href="' + esc(it.link) + '" target="_blank" rel="noopener noreferrer">📄 查看公告原文（巨潮 PDF）</a></div>' : '';
    openModal(
      '<button class="m-close" data-act="close-modal">×</button>' +
      '<div class="m-meta"><span class="type-badge t-' + esc(it.type) + '">' + esc(it.type) + '</span>' +
      (it.annType ? '<span class="type-badge t-公告">' + esc(it.annType) + '</span>' : '') +
      '<span class="src-tag">' + esc(it.source) + '</span>' +
      (it.market !== 'A股' ? '<span class="src-tag">' + esc(it.market) + '</span>' : '') +
      '<span>' + fmtDT(it.ts) + '（' + fmtRel(it.ts) + '）</span>' +
      '<span class="senti ' + SENTI_CLS[it.senti] + '" style="margin-left:auto">文本倾向：' + (SENTI[it.senti] || it.senti) + '</span></div>' +
      '<div class="m-title">' + esc(it.title) + '</div>' +
      '<div class="m-body">' + (it.summary ? '<p>' + esc(it.summary) + '</p>' : '') + (it.body && it.body !== it.summary ? '<p>' + esc(it.body) + '</p>' : '') +
      (it.type === '公告' ? '<p style="color:var(--muted)">公告正文以巨潮/交易所 PDF 原文为准。</p>' : '') + '</div>' +
      rumor + mergedNote + annPdf + link +
      '<div class="stock-chips" style="margin-top:8px">' + codeChips(it) + '</div>' +
      '<p style="font-size:11px;color:var(--muted);margin-top:8px">内容版权归原平台所有，本平台仅聚合展示标题/摘要并保留原文链接。信息仅供参考，不构成投资建议。</p>'
    );
  }

  /* ---------- 个股主页 + 走势图（canvas 分时/日K） ---------- */
  var stockState = { code: null, tab: 'minute', minute: null, kline: null };
  function openStock(code) {
    stockState = { code: code, tab: 'minute', minute: null, kline: null };
    var name = code;
    var ccItem = items.find(function (x) { return x.codes.some(function (c) { return c.code === code; }); });
    if (ccItem) { var cc = ccItem.codes.find(function (c) { return c.code === code; }); if (cc) name = cc.name; }
    var subOn = watch.indexOf(code) >= 0;
    var demoQuote = '';
    if (MODE === 'demo' && demoStocks[code]) {
      var ds = demoStocks[code];
      name = ds.name;
      demoQuote = '<div class="sh-quote ' + chgCls(ds.chg) + '">' + num(ds.base * (1 + ds.chg / 100), 2) + '</div><div class="sh-chg ' + chgCls(ds.chg) + '">' + fmtChg(ds.chg) + '（演示行情）</div>';
    }
    var html =
      '<button class="m-close" data-act="close-modal">×</button>' +
      '<div class="stock-hero">' +
        '<div><div class="sh-name" id="shName">' + esc(name) + '</div><div class="sh-code" id="shCode">' + esc(code) + '</div></div>' +
        '<div id="shQuoteWrap">' + demoQuote + (demoQuote ? '' : '<div class="sh-quote" style="color:var(--muted)">加载行情…</div>') + '</div>' +
        '<div style="margin-left:auto;text-align:right"><button class="btn ' + (subOn ? 'btn-ghost' : 'btn-primary') + ' btn-sm" data-act="watch-toggle" data-code="' + esc(code) + '" id="subBtn">' + (subOn ? '✓ 已订阅推送' : '🔔 订阅推送') + '</button>' +
        '<div style="margin-top:6px" class="status-pill' + (MODE === 'demo' ? '' : '') + '" id="quoteState"><span class="sd"></span>' + (MODE === 'live' ? '延时行情' : '演示模式') + '</div></div>' +
      '</div>' +
      '<div class="mini-tabs" id="stockTabs">' +
        '<button class="mini-tab active" data-act="stock-tab" data-tab="minute">分时</button>' +
        '<button class="mini-tab" data-act="stock-tab" data-tab="kline">日K</button>' +
        '<button class="mini-tab" data-act="stock-tab" data-tab="news">相关资讯</button>' +
      '</div>' +
      '<div id="stockPane"></div>';
    openModal(html);
    if (MODE === 'live') loadStockQuote(code, true);
    showStockTab('minute');
    if (MODE === 'live') {
      var iv = setInterval(function () {
        if ($('modalBox').classList.contains('hidden')) { clearInterval(iv); return; }
        loadStockQuote(code, false);
      }, 15000);
    }
  }
  async function loadStockQuote(code, first) {
    if (MODE !== 'live') return;
    try {
      var j = await api('/api/quote?codes=' + code);
      var q = (j.quotes || [])[0];
      if (!q) return;
      if ($('modalBox').classList.contains('hidden')) return;
      var nm = $('shName');
      if (nm && /^\d+$/.test((nm.textContent || '').trim()) && q.name) nm.textContent = q.name;
      var wrap = $('shQuoteWrap');
      if (!wrap) return;
      var cls = chgCls(q.pct);
      wrap.innerHTML = '<div class="sh-quote ' + cls + '">' + num(q.price, 2) + '</div>' +
        '<div class="sh-chg ' + cls + '">' + fmtChg(q.pct) + '　开 ' + num(q.open, 2) + '　高 ' + num(q.high, 2) + '　低 ' + num(q.low, 2) + '</div>' +
        '<div class="stock-stats" style="margin-top:4px"><span>昨收 ' + num(q.prev, 2) + '</span><span>成交额 ' + (q.amount > 1e8 ? num(q.amount / 1e8, 2) + '亿' : num(q.amount / 1e4, 0) + '万') + '</span>' +
        (q.turn != null ? '<span>换手 ' + num(q.turn, 2) + '%</span>' : '') + '</div>';
      var st = $('quoteState'); if (st) { st.className = 'status-pill ok'; st.innerHTML = '<span class="sd"></span>行情已更新 ' + fmtClock(Date.now()); }
      if (stockState.tab === 'minute' && stockState.minute) drawMinuteChart();
    } catch (e) {
      var st2 = $('quoteState'); if (st2) st2.innerHTML = '<span class="sd"></span>行情获取失败（稍后重试）';
    }
    if (first) { /* ignore */ }
  }
  function showStockTab(tab) {
    stockState.tab = tab;
    document.querySelectorAll('#stockTabs .mini-tab').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === tab); });
    var pane = $('stockPane');
    if (!pane) return;
    if (tab === 'minute') {
      pane.innerHTML = '<div class="loading">分时数据加载中…</div>';
      if (MODE !== 'live') { pane.innerHTML = '<div class="chart-empty">演示模式无真实分时数据，请启动后端服务（node server/server.js）</div>'; return; }
      api('/api/minute?code=' + stockState.code).then(function (d) {
        stockState.minute = d;
        if (stockState.tab !== 'minute') return;
        if (!d.points || !d.points.length) { pane.innerHTML = '<div class="chart-empty">暂无当日分时数据（可能停牌或数据源限制，北交所分时暂未覆盖）</div>'; return; }
        pane.innerHTML = '<div class="chart-card"><div class="cc-head"><span>' + esc($('shName').textContent) + ' 分时（' + (d.points[0].t || '') + ' ~ ' + (d.points[d.points.length - 1].t || '') + '）</span>' +
          '<span>蓝=价格　橙=均价　灰虚线=昨收</span></div><canvas id="cvMinute" height="300"></canvas></div>';
        drawMinuteChart();
      }).catch(function () { pane.innerHTML = '<div class="chart-empty">分时获取失败，点击 <a class="link-like" data-act="stock-tab" data-tab="minute">重试</a></div>'; });
    } else if (tab === 'kline') {
      pane.innerHTML = '<div class="loading">日K加载中…</div>';
      if (MODE !== 'live') { pane.innerHTML = '<div class="chart-empty">演示模式无真实K线，请启动后端服务</div>'; return; }
      api('/api/kline?code=' + stockState.code + '&days=160').then(function (d) {
        stockState.kline = d;
        if (stockState.tab !== 'kline') return;
        if (!d.bars || !d.bars.length) { pane.innerHTML = '<div class="chart-empty">暂无日K数据（北交所等源暂缺，可稍后重试）</div>'; return; }
        pane.innerHTML = '<div class="chart-card"><div class="cc-head"><span>' + esc($('shName').textContent) + ' 日K（前复权，近 ' + d.bars.length + ' 交易日）</span>' +
          '<span>红涨绿跌　MA5/MA10</span></div><canvas id="cvKline" height="380"></canvas></div>';
        drawKlineChart();
      }).catch(function () { pane.innerHTML = '<div class="chart-empty">K线获取失败</div>'; });
    } else {
      pane.innerHTML = '<div class="loading">相关资讯加载中…</div>';
      var url = MODE === 'live' ? '/api/stocknews?code=' + stockState.code : null;
      var rel = items.filter(function (x) { return x.codes.some(function (c) { return c.code === stockState.code; }); });
      var done = function (list) {
        if (stockState.tab !== 'news') return;
        var l = list && list.length ? list : rel;
        pane.innerHTML = l.length
          ? l.slice(0, 40).map(function (x) { return cardHTML(x); }).join('')
          : '<div class="chart-empty">暂无该股近 7 日相关资讯（自动关联，对应 DP-5）</div>';
      };
      if (url) api(url).then(done).catch(function () { done(rel); });
      else done(null);
    }
  }

  /* ---------- 图表绘制 ---------- */
  function canvasCtx(cv) {
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth, h = parseInt(cv.getAttribute('height'), 10) || 300;
    cv.width = w * dpr; cv.height = h * dpr;
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }
  function axisLabel(ctx, v, x, y, color) { ctx.fillStyle = color || '#667085'; ctx.font = '10px sans-serif'; ctx.fillText(v, x, y); }
  function drawMinuteChart() {
    var cv = $('cvMinute'); if (!cv || !stockState.minute) return;
    var c = canvasCtx(cv), ctx = c.ctx, W = c.w, H = c.h;
    var d = stockState.minute;
    var pc = +d.preClose || 0;
    var pts = d.points.map(function (p) { return { x: +p.price, a: +p.avg || 0 }; });
    var lo = Math.min.apply(null, pts.map(function (p) { return Math.min(p.x, p.a || 1e9, pc || 1e9); }));
    var hi = Math.max.apply(null, pts.map(function (p) { return Math.max(p.x, p.a, pc); }));
    if (!isFinite(lo)) lo = 0; if (!isFinite(hi)) hi = pc * 1.02;
    var range = (hi - lo) * 1.12 || 1; var mid = (hi + lo) / 2;
    var y0 = (mid + range / 2), y1 = (mid - range / 2);
    var pad = { l: 52, r: 10, t: 8, b: 20 };
    var PW = W - pad.l - pad.r, PH = H - pad.t - pad.b;
    var X = function (i) { return pad.l + (pts.length <= 1 ? PW / 2 : i / (pts.length - 1) * PW); };
    var Y = function (v) { return pad.t + (y0 - v) / (y0 - y1) * PH; };
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = '#eef1f6'; ctx.lineWidth = 1;
    for (var g = 0; g <= 4; g++) { var gy = pad.t + PH * g / 4; ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(W - pad.r, gy); ctx.stroke(); axisLabel(ctx, (y0 - (y0 - y1) * g / 4).toFixed(2), 4, gy + 3, '#98a2b3'); }
    if (pc) { var py = Y(pc); ctx.strokeStyle = '#98a2b3'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(pad.l, py); ctx.lineTo(W - pad.r, py); ctx.stroke(); ctx.setLineDash([]); axisLabel(ctx, '昨收 ' + pc.toFixed(2), pad.l + 2, py - 3, '#98a2b3'); }
    // 时间网格
    var marks = ['09:30', '10:30', '11:30', '13:00', '14:00', '15:00'];
    marks.forEach(function (tm) {
      var idx = d.points.findIndex(function (p) { return (p.t || '').indexOf(tm) === 0; });
      if (idx >= 0) {
        var x = X(idx);
        ctx.strokeStyle = '#f2f4f8'; ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + PH); ctx.stroke();
        axisLabel(ctx, tm, x - 12, H - 6, '#98a2b3');
      }
    });
    // 均价线
    ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 1.2; ctx.setLineDash([2, 2]);
    ctx.beginPath(); pts.forEach(function (p, i) { var x = X(i), y = Y(p.a || p.x); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.stroke(); ctx.setLineDash([]);
    // 价格线 + 面积
    var last = pts[pts.length - 1];
    ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 1.6; ctx.beginPath();
    pts.forEach(function (p, i) { var x = X(i), y = Y(p.x); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.stroke();
    ctx.fillStyle = 'rgba(37,99,235,.08)'; ctx.beginPath(); ctx.moveTo(X(0), Y(pts[0].x));
    pts.forEach(function (p, i) { ctx.lineTo(X(i), Y(p.x)); });
    ctx.lineTo(X(pts.length - 1), pad.t + PH); ctx.lineTo(X(0), pad.t + PH); ctx.closePath(); ctx.fill();
    axisLabel(ctx, '最新 ' + last.x.toFixed(2), W - 90, pad.t + 12, '#2563eb');
  }
  function drawKlineChart() {
    var cv = $('cvKline'); if (!cv || !stockState.kline) return;
    var c = canvasCtx(cv), ctx = c.ctx, W = c.w, H = c.h;
    var bars = stockState.kline.bars;
    var pad = { l: 56, r: 10, t: 8, b: 22 };
    var PWB = W - pad.l - pad.r;
    var priceH = (H - pad.t - pad.b) * 0.72, volTop = pad.t + priceH + (H - pad.t - pad.b) * 0.06, volH = (H - pad.t - pad.b) * 0.22;
    var lo = Math.min.apply(null, bars.map(function (b) { return b.low; }));
    var hi = Math.max.apply(null, bars.map(function (b) { return b.high; }));
    var range = (hi - lo) * 1.05 || 1;
    var yP = function (v) { return pad.t + (hi - v) / range * priceH; };
    var n = bars.length, cw = Math.max(PWB / n * 0.7, 1);
    var X = function (i) { return pad.l + i / n * PWB + PWB / n / 2; };
    var maxVol = Math.max.apply(null, bars.map(function (b) { return b.vol; })) || 1;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = '#eef1f6';
    for (var g = 0; g <= 4; g++) { var gy = pad.t + priceH * g / 4; ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(W - pad.r, gy); ctx.stroke(); axisLabel(ctx, (hi - range * g / 4).toFixed(2), 4, gy + 3, '#98a2b3'); }
    ctx.strokeStyle = '#f2f4f8'; ctx.beginPath(); ctx.moveTo(pad.l, volTop); ctx.lineTo(W - pad.r, volTop); ctx.stroke();
    // MA5 / MA10
    function ma(w, i) { if (i < w - 1) return null; var s = 0; for (var k = i - w + 1; k <= i; k++) s += bars[k].close; return s / w; }
    function lineMA(w, color) {
      ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.beginPath(); var started = false;
      for (var i = 0; i < n; i++) { var v = ma(w, i); if (v == null) continue; var x = X(i), y = yP(v); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); }
      ctx.stroke();
    }
    lineMA(5, '#f59e0b'); lineMA(10, '#7c3aed');
    // K线 + 成交量
    for (var i = 0; i < n; i++) {
      var b = bars[i];
      var up = b.close >= b.open;
      var col = up ? '#d92d20' : '#0e9f6e';
      if (b.close === b.open) col = '#94a3b8';
      var x = X(i);
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, yP(b.high)); ctx.lineTo(x, yP(b.low)); ctx.stroke();
      var oy = yP(b.open), cy = yP(b.close);
      ctx.fillStyle = col;
      ctx.fillRect(x - cw / 2, Math.min(oy, cy), cw, Math.max(Math.abs(cy - oy), 1));
      // 量
      var vh = (b.vol / maxVol) * volH;
      ctx.fillStyle = up ? 'rgba(217,45,32,.45)' : 'rgba(14,159,110,.45)';
      ctx.fillRect(x - cw / 2, volTop + volH - vh, cw, vh);
    }
    // 日期轴
    var step = Math.ceil(n / 6);
    for (var i2 = 0; i2 < n; i2 += step) { axisLabel(ctx, bars[i2].date.slice(5), X(i2) - 14, H - 7, '#98a2b3'); }
    var lastB = bars[n - 1];
    axisLabel(ctx, '收 ' + lastB.close.toFixed(2), W - 80, pad.t + 12, lastB.close >= lastB.open ? '#d92d20' : '#0e9f6e');
    axisLabel(ctx, 'MA5', W - 130, pad.t + 24, '#f59e0b'); axisLabel(ctx, 'MA10', W - 130, pad.t + 36, '#7c3aed');
  }

  /* ---------- 模态 ---------- */
  function openModal(html) {
    $('modalBox').innerHTML = '<div class="modal-inner">' + html + '</div>';
    $('modalBox').classList.remove('hidden');
    $('modalMask').classList.remove('hidden');
    $('modalBox').scrollTop = 0;
  }
  function closeModal() { $('modalBox').classList.add('hidden'); $('modalMask').classList.add('hidden'); }

  /* ---------- 企微推送（实时版：服务端自动推送日志；演示版：本地模拟） ---------- */
  var pushSeenTs = +loadLS('fn_push_seen_ts', 0);
  function unreadCount() { return pushEntries.filter(function (p) { return p.ts > pushSeenTs; }).length; }
  function updateBadge() {
    var unread = unreadCount();
    ['pushBadge', 'pushBadgeFab'].forEach(function (b) { var el = $(b); el.textContent = unread; el.classList.toggle('hidden', unread === 0); });
  }
  async function fetchServerPush() {
    if (MODE !== 'live') return;
    try {
      var j = await api('/api/push-log');
      pushEntries = (j.items || []).map(function (p) { return { id: p.id, ts: p.ts, title: p.title, type: p.type, newsId: p.newsId, status: p.status, note: p.note || '', target: p.target || '企微群机器人' }; });
      renderPush(); updateBadge();
    } catch (e) { /* 忽略 */ }
  }
  function demoPushInit() {
    var list = items.filter(function (x) { return x.imp && x.type !== '传闻'; }).slice(0, 3);
    pushEntries = list.map(function (it, i) { return { id: 'demo' + i, ts: Date.now() - i * 3000, title: it.title, type: it.type, newsId: it.id, status: '演示·未连接服务', note: '', target: '企微群机器人' }; });
    renderPush(); updateBadge();
  }
  function openDrawer() {
    $('pushDrawer').classList.remove('hidden');
    $('pushMask').classList.remove('hidden');
    if (MODE === 'live') fetchServerPush();
    renderPush();
  }
  function closeDrawer() { $('pushDrawer').classList.add('hidden'); $('pushMask').classList.add('hidden'); }
  function renderPush() {
    $('pushList').innerHTML = pushEntries.map(function (p) {
      var st = p.status === '已发送' ? '✅ ' + esc(p.status) : (p.status === '发送失败' ? '⚠️ ' + esc(p.status) + (p.note ? '：' + esc(p.note) : '') : esc(p.status || p.note || ''));
      return '<li class="push-item' + (p.status === '发送失败' ? ' dedupe' : '') + '">' +
        '<div class="pi-head"><span>💬 企业微信 · ' + esc(p.target || '群机器人') + '</span><span>' + fmtClock(p.ts) + '</span><span class="pi-status" style="margin-left:auto">' + st + '</span></div>' +
        '<div class="pi-body"><div class="pi-title" data-act="card" data-id="' + esc(p.newsId || '') + '" style="cursor:pointer">' + esc(p.title) + '</div>' +
        '<div class="pi-line">' + esc(p.type || '') + ' · 点击打开详情 · 自动推送（同事件去重 / 20s 频控）</div></div></li>';
    }).join('') || '<li style="color:var(--muted);font-size:12.5px;padding:8px">暂无推送记录。在「⚙ 设置」填入企微机器人 Webhook 后，检测到的重要消息会自动推送到群并在此展示。</li>';
  }
  function markAllRead() { pushSeenTs = Date.now(); saveLS('fn_push_seen_ts', pushSeenTs); updateBadge(); }
  async function sendTestPush() {
    if (MODE === 'demo') { toast('演示模式无法真实推送，请启动后端并配置 Webhook', 'warn'); return; }
    try {
      var r = await api('/api/push-test');
      if (r.sent) { toast('测试消息已发送到企微群 ✓', 'ok'); fetchServerPush(); }
      else toast('发送失败：' + (r.reason || '未知'), 'warn');
    } catch (e) { toast('请求失败：' + e.message, 'warn'); }
  }

  /* ---------- Toast / 时钟 ---------- */
  function toast(msg, kind) { var t = document.createElement('div'); t.className = 'toast ' + (kind || ''); t.textContent = msg; $('toasts').appendChild(t); setTimeout(function () { t.remove(); }, 4200); }
  function tickClock() {
    $('clockTime').textContent = fmtClock(Date.now());
    var d = new Date(), day = d.getDay(), hm = d.getHours() * 60 + d.getMinutes();
    var trading = day >= 1 && day <= 5 && ((hm >= 570 && hm <= 690) || (hm >= 780 && hm <= 900));
    var el = $('marketState'); el.textContent = trading ? '交易中' : (day >= 1 && day <= 5 && hm < 570 ? '未开盘' : (day >= 1 && day <= 5 && hm > 900 && hm < 930 ? '午间休市' : '已收盘/休市'));
    el.classList.toggle('closed', !trading);
  }

  /* ---------- 模式横幅 ---------- */
  function setBanner(html, cls) { var t = $('bannerText'); if (t) { t.innerHTML = html; } var m = $('modeTag'); if (m) m.textContent = cls || ''; }
  function setMode(mode, metaData) {
    MODE = mode; meta = metaData;
    if (mode === 'live') {
      setBanner('<span class="status-pill ok" style="margin-right:6px"><span class="sd"></span>实时模式</span> 真实公开数据：新浪财经快讯 · 巨潮公告 · 东财行情(延时) · 腾讯/新浪日K。仅供参考，不构成投资建议；内容版权归原平台。', 'LIVE');
      $('demoBanner').style.display = '';
    } else if (mode === 'demo') {
      setBanner('<b>内置演示数据（非实时，仅调试）</b>：点击右上角「⚙」下方的状态条或刷新页面可回到实时模式。后端启动后将自动切换。', '演示');
      $('demoBanner').style.display = '';
    } else {
      setBanner('<b>未连接数据服务</b>：请按下方面板提示启动后端（node server/server.js）或配置 /api 反代；页面每 12 秒自动重试。', '离线');
      $('demoBanner').style.display = '';
    }
    var ab = $('btnAbout'); if (ab) ab.textContent = mode === 'live' ? '数据来源与说明 →' : '需求对照与说明 →';
    var tp = $('btnTriggerPush');
    if (tp) tp.textContent = mode === 'live' ? '📨 发送测试消息到企微' : (mode === 'demo' ? '▶ 模拟推送一条（演示）' : '—');
  }

  /* ---------- 数据轮询（live） ---------- */
  var firstPollDone = false;
  async function pollFeed() {
    try {
      var j = await api('/api/feed?type=全部&max=2000');
      var added = upsert(j.items || []);
      rebuildIndustries();
      renderFeed(); renderImportant(); renderHot();
      if (!firstPollDone) { firstPollDone = true; return true; }   // 首次装载不弹提示
      var hasImp = false;
      added.forEach(function (it) {   // 后续轮询：新到达提示；重要消息由服务端自动推企微
        toast('⚡ 新资讯：' + (it.title || '').slice(0, 30) + '…', 'info');
        if (it.imp && it.type !== '传闻') hasImp = true;
      });
      if (hasImp) fetchServerPush();   // 拉取服务端自动推送日志
      return true;
    } catch (e) { return false; }
  }
  function rebuildIndustries() {
    var map = {};
    items.forEach(function (it) { if (it.ind && it.ind !== '宏观') map[it.ind] = (map[it.ind] || 0) + 1; });
    var arr = Object.keys(map).sort(function (a, b) { return map[b] - map[a]; }).slice(0, 14);
    if (JSON.stringify(arr) === JSON.stringify(indOptions)) return;
    indOptions = arr;
    var sel = $('industrySel'); var cur = state.ind;
    sel.innerHTML = '<option value="全部">全部行业</option>' + arr.map(function (x) { return '<option value="' + esc(x) + '">' + esc(x) + '</option>'; }).join('');
    if (arr.indexOf(cur) < 0) { state.ind = '全部'; sel.value = '全部'; }
    else sel.value = cur;
  }

  /* ---------- 搜索 ---------- */
  var searchTimer = null;
  function doSearch(q) {
    var box = $('searchResults');
    q = (q || '').trim();
    clearTimeout(searchTimer);
    if (!q) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    searchTimer = setTimeout(async function () {
      var h = '';
      try {
        if (MODE === 'live') {
          var [sj, nj] = await Promise.all([api('/api/stocks?q=' + encodeURIComponent(q)), api('/api/feed?q=' + encodeURIComponent(q) + '&max=6')]);
          upsert(nj.items || []);            // 保证点击可打开详情
          h += groupStocks(sj.items);
          h += groupNews(nj.items);
        } else {
          var stocks = FN.STOCKS.filter(function (s) { return s.name.indexOf(q) >= 0 || s.code.indexOf(q) >= 0; });
          var news = items.filter(function (x) { return (x.title + x.summary).indexOf(q) >= 0; });
          h += groupStocks(stocks.map(function (s) { return { code: s.code, name: s.name, ind: s.ind }; }));
          h += groupNews(news.slice(0, 6));
        }
      } catch (e) { /* */ }
      if (!h) h = '<div class="sr-item" style="color:var(--muted)">未找到匹配的标的或资讯（近 7 日）</div>';
      box.innerHTML = h; box.classList.remove('hidden');
    }, 260);
  }
  function groupStocks(list) {
    if (!list || !list.length) return '';
    return '<div class="sr-group">标的（点击查看走势图）</div>' + list.map(function (s) {
      return '<div class="sr-item" data-act="stock" data-code="' + esc(s.code) + '"><span class="sr-type" style="background:#e8f0fe;color:#2563eb">标的</span><span>' + esc(s.name) + '</span><span class="sr-code">' + esc(s.code) + ' · ' + esc(s.ind || '') + '</span></div>';
    }).join('');
  }
  function groupNews(list) {
    if (!list || !list.length) return '';
    return '<div class="sr-group">资讯（近7日）</div>' + list.map(function (x) {
      return '<div class="sr-item" data-act="card" data-id="' + esc(x.id) + '"><span class="sr-type" style="background:#f1f4f9;color:#475467">' + esc(x.type) + '</span><span>' + esc((x.title || '').slice(0, 34)) + '</span><span class="sr-time">' + fmtRel(x.ts || x.time) + '</span></div>';
    }).join('');
  }

  /* ---------- 关于/数据源 ---------- */
  function openAbout() {
    var socialNote = '';
    if (MODE === 'live' && meta && meta.social) {
      var s = meta.social, parts = [];
      ['xueqiu', 'weibo'].forEach(function (key) {
        var o = s[key]; if (!o) return;
        var label = key === 'xueqiu' ? '雪球' : '微博';
        parts.push(label + (o.configured ? (o.ok ? '已启用 ✓' : '已配置但请求失败：' + (o.err || '未知')) : '未配置 Cookie'));
      });
      socialNote = '<div class="social-note"><b>社交源状态：</b>' + parts.join('；') + '。<br>' + esc(s.guide || '') +
        '<br>真实媒体中"传/曝/知情人士"类消息不受 Cookie 影响，已如实标注<b>未经证实</b>并默认不推送。</div>';
    }
    openModal(
      '<button class="m-close" data-act="close-modal">×</button><div class="abt"><h3>关于财讯雷达（真实数据版 v1.2）</h3>' +
      '<p style="color:var(--muted);font-size:13px">当前模式：<b>' + (MODE === 'live' ? '实时数据（live）' : '离线演示（demo）') + '</b>，资讯共 ' + items.length + ' 条（近 7 日，自动清理）。</p>' +
      '<h4>1. 数据来源（实时版）</h4><div class="src-list">' + ['新浪财经7×24', '新浪财经·要闻/国际/产经', '巨潮资讯网公告(szse/sse)', '东方财富行情(延时)', '腾讯证券/新浪 日K'].map(function (s) { return '<span>' + esc(s) + '</span>'; }).join('') + '</div>' + socialNote +
      '<h4>2. 处理规则（启发式，非投资建议）</h4><ul style="font-size:13px;color:#334155;padding-left:18px;margin:4px 0">' +
      '<li>去重：归一标题指纹 + 小时窗 + 公告按证券代码区分（DP-1）</li>' +
      '<li>关联个股：A股代码词典（5900+ 只）+ 常用简称表（DP-5）</li>' +
      '<li>重要消息规则：停复牌/立案/业绩预告/重组/政策等关键词（DP-4 硬规则）</li>' +
      '<li>文本倾向：正面/负面词典启发式（DP-3 简化版，仅作参考）</li></ul>' +
      '<h4>3. 免责声明（COM-1~9）</h4><div class="disclaimer-box">' + (MODE === 'live'
        ? '本页面聚合自第三方公开接口：快讯与滚动新闻来自新浪财经，公告来自巨潮资讯网，行情为东财延时数据（非 Level-2），K线来自腾讯/新浪。内容版权归原平台所有，本页面仅展示标题/摘要并保留原文链接，不镜像正文。信息可能有延迟或误差，<b>不构成任何投资建议</b>，据此操作风险自担。'
        : '当前为离线演示模式，全部内容为模拟数据。') + '</div>' +
      '<h4>4. 数据保留</h4><p style="font-size:13px">' + (MODE === 'live' ? '服务端仅保留近 7 日正文（R-1），过期自动清理。' : '演示数据无后端保留逻辑。') + '</p>' +
      '<h4>5. 运行真实模式</h4><p style="font-size:13px">在项目目录执行 <code>node server/server.js</code>，然后访问 <code>http://127.0.0.1:8899/</code>；配置企微真实推送：设置环境变量 <code>WECOM_WEBHOOK=群机器人地址</code> 后重启。</p></div>'
    );
  }

  /* ---------- 设置页（雪球/微博 Cookie + 企微机器人 URL） ---------- */
  function openSettings() {
    var cfg = { xueqiu: { configured: false }, weibo: { configured: false }, wecom: { configured: false } };
    if (MODE === 'live') {
      api('/api/settings').then(function (c) { cfg = c; }).catch(function () { /* 忽略 */ }).then(function () { renderSettings(cfg); });
    } else renderSettings(cfg);
    if ($('modalBox') && !$('modalBox').classList.contains('hidden') && MODE !== 'live') { /* */ }
  }
  function renderSettings(cfg) {
    function statusPill(conf) { return conf ? '<span class="status-pill ok"><span class="sd"></span>已配置</span>' : '<span class="status-pill"><span class="sd"></span>未配置</span>'; }
    function group(key, label, sub, type, cv, conf) {
      var mask = conf && cv && cv.mask ? '<div style="margin:2px 0 6px"><span class="src-tag">当前：' + esc(cv.mask) + '</span></div>' : '';
      var input = type === 'url'
        ? '<input class="set-input" type="url" placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…">'
        : '<textarea rows="2" placeholder="从浏览器 DevTools → Network 请求头中复制整串 Cookie 值（含分号）"></textarea>';
      var clear = conf ? '<label class="check" style="margin-top:4px"><input type="checkbox" class="set-clear"> <span>清除此项（保存后移除）</span></label>' : '';
      return '<div class="set-group" data-key="' + key + '">' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' + statusPill(conf) + '<b>' + esc(label) + '</b><span class="hint">' + esc(sub || '') + '</span></div>' + mask + input + clear + '</div>';
    }
    var html = '<button class="m-close" data-act="close-settings">×</button><div class="abt">' +
      '<h3 style="margin-top:2px">⚙ 设置 · 数据源授权与自动推送</h3>' +
      '<p style="color:var(--muted);font-size:12.5px">提交后<b>立即生效、无需重启</b>：启用雪球/微博数据（进入「传闻」频道），并启动重要消息自动推送（去重 + 20s 频控）。配置仅保存在本机 <code>server/cookies.json</code>（已 gitignore，不会上传）。' +
      (MODE === 'live' ? '' : '<br><b style="color:#b45309">当前为离线演示模式：保存需先运行后端 node server/server.js。</b>') + '</p>' +
      group('xueqiu', '雪球 Cookie', '启用「雪球热帖」数据源', 'area', cfg.xueqiu, cfg.xueqiu && cfg.xueqiu.configured) +
      group('weibo', '微博 Cookie', '启用「微博热搜·财经」数据源', 'area', cfg.weibo, cfg.weibo && cfg.weibo.configured) +
      group('wecom', '企业微信推送机器人 URL', '群机器人 Webhook：企微群 → 添加群机器人 → 复制地址', 'url', cfg.wecom, cfg.wecom && cfg.wecom.configured) +
      '<div id="setResult"></div>' +
      '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">' +
      '<button class="btn btn-primary" data-act="settings-save">保存并立即启用</button>' +
      '<button class="btn btn-outline" data-act="wecom-test">📨 发送测试推送</button>' +
      '<button class="btn btn-ghost" data-act="close-settings">取消</button></div>' +
      '<p style="font-size:11.5px;color:var(--muted);margin-top:10px">提示：如何复制 Cookie —— 登录雪球/微博 → F12 → Network → 刷新 → 点击任意本域请求 → Request Headers 中整串复制 <code>Cookie:</code> 的值。Cookie 等同账号凭证，请勿外传。</p>' +
      '</div>';
    openModal(html);
  }
  function saveSettings() {
    var body = {};
    ['xueqiu', 'weibo'].forEach(function (k) {
      var g = document.querySelector('.set-group[data-key="' + k + '"]'); if (!g) return;
      var ta = g.querySelector('textarea'); var cl = g.querySelector('.set-clear');
      if (cl && cl.checked) body[k] = null;
      else if (ta && ta.value.trim()) body[k] = ta.value.trim();
    });
    var gw = document.querySelector('.set-group[data-key="wecom"]');
    if (gw) {
      var inp = gw.querySelector('.set-input'); var clw = gw.querySelector('.set-clear');
      if (clw && clw.checked) body.wecom = null;
      else if (inp && inp.value.trim()) body.wecom = inp.value.trim();
    }
    var res = $('setResult');
    if (!res) return;
    if (!Object.keys(body).length) { res.innerHTML = '<div class="social-note">没有需要保存的变更：请填写内容，或勾选「清除此项」后保存。</div>'; return; }
    res.innerHTML = '<div class="loading">正在提交并启用…</div>';
    api2('/api/settings', body).then(function (r) {
      res.innerHTML = '<div class="social-note" style="background:#f0fdf4;border-color:#bbe7cd;color:#166534">✅ 保存成功：雪球=' + (r.xueqiu ? '启用' : '关闭') + '，微博=' + (r.weibo ? '启用' : '关闭') + '，企微自动推送=' + (r.wecom ? '开启' : '关闭') + '。数据源已开始抓取，重要消息将自动推送到企微群。</div>';
      toast('设置已保存并生效', 'ok');
      if (MODE === 'live') { pollFeed(); fetchServerPush(); }
      setTimeout(function () { openSettings(); }, 1500);
    }).catch(function (e) { res.innerHTML = '<div class="social-note">保存失败：' + esc(e.message) + '</div>'; });
  }
  async function testWecomFromSettings() {
    var res = $('setResult'); if (!res) return;
    var gw = document.querySelector('.set-group[data-key="wecom"]');
    var url = gw ? gw.querySelector('.set-input').value.trim() : '';
    if (url) { try { await api2('/api/settings', { wecom: url }); } catch (e) { res.innerHTML = '<div class="social-note">Webhook 保存失败：' + esc(e.message) + '</div>'; return; } }
    res.innerHTML = '<div class="loading">正在发送测试消息…</div>';
    try {
      var r = await api('/api/push-test');
      res.innerHTML = r.sent
        ? '<div class="social-note" style="background:#f0fdf4;border-color:#bbe7cd;color:#166534">✅ 测试推送已发送到企微群，请查收群消息。</div>'
        : '<div class="social-note">⚠️ 发送失败：' + esc(r.reason || '未配置 Webhook') + '</div>';
    } catch (e) { res.innerHTML = '<div class="social-note">请求失败：' + esc(e.message) + '</div>'; }
  }

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    document.querySelectorAll('#typeTabs .tab').forEach(function (b) {
      b.addEventListener('click', function () { state.type = b.dataset.type; document.querySelectorAll('#typeTabs .tab').forEach(function (x) { x.classList.toggle('active', x === b); }); renderFeed(); });
    });
    document.querySelectorAll('#marketChips .chip').forEach(function (b) {
      b.addEventListener('click', function () { state.market = b.dataset.market; document.querySelectorAll('#marketChips .chip').forEach(function (x) { x.classList.toggle('active', x === b); }); renderFeed(); });
    });
    $('industrySel').addEventListener('change', function () { state.ind = this.value; renderFeed(); });
    $('onlyImportant').addEventListener('change', function () { state.onlyImportant = this.checked; renderFeed(); });
    $('btnClearFilters').addEventListener('click', function () {
      state.type = '全部'; state.market = '全部'; state.ind = '全部'; state.onlyImportant = false;
      document.querySelectorAll('#typeTabs .tab, #marketChips .chip').forEach(function (x) { x.classList.toggle('active', x.dataset.type === '全部' || x.dataset.market === '全部'); });
      $('industrySel').value = '全部'; $('onlyImportant').checked = false; renderFeed();
    });
    document.querySelectorAll('#hotTabs .seg-btn').forEach(function (b) {
      b.addEventListener('click', function () { state.hot = b.dataset.hot; document.querySelectorAll('#hotTabs .seg-btn').forEach(function (x) { x.classList.toggle('active', x === b); }); renderHot(); });
    });
    $('btnOpenPush').addEventListener('click', openDrawer);
    $('pushFab').addEventListener('click', openDrawer);
    $('pushClose').addEventListener('click', closeDrawer);
    $('pushMask').addEventListener('click', closeDrawer);
    $('btnMarkRead').addEventListener('click', markAllRead);
    $('btnTriggerPush').addEventListener('click', sendTestPush);
    $('btnSettings').addEventListener('click', openSettings);
    $('searchInput').addEventListener('input', function () { doSearch(this.value); });
    $('searchInput').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var q = this.value.trim(); if (!q) return;
      $('searchResults').classList.add('hidden');
      if (MODE === 'live') {
        api('/api/stocks?q=' + encodeURIComponent(q)).then(function (j) {
          if (j.items && j.items.length) openStock(j.items[0].code); else toast('未找到该股票，试试输入代码或全称', 'warn');
        }).catch(function () { toast('搜索服务暂不可用', 'warn'); });
      } else {
        var s = FN.STOCKS.find(function (x) { return x.name.indexOf(q) >= 0 || x.code.indexOf(q) >= 0; });
        if (s) openStock(s.code); else toast('演示库中未找到该标的', 'warn');
      }
    });
    document.addEventListener('click', function (e) { if (!e.target.closest('.search-wrap')) { var box = $('searchResults'); if (box) box.classList.add('hidden'); } });
    function addFromInput() {
      var v = $('watchAddInput').value.trim(); if (!v) return;
      if (MODE === 'live') {
        api('/api/stocks?q=' + encodeURIComponent(v)).then(function (j) {
          var s = j.items && j.items.find(function (x) { return x.code.indexOf(v) >= 0 || x.name.indexOf(v) >= 0; });
          if (s) { addWatch(s.code); $('watchAddInput').value = ''; } else toast('未找到该股票（可用代码或全称）', 'warn');
        });
      } else {
        var s = FN.STOCKS.find(function (x) { return x.code.indexOf(v) >= 0 || x.name.indexOf(v) >= 0; });
        if (s) { addWatch(s.code); $('watchAddInput').value = ''; } else toast('演示库中未找到', 'warn');
      }
    }
    $('watchAddBtn').addEventListener('click', addFromInput);
    $('watchAddInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') addFromInput(); });
    $('btnAbout').addEventListener('click', openAbout);
    $('btnAbout2').addEventListener('click', openAbout);
    $('bannerClose').addEventListener('click', function () { $('demoBanner').style.display = 'none'; });
    $('modalMask').addEventListener('click', closeModal);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeModal(); closeDrawer(); } });
  }
  function bindDelegation() {
    document.addEventListener('click', function (e) {
      var t = e.target.closest('[data-act]');
      if (!t) return;
      var act = t.dataset.act, code = t.dataset.code;
      if (act === 'card') { openDetail(t.dataset.id); }
      else if (act === 'stock') { e.stopPropagation(); openStock(code); }
      else if (act === 'watch-open') { openStock(code); }
      else if (act === 'watch-del') {
        watch = watch.filter(function (c) { return c !== code; }); saveLS('fn_watch', watch); delete watchQuotes[code]; renderWatch();
        toast('已取消订阅 ' + code, 'info');
      } else if (act === 'watch-toggle') {
        if (watch.indexOf(code) >= 0) { watch = watch.filter(function (c) { return c !== code; }); saveLS('fn_watch', watch); toast('已取消订阅', 'info'); }
        else { watch.push(code); saveLS('fn_watch', watch); toast('已订阅（企微推送候选）', 'ok'); }
        renderWatch(); refreshWatchQuotes(); if ($('modalBox') && !$('modalBox').classList.contains('hidden')) openStock(code);
      } else if (act === 'stock-tab') { showStockTab(t.dataset.tab); }
      else if (act === 'close-modal') { closeModal(); }
      else if (act === 'close-settings') { closeModal(); }
      else if (act === 'settings-save') { saveSettings(); }
      else if (act === 'wecom-test') { testWecomFromSettings(); }
      else if (act === 'conn-retry') { tryConnect(); }
      else if (act === 'demo-load') { loadManualDemo(); }
      else if (act === 'api-save') {
        var inp = $('apiBaseInput');
        if (inp) { apiBase = inp.value.trim().replace(/\/+$/, ''); saveLS('fn_api_base', apiBase); }
        tryConnect();
      }
    });
  }

  /* ---------- 引导 ---------- */
  /* 深链：#n=消息id / ?n=消息id（企微推送点开直达详情，如 https://wangchaoqun.top/news#n=xxxx） */
  function targetIdFromUrl() {
    try { var sp = new URLSearchParams(location.search); var q = sp.get('n'); if (q) return q; } catch (e) { /* */ }
    var h = location.hash || '';
    if (h.indexOf('#n=') === 0) return decodeURIComponent(h.slice(3));
    return null;
  }
  function tryOpenTarget(attempt) {
    var id = targetIdFromUrl();
    if (!id) return;
    if (itemMap.has(id)) { openDetail(id); return; }
    if ((attempt || 0) < 6) { setTimeout(function () { tryOpenTarget((attempt || 0) + 1); }, 500); return; }
    if (MODE === 'live') {
      api('/api/item?id=' + encodeURIComponent(id)).then(function (j) {
        if (j && j.item) { upsert([j.item]); openDetail(j.item.id); }
        else toast('该消息已超出 7 日保留期或已被清理', 'warn');
      }).catch(function () { toast('打开失败：服务不可达', 'warn'); });
    } else toast('该消息已超出 7 日保留期或已被清理', 'warn');
  }
  /* ---------- 引导：在线优先（不再自动降级为演示数据） ---------- */
  var bootedLive = false, manualDemo = false, connTimer = null;
  function startLive(m) {
    if (bootedLive) return;
    bootedLive = true; manualDemo = false;
    meta = m; MODE = 'live';
    setMode('live', m);
    renderWatch();
    pollFeed().then(function () { fetchServerPush(); tryOpenTarget(0); });
    window.addEventListener('hashchange', function () { tryOpenTarget(0); });
    window.addEventListener('popstate', function () { tryOpenTarget(0); });
    setInterval(function () { pollFeed(); }, 15000);
    setInterval(function () { refreshWatchQuotes(); }, 10000);
    setInterval(function () { fetchServerPush(); }, 20000);
    if (connTimer) { clearInterval(connTimer); connTimer = null; }
  }
  async function tryConnect() {
    if (bootedLive) return true;
    try {
      var m = await api('/api/meta');
      if (!m || m.mode !== 'live') throw new Error('后端返回异常（mode=' + (m && m.mode) + '）');
      startLive(m);
      return true;
    } catch (e) {
      if (!manualDemo) showOffline(e && e.message ? e.message : String(e));
      return false;
    }
  }
  function showOffline(msg) {
    if (bootedLive) return;
    MODE = 'demo';                 // 仅用于防止未授权操作，不加载任何演示数据
    setMode('offline', null);
    $('feedTitle').textContent = '后端连接失败';
    $('feedEmpty').classList.add('hidden');
    var cur = apiBase ? '当前后端：<b>' + esc(apiBase) + '</b>' : '当前后端：<b>与页面同源</b>（' + esc(apiUrl('/api/meta')) + '）';
    $('feed').innerHTML = '<div class="card" style="padding:18px">' +
      '<h3 style="margin:0 0 8px">⚠️ 未能连接数据服务（实时模式）</h3>' +
      '<p style="font-size:13px;color:#475467">尝试请求 <code>' + esc(apiUrl('/api/meta')) + '</code> 失败' + (msg ? '：<span style="color:#b45309">' + esc(msg) + '</span>' : '') + '。</p>' +
      '<div class="social-note" style="font-size:12.5px">' +
      '<b>排查步骤（服务器端）：</b><br>① 服务器已运行 <code>node server/server.js</code>（监听 8899）；<br>' +
      '② nginx 已配置 <code>location /api { proxy_pass http://127.0.0.1:8899; }</code>；<br>' +
      '③ 验证：浏览器打开 <code>' + esc(apiUrl('/api/meta')) + '</code> 应返回 JSON（mode=live）。<br>' +
      '后端也可部署在<b>独立域名/端口</b>：在下方填入其根地址（如 https://api.wangchaoqun.top），前端会自动重连。</div>' +
      '<label style="font-size:12.5px;display:block;margin:8px 0 4px">数据服务地址（留空 = 与页面同源）：</label>' +
      '<input class="set-input" id="apiBaseInput" placeholder="https://api.wangchaoqun.top 或留空" value="' + esc(apiBase) + '">' +
      '<p style="font-size:12px;color:var(--muted);margin:6px 0">' + cur + '（页面每 12 秒自动重试，连接成功后自动进入实时模式）</p>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">' +
      '<button class="btn btn-primary" data-act="api-save">保存地址并重连</button>' +
      '<button class="btn btn-outline" data-act="conn-retry">立即重连</button>' +
      '<button class="btn btn-ghost" data-act="demo-load">载入内置演示数据（仅调试，非实时）</button></div></div>';
  }
  function loadManualDemo() {
    manualDemo = true; MODE = 'demo';
    setMode('demo', null);
    upsert(demoItems());
    renderFeed(); renderImportant(); renderHot(); renderWatch();
    demoPushInit();
    toast('已载入内置演示数据（非实时）。后端连接成功后会自动切换回实时模式。', 'info');
    if (connTimer) { clearInterval(connTimer); connTimer = null; }
  }
  function boot() {
    tickClock(); setInterval(tickClock, 1000);
    bindEvents(); bindDelegation();
    tryConnect();
    if (!bootedLive) connTimer = setInterval(function () { tryConnect(); }, 12000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
