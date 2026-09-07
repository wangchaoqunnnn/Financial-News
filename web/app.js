/* ============================================================
 * 财讯雷达 · 原型交互逻辑
 * 对应需求：FR-01 信息流 / FR-02 分类筛选 / FR-03 全文搜索
 *           FR-04 个股聚合 / FR-05 自选订阅 / FR-06 重要消息
 *           FR-07 热点榜 / FR-08 传闻管理 / FR-09 企微推送
 *           FR-10 详情 / FR-11 公告结构化 / FR-17 行情联动
 * 演示模式：全部数据为模拟数据（见 data.js）
 * ============================================================ */
(function () {
  'use strict';
  if (!window.FN) { document.body.innerHTML = '<p style="padding:40px">数据文件加载失败，请确认与 data.js 同目录。</p>'; return; }

  /* ---------- 基础工具 ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function uid() { return 'x' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36); }

  function fmtRel(ts) {
    var d = Date.now() - ts;
    if (d < 60e3) return '刚刚';
    if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
    if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
    if (d < 7 * 86400e3) return Math.floor(d / 86400e3) + ' 天前';
    var dt = new Date(ts);
    return (dt.getMonth() + 1) + '月' + dt.getDate() + '日';
  }
  function fmtClock(ts) {
    var d = new Date(ts);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function isToday(ts) { return new Date(ts).toDateString() === new Date().toDateString(); }
  function fmtChg(n) { return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; }
  function chgCls(n) { return n > 0 ? 'up-c' : (n < 0 ? 'down-c' : ''); }
  var sentiTxt = { up: '偏多', neu: '中性', down: '偏空' };
  var sentiCls = { up: 'up', neu: 'neu', down: 'down' };

  function loadLS(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function saveLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 忽略 */ } }

  /* ---------- 状态 ---------- */
  var now = Date.now();
  var items = FN.NEWS.map(function (n, i) {
    var ts = now - n.mins * 60e3;
    return Object.assign({ id: 'n' + i, ts: ts }, n);
  });
  var queue = FN.SCHEDULED.map(function (n, i) { return Object.assign({ id: 'q' + i }, n); });
  var state = { type: '全部', market: '全部', ind: '全部', onlyImportant: false, hot: 'realtime', query: '' };
  var watch = loadLS('fn_watch', ['688988', '301119', '603519']);
  var readPushes = loadLS('fn_readPush', []);
  var pushLog = [];        // {id, ts, title, type, newsId, target, status}
  var pushTargetIdx = 0;

  /* ---------- 各筛选 ---------- */
  function filtered() {
    var f = items.filter(function (it) {
      if (state.type !== '全部' && it.t !== state.type) return false;
      if (state.market !== '全部' && it.m !== state.market) return false;
      if (state.ind !== '全部' && it.ind !== state.ind) return false;
      if (state.onlyImportant && !it.imp) return false;
      if (state.query && (it.ti + it.sum + it.body + it.src).indexOf(state.query) < 0) return false;
      return true;
    });
    return f.slice().sort(function (a, b) { return b.ts - a.ts; });
  }
  function findStock(code) { return FN.stockOf(code); }
  function codesIntersect(a, b) {
    if (!a || !b || !a.length || !b.length) return false;
    return a.some(function (c) { return b.indexOf(c) >= 0; });
  }
  function verifyItemOf(it) {
    if (!it.codes || !it.codes.length) return null;
    var v = items.find(function (x) { return x.t === '公告' && x.ann === '澄清公告' && codesIntersect(x.codes, it.codes); });
    return v || null;
  }

  /* ---------- 渲染：信息流卡片 ---------- */
  function flagsOf(it, hotTop) {
    var arr = [];
    if (it.imp) arr.push('<span class="flag imp">重要</span>');
    if (hotTop && hotTop.indexOf(it.id) >= 0) arr.push('<span class="flag hotf">热点</span>');
    if (it.t === '传闻') arr.push('<span class="flag rumor">未经证实</span>');
    return arr;
  }
  function cardHTML(it, hotTop) {
    var typeCls = 't-' + it.t;
    var chips = (it.codes || []).map(function (c) {
      var s = findStock(c); var cg = s ? s.chg : 0;
      return '<span class="stock-chip" data-act="stock" data-code="' + c + '">' + esc(s ? s.name : c) +
        ' <span class="' + (cg > 0 ? 'chg-up' : (cg < 0 ? 'chg-down' : '')) + '">' + fmtChg(cg) + '</span></span>';
    }).join('');
    var abn = '';
    if (it.codes && it.codes.length) {
      var mx = 0;
      it.codes.forEach(function (c) { var s = findStock(c); if (s) mx = Math.max(mx, Math.abs(s.chg)); });
      if (mx >= 9.9) abn = '<span class="flag abn">⚡涨停/跌停异动</span>';
      else if (mx >= 5) abn = '<span class="flag abn">⚡异动</span>';
    }
    var verify = '';
    if (it.t === '传闻') {
      var v = verifyItemOf(it);
      verify = '<div class="rumor-box">⚠️ <b>未经证实</b> · 来源：' + esc(it.src) + '，仅作辅助参考、不作为投资依据（FR-08/COM-4）' +
        (v ? '　<a class="link-like" data-act="verify" data-id="' + v.id + '">公司已发澄清公告 → 对照</a>' : '') + '</div>';
    }
    var kpis = (it.kpis || []).map(function (k) { return '<span class="kpi">' + esc(k) + '</span>'; }).join('');
    var annTag = it.ann ? '<span class="type-badge t-公告" style="margin-right:6px">' + esc(it.ann) + '</span>' : '';
    var relNote = (it.rel && it.rel.length) ? '<span class="rel-note">已合并 ' + (it.rel.length + 1) + ' 家来源报道</span>' : '';
    return '<article class="card" data-act="card" data-id="' + it.id + '">' +
      '<div class="card-head">' +
        '<span class="type-badge ' + typeCls + '">' + it.t + '</span>' + annTag +
        '<span class="src-tag">' + esc(it.src) + '</span>' +
        (it.m !== 'A股' ? '<span class="src-tag">' + esc(it.m) + '</span>' : '') +
        (it.ind && it.ind !== '宏观' ? '<span class="src-tag">' + esc(it.ind) + '</span>' : '') +
        '<span class="news-time">' + fmtRel(it.ts) + ' · ' + fmtClock(it.ts) + '</span>' +
        '<span class="flag-row">' + flagsOf(it, hotTop).join('') + abn + '</span>' +
      '</div>' +
      '<div class="card-title">' + esc(it.ti) + '</div>' +
      '<div class="card-sum">' + esc(it.sum) + '</div>' +
      (kpis ? '<div class="kpi-row">' + kpis + '</div>' : '') +
      verify +
      '<div class="stock-chips">' + chips +
        '<span class="senti ' + sentiCls[it.st] + '">情感：' + sentiTxt[it.st] + '</span>' +
        '<span class="senti" style="margin-left:8px">热度 ' + Math.round(it.heat) + '</span>' + relNote +
      '</div>' +
    '</article>';
  }

  /* ---------- 渲染主区 ---------- */
  var hotTop = function () {
    var s = items.slice().sort(function (a, b) { return b.heat - a.heat; }).slice(0, 3).map(function (x) { return x.id; });
    return s;
  };
  function renderFeed() {
    var list = filtered();
    var el = $('feed');
    el.innerHTML = list.map(function (it) { return cardHTML(it, hotTop()); }).join('');
    $('feedEmpty').classList.toggle('hidden', list.length > 0);
    var parts = [];
    if (state.type !== '全部') parts.push(state.type);
    if (state.market !== '全部') parts.push(state.market);
    if (state.ind !== '全部') parts.push(state.ind);
    if (state.onlyImportant) parts.push('只看重要');
    $('feedTitle').textContent = (parts.length ? parts.join(' / ') : '实时信息流') + ' · 共 ' + list.length + ' 条（时间倒序）';
  }

  /* ---------- 重要消息（FR-06） ---------- */
  function renderImportant() {
    var list = items.filter(function (it) { return it.imp && it.t !== '传闻'; })
      .sort(function (a, b) { return b.hd - a.hd; }).slice(0, 6);
    $('importantList').innerHTML = list.map(function (it) {
      return '<li class="mini-item" data-act="card" data-id="' + it.id + '">' +
        '<div class="mi-meta"><span class="type-badge t-' + it.t + '">' + it.t + '</span>' +
        '<span>' + esc(it.src) + '</span><span>' + fmtRel(it.ts) + '</span>' +
        '<span class="up-tag">▲ +' + it.hd.toFixed(1) + '/5min</span></div>' +
        '<div class="mi-title">' + esc(it.ti) + '</div></li>';
    }).join('') || '<li style="color:var(--muted);font-size:12px">暂无</li>';
  }

  /* ---------- 热点榜（FR-07 / DP-4） ---------- */
  function windowOf(ts) {
    if (Date.now() - ts < 120 * 60e3) return 'realtime';
    if (isToday(ts)) return 'today';
    return 'week';
  }
  function renderHot() {
    var list = items.filter(function (it) { return windowOf(it.ts) === state.hot || state.hot === 'week'; })
      .sort(function (a, b) { return state.hot === 'realtime' ? (b.heat + b.hd * 2) - (a.heat + a.hd * 2) : b.heat - a.heat; })
      .slice(0, 8);
    var lbl = { realtime: '实时（近2小时）', today: '今日', week: '近7日' };
    $('hotList').innerHTML = list.map(function (it) {
      var up = it.hd > 0 ? '<span class="up-tag"> ▲' + it.hd.toFixed(1) + '</span>' : '';
      return '<li data-act="card" data-id="' + it.id + '">' + esc(it.ti) +
        '<span class="hm">' + esc(it.t) + ' · ' + esc(it.src) + ' · 热度 ' + Math.round(it.heat) + up + ' · ' + fmtRel(it.ts) + '</span></li>';
    }).join('') || '<li>暂无</li>';
  }

  /* ---------- 自选股（FR-05 / FR-17 行情） ---------- */
  function renderWatch() {
    var rows = watch.map(function (code) {
      var s = findStock(code);
      if (!s) return '';
      var cg = s.chg, cls = cg > 0 ? 'up-c' : (cg < 0 ? 'down-c' : '');
      var abn = '';
      if (cg >= 9.9) abn = ' <span class="flag abn">涨停</span>';
      else if (cg <= -9.9) abn = ' <span class="flag abn">跌停</span>';
      else if (Math.abs(cg) >= 5) abn = ' <span class="flag abn">异动</span>';
      return '<li class="watch-item" data-act="watch-open" data-code="' + code + '">' +
        '<span>🔔</span><div><div class="w-name">' + esc(s.name) + abn + '</div>' +
        '<div class="w-code">' + code + ' · ' + esc(s.ind) + '</div></div>' +
        '<span class="w-chg ' + cls + '">' + fmtChg(cg) + '</span>' +
        '<button class="w-del" data-act="watch-del" data-code="' + code + '" title="取消订阅">×</button></li>';
    }).join('');
    $('watchList').innerHTML = rows || '<li class="watch-tip">暂无自选，从资讯中的股票标签或上方输入框添加。</li>';
  }
  function addWatch(code) {
    if (watch.indexOf(code) >= 0) { toast('已在自选股中', 'info'); return; }
    if (!findStock(code)) { toast('未找到该演示标的', 'warn'); return; }
    watch.push(code); saveLS('fn_watch', watch); renderWatch();
    toast('已添加 ' + FN.stockName(code) + ' 并订阅重要消息推送（模拟）', 'ok');
  }

  /* ---------- 个股主页（FR-04） ---------- */
  function openStock(code) {
    var s = findStock(code);
    if (!s) { toast('未找到标的', 'warn'); return; }
    var cg = s.chg, cls = chgCls(cg);
    var tags = [];
    if (cg >= 9.9) tags.push('⚡涨停');
    else if (cg <= -9.9) tags.push('⚡跌停');
    else if (Math.abs(cg) >= 5) tags.push('⚡异动');
    var rel = items.filter(function (it) { return it.codes && it.codes.indexOf(code) >= 0; });
    var impCount = rel.filter(function (it) { return it.imp && it.t !== '传闻'; }).length;
    var cnt = { '公告': 0, '快讯': 0, '深度': 0, '传闻': 0 };
    rel.forEach(function (it) { if (cnt[it.t] != null) cnt[it.t]++; });
    var pos = rel.filter(function (it) { return it.st === 'up'; }).length;
    var neg = rel.filter(function (it) { return it.st === 'down'; }).length;
    var neu = rel.length - pos - neg;
    var subOn = watch.indexOf(code) >= 0;
    var listHTML = rel.slice(0, 8).map(function (it) {
      return cardHTML(it, null);
    }).join('');
    var tabs = ['公告', '快讯', '深度', '传闻'];
    openModal(
      '<button class="m-close" data-act="close-modal" title="关闭">×</button>' +
      '<div class="stock-hero">' +
        '<div><div class="sh-name">' + esc(s.name) + '</div><div class="sh-code">' + code + ' · ' + esc(s.ind) + '（演示标的，行情为模拟）</div></div>' +
        '<div><div class="sh-quote ' + cls + '">' + (s.base * (1 + cg / 100)).toFixed(2) + '</div>' +
        '<div class="sh-chg ' + cls + '">' + fmtChg(cg) + '</div></div>' +
        '<div style="margin-left:auto;text-align:right">' + (tags.map(function (t) { return '<span class="flag abn" style="font-size:12px">' + t + '</span>'; }).join(' ') || '<span class="src-tag">无异动</span>') +
        '<div style="margin-top:8px"><button class="btn ' + (subOn ? 'btn-ghost' : 'btn-primary') + ' btn-sm" data-act="watch-toggle" data-code="' + code + '">' +
        (subOn ? '✓ 已订阅（企微推送）' : '🔔 订阅推送') + '</button></div></div>' +
      '</div>' +
      '<div class="stock-stats">' +
        '<span>近7日相关资讯 <b>' + rel.length + '</b> 条</span>' +
        '<span>重要消息 <b>' + impCount + '</b> 条</span>' +
        '<span>公告 <b>' + cnt['公告'] + '</b>｜快讯 <b>' + cnt['快讯'] + '</b>｜深度 <b>' + cnt['深度'] + '</b>｜传闻 <b>' + cnt['传闻'] + '</b></span>' +
        '<span>情感分布：<span class="up-c">偏多 ' + pos + '</span> / <span class="down-c">偏空 ' + neg + '</span> / <span class="neu">中性 ' + neu + '</span></span>' +
        (pos ? '<span><span class="bar" style="background:#d92d20;width:' + (pos / rel.length * 60) + 'px"></span></span>' : '') +
      '</div>' +
      '<p style="font-size:12px;color:var(--muted)">以下为该标的相关资讯（自动关联，对应 DP-5 关联个股；行情延时 15–30s，对应 DR-12）。</p>' +
      '<div class="mini-tabs">' + tabs.map(function (tb) {
        return '<button class="mini-tab ' + (tb === '公告' ? 'active' : '') + '" data-act="stock-tab" data-code="' + code + '" data-tab="' + tb + '">' + tb + '（' + cnt[tb] + '）</button>';
      }).join('') + '<button class="mini-tab" data-act="stock-tab" data-code="' + code + '" data-tab="全部">全部（' + rel.length + '）</button></div>' +
      '<div id="stockList">' + rel.slice(0, 6).map(function (it) { return cardHTML(it, null); }).join('') + '</div>' +
      '<div style="margin-top:10px" class="disclaimer-box">演示环境：个股相关资讯为模拟数据聚合，不构成投资建议。</div>'
    );
    $('stockList').dataset.code = code;
  }
  function stockTab(code, tb) {
    var rel = items.filter(function (it) { return it.codes && it.codes.indexOf(code) >= 0 && (tb === '全部' || it.t === tb); });
    $('stockList').innerHTML = rel.length ? rel.map(function (it) { return cardHTML(it, null); }).join('') : '<div class="empty">该分类暂无内容</div>';
    document.querySelectorAll('#modalBox .mini-tab').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === tb);
    });
  }

  /* ---------- 详情页（FR-10） ---------- */
  function openDetail(id) {
    var it = items.find(function (x) { return x.id === id; });
    if (!it) return;
    var chips = (it.codes || []).map(function (c) {
      var s = findStock(c); var cg = s ? s.chg : 0;
      return '<span class="stock-chip" data-act="stock" data-code="' + c + '">' + esc(s ? s.name : c) +
        ' <span class="' + (cg > 0 ? 'chg-up' : (cg < 0 ? 'chg-down' : '')) + '">' + fmtChg(cg) + '</span></span>';
    }).join('');
    var kpis = (it.kpis || []).map(function (k) { return '<span class="kpi">' + esc(k) + '</span>'; }).join('');
    var body = (it.body || it.sum || '').split('\n\n').map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('');
    var relNote = '';
    if (it.rel && it.rel.length) {
      relNote = '<div class="related-box"><b>多源去重（DP-1）</b>：本事件共 ' + (it.rel.length + 1) + ' 家来源报道，已合并为一条主记录（保留权威源）。' +
        it.rel.map(function (r) { return '<div class="rel-item">↳ 相关报道：' + esc(r) + '</div>'; }).join('') + '</div>';
    }
    var rumor = it.t === '传闻' ? '<div class="disclaimer-box">⚠️ <b>未经证实</b>：本条为社交媒体传闻，来源：' + esc(it.src) + '，内容未获公司或官方信源确认，仅作辅助参考，<b>不作为投资依据</b>；平台默认不对此类消息推送。（COM-4）</div>' : '';
    var verify = '';
    if (it.t === '传闻') {
      var v = verifyItemOf(it);
      if (v) verify = '<div class="related-box"><b>求证联动（FR-08）</b>：相关澄清公告 —— <a class="link-like" data-act="card" data-id="' + v.id + '">' + esc(v.ti) + '</a></div>';
    }
    var abn = '';
    if (it.codes) {
      var mx = 0;
      it.codes.forEach(function (c) { var s = findStock(c); if (s) mx = Math.max(mx, Math.abs(s.chg)); });
      if (mx >= 5) abn = '<p style="font-size:12px;color:#c01048">⚡ 行情联动提示（DP-7）：关联标的存在显著异动，已参与热度加权' + (mx >= 9.9 ? '（涨停/跌停级）' : '') + '。</p>';
    }
    openModal(
      '<button class="m-close" data-act="close-modal" title="关闭">×</button>' +
      '<div class="m-meta"><span class="type-badge t-' + it.t + '">' + it.t + '</span>' +
      (it.ann ? '<span class="type-badge t-公告">' + esc(it.ann) + '</span>' : '') +
      '<span class="src-tag">' + esc(it.src) + '</span>' +
      (it.m !== 'A股' ? '<span class="src-tag">' + esc(it.m) + '</span>' : '') +
      (it.ind && it.ind !== '宏观' ? '<span class="src-tag">' + esc(it.ind) + '</span>' : '') +
      '<span>发布于 ' + fmtClock(it.ts) + ' · ' + fmtRel(it.ts) + '</span>' +
      '<span class="senti ' + sentiCls[it.st] + '" style="margin-left:auto">情感：' + sentiTxt[it.st] + '</span></div>' +
      '<div class="m-title">' + esc(it.ti) + '</div>' +
      (kpis ? '<div class="kpi-row">' + kpis + '</div>' : '') + abn +
      '<div class="m-body">' + body + '</div>' + rumor + verify + relNote +
      '<div class="stock-chips">' + chips + '</div>' +
      '<p style="font-size:11.5px;color:var(--muted);margin-top:10px">原文链接：<a href="#" onclick="return false" style="color:var(--muted)">' + esc(it.src) + '（演示占位）</a> · 演示数据</p>'
    );
  }

  /* ---------- 模态 ---------- */
  function openModal(html) {
    $('modalBox').innerHTML = '<div class="modal-inner">' + html + '</div>';
    $('modalBox').classList.remove('hidden');
    $('modalMask').classList.remove('hidden');
    $('modalBox').scrollTop = 0;
  }
  function closeModal() { $('modalBox').classList.add('hidden'); $('modalMask').classList.add('hidden'); }

  /* ---------- 企微推送（FR-09）模拟 ---------- */
  function openDrawer() {
    $('pushDrawer').classList.remove('hidden');
    $('pushMask').classList.remove('hidden');
    renderPush();
  }
  function closeDrawer() { $('pushDrawer').classList.add('hidden'); $('pushMask').classList.add('hidden'); }

  function addPush(item, status, target, when) {
    var p = {
      id: uid(), ts: when || Date.now(), title: item.ti, type: item.t, newsId: item.id,
      target: target || FN.PUSH_TARGETS[pushTargetIdx++ % FN.PUSH_TARGETS.length],
      status: status || 'ok', codes: item.codes || []
    };
    pushLog.unshift(p);
    renderPush();
    updateBadge();
  }
  function pushTitle(p) {
    var rel = p.codes.map(FN.stockName);
    return p.title + (rel.length ? '（涉及：' + rel.join('、') + '）' : '');
  }
  function renderPush() {
    $('pushList').innerHTML = pushLog.map(function (p) {
      var cls = p.status === 'ok' ? 'ok' : (p.status === 'dedupe' ? 'dedupe' : '');
      var st = p.status === 'ok' ? '已送达' : (p.status === 'dedupe' ? '去重合并 · 同事件仅推1条' : '失败·重试中');
      return '<li class="push-item ' + cls + '" data-act="push-open" data-id="' + p.newsId + '">' +
        '<div class="pi-head"><span>💬 企业微信 · ' + esc(p.target) + '</span><span>' + fmtClock(p.ts) + '</span><span class="pi-status" style="margin-left:auto">' + st + '</span></div>' +
        '<div class="pi-body"><div class="pi-title">' + esc(p.title) + '</div>' +
        '<div class="pi-line">' + esc(p.type) + ' · 点击打开详情</div></div>' +
        '<div class="pi-foot"><span>模板：标题+摘要+关联标的+原文链接</span><span>频控：5min/标的</span></div></li>';
    }).join('') || '<li style="color:var(--muted);font-size:12.5px;padding:8px">暂无推送记录。重要消息判定后会自动触发（模拟）。</li>';
  }
  function updateBadge() {
    var unread = pushLog.filter(function (p) { return p.status === 'ok' && readPushes.indexOf(p.id) < 0; }).length;
    ['pushBadge', 'pushBadgeFab'].forEach(function (b) {
      var el = $(b);
      el.textContent = unread;
      el.classList.toggle('hidden', unread === 0);
    });
  }
  function markAllRead() {
    pushLog.forEach(function (p) { if (readPushes.indexOf(p.id) < 0) readPushes.push(p.id); });
    saveLS('fn_readPush', readPushes);
    updateBadge(); renderPush();
  }
  function triggerPush() {
    var cand;
    if (queue.length) { cand = queue.shift(); }
    else {
      cand = items.filter(function (x) { return x.imp && x.t !== '传闻'; }).sort(function () { return Math.random() - 0.5; })[0];
    }
    if (!cand) { toast('暂无可推送内容', 'warn'); return; }
    if (cand.ts === undefined) { // 来自 FN.SCHEDULED
      cand.ts = Date.now();
      items.unshift(cand);
      renderFeed(); renderImportant(); renderHot();
    }
    addPush(cand, 'ok');
    toast('已模拟推送至企业微信：「' + cand.ti.slice(0, 18) + '…」', 'ok');
  }

  /* ---------- Toast ---------- */
  function toast(msg, kind) {
    var t = document.createElement('div');
    t.className = 'toast ' + (kind || '');
    t.textContent = msg;
    $('toasts').appendChild(t);
    setTimeout(function () { t.remove(); }, 3800);
  }

  /* ---------- 搜索（FR-03） ---------- */
  function doSearch(q) {
    q = (q || '').trim();
    var box = $('searchResults');
    if (!q) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    var lq = q.toLowerCase();
    var stocks = FN.STOCKS.filter(function (s) {
      return s.name.indexOf(q) >= 0 || s.code.indexOf(lq) >= 0 || s.ind.indexOf(q) >= 0;
    }).slice(0, 5);
    var news = items.filter(function (it) {
      return (it.ti + ' ' + it.sum + ' ' + (it.body || '') + ' ' + it.src).indexOf(q) >= 0 ||
        (it.codes || []).some(function (c) { var s = findStock(c); return s && (s.name.indexOf(q) >= 0 || c.indexOf(lq) >= 0); });
    }).slice(0, 6);
    var h = '';
    if (stocks.length) {
      h += '<div class="sr-group">标的（演示）</div>' + stocks.map(function (s) {
        var cls = s.chg > 0 ? 'up-c' : (s.chg < 0 ? 'down-c' : '');
        return '<div class="sr-item" data-act="stock" data-code="' + s.code + '">' +
          '<span class="sr-type" style="background:#e8f0fe;color:#2563eb">标的</span>' +
          '<span>' + esc(s.name) + '</span><span class="sr-code">' + s.code + ' · ' + esc(s.ind) + '</span>' +
          '<span class="' + cls + '">' + fmtChg(s.chg) + '</span></div>';
      }).join('');
    }
    if (news.length) {
      h += '<div class="sr-group">资讯（近7日）</div>' + news.map(function (it) {
        return '<div class="sr-item" data-act="card" data-id="' + it.id + '">' +
          '<span class="sr-type t-' + it.t + '" style="background:#f1f4f9;color:#475467">' + it.t + '</span>' +
          '<span class="sr-title">' + esc(it.ti.slice(0, 36)) + (it.ti.length > 36 ? '…' : '') + '</span>' +
          '<span class="sr-time">' + fmtRel(it.ts) + '</span></div>';
      }).join('');
    }
    if (!h) h = '<div class="sr-item" style="color:var(--muted)">未找到相关内容（演示数据范围：近 7 日）</div>';
    box.innerHTML = h;
    box.classList.remove('hidden');
  }

  /* ---------- 实时时钟 / 交易状态 ---------- */
  function tick() {
    $('clockTime').textContent = fmtClock(Date.now());
    var d = new Date(); var day = d.getDay(); var hm = d.getHours() * 60 + d.getMinutes();
    var trading = day >= 1 && day <= 5 &&
      ((hm >= 9 * 60 + 30 && hm <= 11 * 60 + 30) || (hm >= 13 * 60 && hm <= 15 * 60));
    var el = $('marketState');
    el.textContent = trading ? '交易中' : '已收盘/休市';
    el.classList.toggle('closed', !trading);
  }

  /* ---------- 行情抖动（模拟延时行情刷新，DR-12） ---------- */
  function jitterQuotes() {
    FN.STOCKS.forEach(function (s) {
      if (s.code === '688988' && Math.random() < 0.35) { s.chg = clamp(s.chg, 9.9, 10.05); return; }
      s.chg = clamp(s.chg + (Math.random() - 0.5) * 0.7, -10.5, 10.05);
    });
    renderWatch();
    // 若详情/个股页正打开股票，刷新其报价
    var cur = document.querySelector('#modalBox .sh-name');
    if (cur) { var code = $('stockList') && $('stockList').dataset.code; if (code) { var s2 = findStock(code); if (s2 && document.querySelector('#modalBox .sh-quote')) openStock(code); } }
  }

  /* ---------- 模拟实时增量（FR-01 实时性演示） ---------- */
  function scheduleArrivals() {
    setTimeout(arrive, 12000);
    var iv = setInterval(function () { if (!queue.length) clearInterval(iv); else arrive(); }, 75000);
  }
  function arrive() {
    if (!queue.length) return;
    var it = queue.shift();
    it.ts = Date.now();
    items.unshift(it);
    renderFeed(); renderImportant(); renderHot();
    toast('⚡ 新快讯到达：' + it.ti.slice(0, 26) + '…', 'info');
    if (it.imp && it.t !== '传闻') addPush(it, it.rel && it.rel.length ? 'dedupe' : 'ok');
  }
  function seedPushes() {
    var seeds = items.filter(function (x) { return x.imp && x.t !== '传闻'; })
      .sort(function (a, b) { return b.hd - a.hd; }).slice(0, 4);
    var statuses = ['ok', 'ok', 'ok', 'dedupe'];
    var delays = [1500, 4500, 8000, 12000];
    seeds.forEach(function (s, i) {
      setTimeout(function () {
        addPush(s, statuses[i] || 'ok');
        if (i === 0) toast('💬 已模拟推送重要消息至企业微信，点击右上角「💬 企微推送」查看', 'info');
      }, delays[i]);
    });
  }

  /* ---------- 初始化 ---------- */
  function initIndustry() {
    var sel = $('industrySel');
    FN.INDUSTRIES.forEach(function (ind) {
      var o = document.createElement('option');
      o.value = ind; o.textContent = ind;
      sel.appendChild(o);
    });
  }

  function initEvents() {
    // 类型 Tab
    document.querySelectorAll('#typeTabs .tab').forEach(function (b) {
      b.addEventListener('click', function () {
        state.type = b.dataset.type;
        document.querySelectorAll('#typeTabs .tab').forEach(function (x) { x.classList.toggle('active', x === b); });
        renderFeed();
      });
    });
    // 市场
    document.querySelectorAll('#marketChips .chip').forEach(function (b) {
      b.addEventListener('click', function () {
        state.market = b.dataset.market;
        document.querySelectorAll('#marketChips .chip').forEach(function (x) { x.classList.toggle('active', x === b); });
        renderFeed();
      });
    });
    $('industrySel').addEventListener('change', function () {
      state.ind = this.value; renderFeed();
    });
    $('onlyImportant').addEventListener('change', function () {
      state.onlyImportant = this.checked; renderFeed();
    });
    $('btnClearFilters').addEventListener('click', function () {
      state.type = '全部'; state.market = '全部'; state.ind = '全部'; state.onlyImportant = false;
      document.querySelectorAll('#typeTabs .tab, #marketChips .chip').forEach(function (x) { x.classList.toggle('active', x.dataset.type === '全部' || x.dataset.market === '全部'); });
      $('industrySel').value = '全部'; $('onlyImportant').checked = false;
      renderFeed();
    });
    // 热点榜 tab
    document.querySelectorAll('#hotTabs .seg-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        state.hot = b.dataset.hot;
        document.querySelectorAll('#hotTabs .seg-btn').forEach(function (x) { x.classList.toggle('active', x === b); });
        renderHot();
      });
    });
    // 抽屉 & 悬浮
    $('btnOpenPush').addEventListener('click', openDrawer);
    $('pushFab').addEventListener('click', openDrawer);
    $('pushClose').addEventListener('click', closeDrawer);
    $('pushMask').addEventListener('click', closeDrawer);
    $('btnTriggerPush').addEventListener('click', triggerPush);
    $('btnMarkRead').addEventListener('click', markAllRead);
    // 搜索
    $('searchInput').addEventListener('input', function () { doSearch(this.value); });
    $('searchInput').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var q = this.value.trim();
      if (!q) return;
      var st = FN.STOCKS.find(function (s) { return s.name.indexOf(q) >= 0 || s.code.indexOf(q) >= 0; });
      var nw = items.find(function (it) { return (it.ti + it.sum).indexOf(q) >= 0; });
      if (st) { openStock(st.code); }
      else if (nw) { openDetail(nw.id); }
      else toast('未找到匹配内容', 'warn');
      $('searchResults').classList.add('hidden');
    });
    document.addEventListener('click', function (e) {
      var box = $('searchResults');
      if (!e.target.closest('.search-wrap')) { box.classList.add('hidden'); }
    });
    // 自选添加
    function addFromInput() {
      var v = $('watchAddInput').value.trim();
      if (!v) return;
      var s = FN.STOCKS.find(function (x) { return x.code.indexOf(v) >= 0 || x.name.indexOf(v) >= 0; });
      if (s) { addWatch(s.code); $('watchAddInput').value = ''; }
      else toast('未找到该演示标的（可试试 华芯/澜湾/天工）', 'warn');
    }
    $('watchAddBtn').addEventListener('click', addFromInput);
    $('watchAddInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') addFromInput(); });
    // 关于
    $('btnAbout').addEventListener('click', openAbout);
    $('btnAbout2').addEventListener('click', openAbout);
    $('bannerClose').addEventListener('click', function () { $('demoBanner').style.display = 'none'; });
    // 弹层关闭
    $('modalMask').addEventListener('click', closeModal);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeModal(); closeDrawer(); }
    });
  }

  /* 动态元素委托（data-act） */
  function initDelegation() {
    document.addEventListener('click', function (e) {
      var t = e.target.closest('[data-act]');
      if (!t) return;
      var act = t.dataset.act;
      var id = t.dataset.id, code = t.dataset.code;
      if (act === 'card') { openDetail(id); }
      else if (act === 'stock') { e.stopPropagation(); openStock(code); }
      else if (act === 'watch-open') { openStock(code); }
      else if (act === 'watch-del') {
        watch = watch.filter(function (c) { return c !== code; });
        saveLS('fn_watch', watch); renderWatch();
        toast('已取消订阅 ' + FN.stockName(code), 'info');
      }
      else if (act === 'watch-toggle') {
        if (watch.indexOf(code) >= 0) {
          watch = watch.filter(function (c) { return c !== code; });
          toast('已取消订阅推送（模拟）', 'info');
        } else { watch.push(code); toast('已订阅推送（模拟）', 'ok'); }
        saveLS('fn_watch', watch); renderWatch(); openStock(code);
      }
      else if (act === 'stock-tab') { stockTab(code, t.dataset.tab); }
      else if (act === 'verify') { openDetail(id); }
      else if (act === 'push-open') { if (id) openDetail(id); }
      else if (act === 'close-modal') { closeModal(); }
    });
  }

  /* 关于/需求对照 模态 */
  function openAbout() {
    var frRows = [
      ['实时信息流（含"实时到达"模拟）', 'FR-01', '已实现'],
      ['分类筛选：类型/市场/行业 + 只看重要', 'FR-02/DP-2', '已实现'],
      ['全文搜索：标题/正文/代码/简称联想', 'FR-03', '已实现（近7日）'],
      ['个股主页：公告/新闻/传闻/情感聚合', 'FR-04', '已实现'],
      ['自选股订阅（localStorage 持久化）', 'FR-05', '已实现'],
      ['重要消息甄别与置顶高亮', 'FR-06/DP-4', '已实现（规则+热度上升）'],
      ['热点榜：实时/当日/近7日', 'FR-07', '已实现（演示热度）'],
      ['传闻管理："未经证实"标识+澄清对照', 'FR-08/COM-4', '已实现'],
      ['企业微信推送（模拟送达/去重/频控）', 'FR-09', '模拟实现'],
      ['详情页：正文/来源/相关报道(去重)', 'FR-10/DP-1', '已实现'],
      ['公告结构化要点（业绩预告/回购等）', 'FR-11', '已实现（演示）'],
      ['行情联动：涨停/异动标注与热度加权', 'FR-17/DP-7/DR-12', '已实现（延时模拟行情）'],
      ['延时行情刷新（15–30s 抖动）', 'NFR-12', '已实现（模拟）']
    ];
    var backRows = [
      ['真实多源采集 Adapter（财联社/巨潮等）', 'DR-01~11', '需后端'],
      ['SimHash 内容级去重 / 情感模型 / 行业分类', 'DP-1/2/3', '需后端'],
      ['真实企微 Webhook/应用消息发送', 'FR-09(线上)', '需后端+凭据'],
      ['用户注册与云端自选同步', 'FR-13', '待立项(P1)'],
      ['后台管理：词典/规则/推送日志', 'FR-12', '待立项(P1)'],
      ['定时摘要早报/晚报', 'FR-15', '待立项(P2)']
    ];
    function table(rows) {
      return '<table><tr><th>能力</th><th>需求编号</th><th>状态</th></tr>' +
        rows.map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td><span class="frv">' + esc(r[1]) + '</span></td><td>' + esc(r[2]) + '</td></tr>'; }).join('') + '</table>';
    }
    openModal(
      '<button class="m-close" data-act="close-modal">×</button>' +
      '<div class="abt"><h3 style="margin-top:2px">关于本原型与需求对照</h3>' +
      '<p style="color:var(--muted);font-size:13px">页面依据《项目需求.md》v1.1 制作。共 ' + items.length + ' 条模拟资讯、' + FN.STOCKS.length + ' 个演示标的。</p>' +
      '<div class="disclaimer-box">' + FN.ABOUT.demo + '</div>' +
      '<h4>1. 已在本页落地（前端交互）</h4>' + table(frRows) +
      '<h4>2. 依赖后端/真实数据的部分（本原型为模拟）</h4>' + table(backRows) +
      '<h4>3. 数据保留策略（R-1）</h4><p style="font-size:13px">' + FN.ABOUT.retention + '</p>' +
      '<h4>4. 演示数据源</h4><div class="src-list">' +
      ['财联社', '华尔街见闻', '东方财富', '同花顺', '巨潮资讯网', '上交所/深交所公告', 'Finnhub(模拟)', '雪球热帖', '微博财经'].map(function (s) { return '<span>' + esc(s) + '</span>'; }).join('') +
      '</div>' +
      '<h4>5. 合规声明（COM-1~9）</h4>' +
      '<p style="font-size:12.5px">· 演示环境不抓取真实内容，不镜像第三方正文；<br>· 传闻均带"未经证实"标识、不推送、低权重；<br>· 本页面为资讯聚合演示，<b>不构成任何投资建议</b>；<br>· 若上线真实服务，需按 COM-1~9 逐项落实数据授权与合规评审。</p>' +
      '</div>'
    );
  }

  /* ---------- 启动 ---------- */
  function boot() {
    initIndustry();
    initEvents();
    initDelegation();
    tick(); setInterval(tick, 1000);
    setInterval(jitterQuotes, 12000);
    renderFeed(); renderImportant(); renderHot(); renderWatch();
    seedPushes();
    scheduleArrivals();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else { boot(); }
})();
