/* ============================================================
 * 财讯雷达 · 真实数据后端（本机 Node 服务）
 * 数据源：
 *  - 快讯：新浪财经 7x24 直播 / 新浪财经滚动（国内+国际）
 *  - 公告：巨潮资讯网（cninfo 官方公告检索，szse/sse）
 *  - 传闻：真实媒体中"传/曝/知情人士/网传"类标题（如实标注未经证实）；
 *          雪球/微博直连需登录授权，本版本不接入（meta.sources.social.ok=false）
 *  - 行情/分时：东方财富 push2delay（备用域）
 *  - 日K：腾讯证券（备选：新浪行情）
 * 合规：内容版权归原平台，仅展示标题/摘要并保留原文链接；本项目演示自用。
 * ============================================================ */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');          // 工作区根
const WEB = path.join(ROOT, 'web');
const PORT = Number(process.env.PORT || 8899);
const RETENTION_MS = 7 * 24 * 3600 * 1000;            // R-1：正文在线保留 7 天
const MAX_ITEMS = 5000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const fet = (url, opts = {}) => fetch(url, Object.assign({ headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(9000) }, opts));

/* ---------------- 工具 ---------------- */
function esc(s) { return String(s == null ? '' : s); }
function normTitle(t) {
  return esc(t).toLowerCase().replace(/[\s，。！？、；：""''（）()【】\[\]·—…,.!?;:]/g, '');
}
function stripHtml(s) { return esc(s).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim(); }
function clip(s, n) { s = stripHtml(s); return s.length > n ? s.slice(0, n) + '…' : s; }
function hashKey(t) { let h = 2166136261; for (const c of normTitle(t)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
function fmtKBuf(buf) { try { return new TextDecoder('gbk').decode(buf); } catch { return buf.toString('utf8'); } }
async function textOf(r) { return fmtKBuf(Buffer.from(await r.arrayBuffer())); }
function marketOf(code) {
  if (/^[69]/.test(code)) return 'sh';
  if (/^[023]/.test(code)) return 'sz';
  return 'bj';
}
function secidOf(code) { const m = marketOf(code); return (m === 'sh' ? 1 : 0) + '.' + code; }

/* ---------------- 社交源与推送配置（设置页 / 环境变量 / server/cookies.json） ----------------
 * 三者读取优先级（引导时）：环境变量 XUEQIU_COOKIE / WEIBO_COOKIE / WECOM_WEBHOOK > server/cookies.json
 * 页面「设置」提交后即时更新内存并持久化到 server/cookies.json（已 gitignore），无需重启。
 * Cookie/Webhook 等同账号凭证，切勿提交或外传。
 */
const COOKIE_FILE = path.join(__dirname, 'cookies.json');
function loadCookieFile() { try { if (fs.existsSync(COOKIE_FILE)) return JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8')); } catch (e) { console.warn('[cookies.json] 解析失败:', e.message); } return {}; }
const CFG_COOKIES = loadCookieFile();
let XQ_COOKIE = process.env.XUEQIU_COOKIE || CFG_COOKIES.xueqiu || '';
let WB_COOKIE = process.env.WEIBO_COOKIE || CFG_COOKIES.weibo || '';
let wecomWebhook = process.env.WECOM_WEBHOOK || CFG_COOKIES.wecom || '';
const SOCIAL = {
  xueqiu: { configured: !!XQ_COOKIE, ok: false, last: 0, err: XQ_COOKIE ? null : '未配置 Cookie' },
  weibo:  { configured: !!WB_COOKIE, ok: false, last: 0, err: WB_COOKIE ? null : '未配置 Cookie' }
};
const SOCIAL_GUIDE = '在页面「⚙ 设置」中粘贴从浏览器登录后复制的完整 Cookie 字符串即可（无需重启）；也可设环境变量 XUEQIU_COOKIE / WEIBO_COOKIE 或写入 server/cookies.json。';
function persistCookies() {
  try {
    const obj = Object.assign(loadCookieFile(), { xueqiu: XQ_COOKIE, weibo: WB_COOKIE, wecom: wecomWebhook });
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) { console.warn('[cookies.json] 写入失败:', e.message); }
}
function applySettings(body) {
  const changed = {};
  if (body && Object.prototype.hasOwnProperty.call(body, 'xueqiu')) { XQ_COOKIE = body.xueqiu ? String(body.xueqiu) : ''; SOCIAL.xueqiu.configured = !!XQ_COOKIE; SOCIAL.xueqiu.last = 0; SOCIAL.xueqiu.ok = false; SOCIAL.xueqiu.err = XQ_COOKIE ? null : '未配置 Cookie'; changed.xueqiu = 1; }
  if (body && Object.prototype.hasOwnProperty.call(body, 'weibo')) { WB_COOKIE = body.weibo ? String(body.weibo) : ''; SOCIAL.weibo.configured = !!WB_COOKIE; SOCIAL.weibo.last = 0; SOCIAL.weibo.ok = false; SOCIAL.weibo.err = WB_COOKIE ? null : '未配置 Cookie'; changed.weibo = 1; }
  if (body && Object.prototype.hasOwnProperty.call(body, 'wecom')) { wecomWebhook = body.wecom ? String(body.wecom) : ''; changed.wecom = 1; }
  if (Object.keys(changed).length) persistCookies();
  return changed;
}

/* ---------------- 证券代码→公司词典（东方财富沪深A股全列表） ---------------- */
const universe = new Map();   // code -> {code,name,ind}
let universeReady = false;

async function loadUniverse() {
  universe.clear();
  const fsParam = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048'; // 沪深主板/创业/科创 + 北交所
  let pn = 1, got = 0, total = 0;
  while (pn <= 80) {
    const url = `https://push2delay.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f12&fs=${encodeURIComponent(fsParam)}&fields=f12,f13,f14,f100`;
    const r = await fet(url);
    const j = await r.json();
    const data = j.data || {};
    if (!total) total = data.total || 0;
    const diff = data.diff || [];
    if (!diff.length) break;
    for (const d of diff) if (d && d.f12) universe.set(String(d.f12), { code: String(d.f12), name: esc(d.f14 || ''), ind: esc(d.f100 || '') });
    got += diff.length;
    pn++;
    if (total && got >= total) break;
    if (diff.length < 100 && !total) break;
    await new Promise(res => setTimeout(res, 80));
  }
  universeReady = universe.size > 1000;
  console.log(`[universe] loaded ${universe.size} A股标的 (ready=${universeReady})`);
}

/* 常见简称 → 代码（新闻报道常用短称，补齐代码正则抓不到的） */
const ALIAS = {
  '茅台': '600519', '五粮液': '000858', '泸州老窖': '000568', '山西汾酒': '600809',
  '宁德时代': '300750', '比亚迪': '002594', '中芯国际': '688981', '中芯': '688981',
  '隆基绿能': '601012', '通威股份': '600438', '阳光电源': '300274', '亿纬锂能': '300014',
  '赣锋锂业': '002460', '天齐锂业': '002466', '华友钴业': '603799',
  '招商银行': '600036', '兴业银行': '601166', '平安银行': '000001', '宁波银行': '002142',
  '中国平安': '601318', '中国人寿': '601628', '中信证券': '600030', '东方财富': '300059',
  '华泰证券': '601688', '国泰君安': '601211',
  '贵州茅台': '600519', '恒瑞医药': '600276', '药明康德': '603259', '迈瑞医疗': '300760',
  '爱尔眼科': '300015', '京东方': '000725', '立讯精密': '002475', '韦尔股份': '603501',
  '兆易创新': '603986', '北方华创': '002371', '中微公司': '688012', '海光信息': '688041',
  '寒武纪': '688256', '金山办公': '688111', '科大讯飞': '002230', '三六零': '601360',
  '汇川技术': '300124', '工业富联': '601138', '中兴通讯': '000063', '紫金矿业': '601899',
  '洛阳钼业': '603993', '中远海控': '601919', '万华化学': '600309', '海尔智家': '600690',
  '美的集团': '000333', '格力电器': '000651', '长江电力': '600900', '中国神华': '601088',
  '陕西煤业': '601225', '牧原股份': '002714', '温氏股份': '300498', '海天味业': '603288',
  '金龙鱼': '300999', '伊利股份': '600887', '双汇发展': '000895', '工商银行': '601398',
  '农业银行': '601288', '建设银行': '601939', '中国银行': '601988', '交通银行': '601328',
  '邮储银行': '601658', '浦发银行': '600000', '民生银行': '600016', '中信银行': '601998',
  '中国石油': '601857', '中国石化': '600028', '中国海油': '600938', '中国移动': '600941',
  '中国电信': '601728', '中国联通': '600050', '中国建筑': '601668', '中国中免': '601888',
  '三一重工': '600031', '中联重科': '000157', '徐工机械': '000425', '长城汽车': '601633',
  '长安汽车': '000625', '上汽集团': '600104', '广汽集团': '601238', '小鹏汽车': '09868',
  '理想汽车': '02015', '蔚来': '09866', '拼多多': 'PDD', '京东': 'JD', '阿里巴巴': 'BABA'
};
/* 剔除港股/美股（本期仅关联 A股） */
for (const k of Object.keys(ALIAS)) { if (String(ALIAS[k]).length !== 6) delete ALIAS[k]; }

/* 文本中出现的中文公司简称/全称匹配（先简称表，再全称 includes） */
function extractCodes(text) {
  const out = new Set();
  if (!text) return out;
  // 1) 代码正则（6 位，排除明显非股票数字：电话/日期等由词典校验兜底）
  const re = /(?<![0-9])(600\d{3}|601\d{3}|603\d{3}|605\d{3}|688\d{3}|689\d{3}|000\d{3}|001\d{3}|002\d{3}|003\d{3}|300\d{3}|301\d{3}|8[0-9]{4}|4[0-9]{4}|92\d{4})(?![0-9])/g;
  let m;
  while ((m = re.exec(text)) && out.size < 10) { if (universe.has(m[1])) out.add(m[1]); }
  // 2) 全称匹配
  if (out.size < 6) {
    for (const [code, s] of universe) {
      if (s.name.length >= 4 && text.includes(s.name)) { out.add(code); if (out.size >= 8) break; }
    }
  }
  // 3) 常用简称匹配
  if (out.size < 8) {
    for (const [alias, code] of Object.entries(ALIAS)) {
      if (universe.has(code) && text.includes(alias)) { out.add(code); if (out.size >= 10) break; }
    }
  }
  return out;
}

/* ---------------- 分类 / 情感 / 重要性（轻量规则，诚实标注） ---------------- */
const KW_MACRO = /央行|降准|降息|逆回购|MLF|LPR|统计局|CPI|PPI|PMI|国债|美债|财政|进出口|社融|M2|证监会|国常会|发改委|工信部|国务院/;
const KW_OVERSEAS = /美股|纳指|道指|标普|美联储|欧央行|日经|恒指|港股|油价|原油|黄金|美元指数|海外|欧盟|特朗普|关税/;
const KW_RUMOR = /^(传|曝|网传|据传|消息人士|知情人士|传闻|小作文|或遭|疑)/;
const IMP_RULES = /停牌|复牌|立案|退市|ST|业绩预告|业绩快报|重组|借壳|要约收购|回购|增持|减持计划|中标|央行|降准|降息|证监会|国常会|实施股权激励|重大合同|并购|收购|获批|涨停|跌停|问询函|调查/;
const KW_POS = /预增|增长|涨停|突破|中标|回购|增持|净流入|上调|超预期|利好|回升|新高|获批|合作|订单|扭亏|扩大|受益|走强/;
const KW_NEG = /预亏|亏损|下滑|减持|跌停|立案|问询|调查|违约|退市|下调|净流出|利空|新低|跌超|风险|违规|被罚|质押|解禁/;
const ANN_TYPES = [
  [/业绩预告|业绩快报|业绩预增|业绩预亏/, '业绩预告'],
  [/减持|增持/, '增减持'], [/回购/, '回购'], [/重组|收购|借壳|并购/, '重组并购'],
  [/停牌/, '停牌'], [/复牌/, '复牌'], [/澄清/, '澄清'], [/立案|调查|处罚/, '立案处罚'],
  [/问询/, '监管问询'], [/中标|合同|订单/, '重大合同'], [/解禁/, '限售解禁'],
  [/质押/, '股份质押'], [/分红|派现|股利/, '权益分派'], [/股权激励/, '股权激励'], [/可转债/, '可转债']
];
function classify(item) {
  const title = item.title || '', body = item.summary + (item.body || '');
  const text = title + ' ' + clip(body, 600);
  if (item.sourceType === 'cninfo') { item.type = '公告'; item.annType = guessAnn(title); }
  else if (item.sourceType === 'social') { item.type = '传闻'; item.rumor = true; item.imp = false; }   // 社交内容一律按"未经证实"处理
  else if (KW_RUMOR.test(title)) { item.type = '传闻'; item.rumor = true; item.imp = false; }
  else if (item.sourceType === 'zhibo') item.type = '快讯';
  else item.type = (item.summary || '').length >= 90 ? '深度' : '快讯';
  // 市场
  if (item.codes.size) item.market = 'A股';
  else if (KW_MACRO.test(text) && !KW_OVERSEAS.test(text)) item.market = '宏观';
  else if (KW_OVERSEAS.test(text)) item.market = '海外';
  else item.market = 'A股';
  // 行业（取首个匹配标的行业）
  for (const c of item.codes) { const u = universe.get(c); if (u && u.ind) { item.ind = u.ind; break; } }
  if (!item.ind) item.ind = '宏观';
  // 情感
  let p = 0, n = 0;
  if (KW_POS.test(text)) p++; if (KW_NEG.test(text)) n++;
  item.senti = p > n ? 'up' : (n > p ? 'down' : 'neu');
  // 重要（传闻永不重要）
  item.imp = !item.rumor && IMP_RULES.test(text);
  return item;
}
function guessAnn(title) {
  for (const [re, name] of ANN_TYPES) if (re.test(title)) return name;
  return '公告';
}

/* ---------------- 存储（7 天保留） ---------------- */
const store = new Map();
const srcState = {};
function touchSource(name, ok, extra) { srcState[name] = Object.assign({ ok, last: Date.now(), err: ok ? null : extra }, srcState[name]); }
function addItems(list) {
  let added = 0;
  for (const raw of list) {
    if (!raw || !raw.title) continue;
    const now = Date.now();
    const hour = Math.floor(raw.time / 3600e3);
    // 跨源去重：归一标题 + 小时桶；公告额外按证券代码区分（不同公司同名模板公告不得合并）
    const key = hashKey(raw.title) + ':' + hour + (raw.idExtra ? '|' + raw.idExtra : '');
    const prev = store.get(key);
    if (prev) { prev.merged = (prev.merged || 1) + 1; prev.last = now; continue; }
    const item = Object.assign({
      id: key, title: '', summary: '', body: '', source: '新浪财经', link: '', market: 'A股',
      ind: '宏观', codes: new Set(), senti: 'neu', imp: false, type: '快讯', time: now, ts: now, merged: 1
    }, raw);
    item.id = key; item.ts = item.time;
    classify(item);
    item.codes = [...item.codes].map(c => { const u = universe.get(c); return { code: c, name: u ? u.name : c, ind: u ? u.ind : '' }; });
    store.set(key, item);
    added++;
    if (!PUSH.suppressInitial && isAutoPushWorthy(item) && PUSH.queue.length < 20) PUSH.queue.push(item);
  }
  // 保留策略：7 天 / 上限
  const cutoff = Date.now() - RETENTION_MS;
  let n = store.size;
  if (n > MAX_ITEMS) {
    const sorted = [...store.values()].sort((a, b) => b.ts - a.ts);
    for (let i = MAX_ITEMS; i < sorted.length; i++) store.delete(sorted[i].id);
    n = store.size;
  }
  for (const [k, v] of store) if (v.ts < cutoff) store.delete(k);
  return added;
}
const feedList = () => [...store.values()].sort((a, b) => b.ts - a.ts);

/* ---------------- 源适配器：新浪 7x24 ---------------- */
const ZHI_REL = /A股|沪深|沪指|深成|创业板|北交所|科创板|证监会|交易所|上市公司|股票|股价|涨停|跌停|板块|基金|债券|国债|回购|增持|减持|并购|重组|IPO|财报|业绩|预增|预亏|融资|美元|人民币|美联储|降息|加息|关税|黄金|原油|石油|大宗商品|CPI|PMI|GDP|半导体|芯片|新能源|锂|光伏|医药|白酒|地产|银行|保险|券商|机器人|算力|人工智能|央行/;
const NOISE_RE = /比特币|区块链|加密货|NFT|元宇宙|明星|综艺|电影|游戏|主播|网友|小红书|抖音|时尚|包包|球鞋|餐饮排队|探店/;
let zhiboMaxId = 0;
async function pollSinaZhibo() {
  const url = 'https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=100&zhibo_id=152&tag_id=0&dire=f&dpc=1&type=0';
  const r = await fet(url); const j = await r.json();
  const list = (j.result && j.result.data && j.result.data.feed && j.result.data.feed.list) || [];
  const items = [];
  for (const it of list) {
    if (!it || !it.id) continue;
    if (zhiboMaxId && it.id <= zhiboMaxId) continue;
    if (it.id > zhiboMaxId) zhiboMaxId = it.id;
    const txt = stripHtml(it.rich_text || '');
    if (txt.length < 8) continue;
    const codes = extractCodes(txt);
    if (codes.size === 0 && (NOISE_RE.test(txt) || !ZHI_REL.test(txt))) continue;   // 财经相关性过滤
    items.push({
      srcTag: 'szb', sourceType: 'zhibo', source: '新浪财经7×24', title: clip(txt, 60),
      summary: txt, body: txt, link: 'https://zhibo.sina.com.cn/finance/152',
      time: it.create_time ? new Date(String(it.create_time).replace(/-/g, '/')).getTime() : Date.now(),
      codes
    });
  }
  const added = addItems(items);
  touchSource('sinaZhibo', true);
  return added;
}

/* ---------------- 源适配器：新浪财经滚动 ---------------- */
async function pollSinaRoll() {
  const lids = [['2516', '新浪财经·要闻'], ['2517', '新浪财经·国际'], ['2509', '新浪财经·产经']];
  let added = 0;
  for (const [lid, src] of lids) {
    try {
      const url = `https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=${lid}&k=&num=60&page=1`;
      const r = await fet(url); const j = await r.json();
      const list = (j.result && j.result.data) || [];
      const items = [];
      for (const it of list) {
        const title = stripHtml(it.title || '');
        const intro = stripHtml(it.intro || '');
        if (title.length < 6) continue;
        const codes = extractCodes(title + ' ' + intro);
        if (codes.size === 0 && (NOISE_RE.test(title + intro) || !(ZHI_REL.test(title + intro) || /公司|企业|行业|政策|市场|指数|股票/.test(title + intro)))) continue;
        items.push({
          srcTag: 'sroll' + lid, sourceType: 'roll', source: src, title: clip(title, 80),
          summary: intro || title, body: intro, link: it.wapurl || it.url || '',
          time: (it.ctime ? it.ctime * 1000 : Date.now()),
          codes
        });
      }
      added += addItems(items);
      touchSource('sinaRoll_' + lid, true);
    } catch (e) { touchSource('sinaRoll_' + lid, false, e.message); }
  }
  return added;
}

/* ---------------- 源适配器：巨潮公告 ---------------- */
let cninfoCookie = '';
async function cninfoRefresh() {
  const r = await fet('https://www.cninfo.com.cn/new/index');
  const raw = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')];
  cninfoCookie = (raw || []).filter(Boolean).map(c => c.split(';')[0]).join('; ');
}
async function cninfoQuery(column) {
  const today = new Date(); const d = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  const from = d(new Date(today.getTime() - 7 * 86400e3));
  const to = d(today);
  const body = `pageNum=1&pageSize=50&column=${column}&tabName=fulltext&plate=&stock=&searchkey=&secid=&category=&trade=&seDate=${from}~${to}&sortName=&sortType=&isHLtitle=true`;
  const r = await fet('https://www.cninfo.com.cn/new/hisAnnouncement/query', {
    method: 'POST',
    headers: {
      'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest', Origin: 'https://www.cninfo.com.cn',
      Referer: 'https://www.cninfo.com.cn/new/commonUrl?url=disclosure/list/notice',
      Cookie: cninfoCookie
    },
    body
  });
  return r.json();
}
async function pollAnnounce() {
  try {
    if (!cninfoCookie) await cninfoRefresh();
    let added = 0;
    for (const col of ['szse', 'sse']) {
      try {
        const j = await cninfoQuery(col);
        const anns = (j && j.announcements) || [];
        const items = anns.map(a => ({
          srcTag: 'cn' + col, sourceType: 'cninfo', source: '巨潮资讯网', title: clip(stripHtml(a.announcementTitle || ''), 90),
          summary: `${a.secName}（${a.secCode}）于 ${new Date(a.announcementTime).toLocaleString('zh-CN')} 发布的公告`,
          body: '', link: 'http://static.cninfo.com.cn/' + (a.adjunctUrl || ''),
          time: a.announcementTime || Date.now(), idExtra: String(a.secCode || ''),
          codes: a.secCode && universe.has(String(a.secCode)) ? new Set([String(a.secCode)]) : new Set()
        }));
        added += addItems(items);
        touchSource('cninfo_' + col, true);
      } catch (e) { touchSource('cninfo_' + col, false, e.message); }
    }
    return added;
  } catch (e) { touchSource('cninfo', false, e.message); return 0; }
}

/* ---------------- 行情 / 分时 / K线 ---------------- */
const quoteCache = new Map();   // code -> {data, ts}
async function fetchQuote(code) {
  const m = marketOf(code);
  if (m === 'sh' || m === 'sz') {
    try {
      const url = `https://push2delay.eastmoney.com/api/qt/stock/get?secid=${secidOf(code)}&fltt=2&invt=2&fields=f43,f44,f45,f46,f47,f48,f57,f58,f60,f168,f169,f170`;
      const r = await fet(url); const j = await r.json(); const d = j.data;
      if (d && d.f43 !== '-' && d.f43 != null) {
        return { code, name: d.f58 || code, price: +d.f43, open: +d.f46, high: +d.f44, low: +d.f45, prev: +d.f60, chg: +d.f169, pct: +d.f170, vol: +d.f47, amount: +d.f48, turn: +d.f168, time: Date.now() };
      }
    } catch (e) { /* fallthrough */ }
  }
  // 腾讯（含北交所 bj）
  try {
    const r = await fet('https://qt.gtimg.cn/q=' + m + code);
    const s = fmtKBuf(Buffer.from(await r.arrayBuffer()));
    const f = s.split('=')[1].replace(/^"|"$/g, '').split('~');
    if (f && f.length > 40) {
      const p = +f[3], prev = +f[4];
      return { code, name: f[1] || code, price: p, open: +f[5], high: p, low: p, prev, chg: p - prev, pct: prev ? (p - prev) / prev * 100 : 0, vol: +f[6], amount: +f[37], turn: +f[38], time: Date.now() };
    }
  } catch (e) { /* */ }
  return null;
}
async function getQuote(code, fresh) {
  const c = quoteCache.get(code);
  if (c && !fresh && Date.now() - c.ts < 8000) return c.data;
  const d = await fetchQuote(code);
  if (d) quoteCache.set(code, { data: d, ts: Date.now() });
  return d;
}
async function getQuotes(codes) {
  const out = [];
  for (const c of codes.slice(0, 30)) { const q = await getQuote(c); if (q) out.push(q); }
  return out;
}
async function getMinute(code) {
  const m = marketOf(code);
  if (m === 'sh' || m === 'sz') {
    try {
      const url = `https://push2delay.eastmoney.com/api/qt/stock/trends2/get?secid=${secidOf(code)}&fields1=f1,f2,f3,f7,f8&fields2=f51,f53,f56,f58&iscr=0&ndays=1`;
      const r = await fet(url); const j = await r.json(); const d = j.data;
      if (d && d.trends && d.trends.length) {
        const pts = d.trends.map(t => { const p = t.split(','); return { t: p[0].slice(11), price: +p[1], vol: +p[2], avg: +p[3] }; });
        return { code, preClose: d.preClose || pts[0].avg, points: pts };
      }
    } catch (e) { /* fallthrough */ }
  }
  try {
    const sym = m + code;
    const r = await fet(`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${sym}`);
    const j = await r.json();
    const d = j.data && j.data[sym] && j.data[sym].data;
    if (d && d.data && d.data.length) {
      let cumA = 0, cumV = 0;
      const pts = d.data.map(line => {
        const f = line.split(' ');
        const price = +f[1], v = +f[2], amt = +f[3]; cumV += v; cumA = amt || cumA;
        return { t: f[0], price, vol: v, avg: cumV ? cumA / (cumV * 100) : price };
      });
      const q = await getQuote(code, true);
      return { code, preClose: q ? q.prev : pts[0].price, points: pts };
    }
  } catch (e) { /* */ }
  return { code, preClose: 0, points: [] };
}
async function getKline(code, days) {
  const m = marketOf(code), sym = m + code, n = Math.min(Math.max(days || 120, 30), 500);
  // 腾讯
  try {
    const r = await fet(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},day,,,${n},qfq`);
    const j = await r.json();
    const d = j.data && j.data[sym];
    const rows = (d && (d.qfqday || d.day)) || [];
    if (rows.length) return { code, bars: rows.map(x => ({ date: x[0], open: +x[1], close: +x[2], high: +x[3], low: +x[4], vol: +x[5] })) };
  } catch (e) { /* */ }
  // 新浪
  try {
    const r = await fet(`https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_=/CN_MarketDataService.getKLineData?symbol=${sym}&scale=240&ma=no&datalen=${n}`);
    let t = await textOf(r);
    const a = t.indexOf('('), b = t.lastIndexOf(')');
    const arr = a >= 0 ? JSON.parse(t.slice(a + 1, b)) : JSON.parse(t.replace(/^.*?=\s*/, ''));
    if (arr && arr.length) return { code, bars: arr.map(x => ({ date: x.day, open: +x.open, close: +x.close, high: +x.high, low: +x.low, vol: Math.round(+x.volume / 100) })) };
  } catch (e) { /* */ }
  return { code, bars: [] };
}

/* ---------------- 企微推送引擎（设置页配置 Webhook 后自动运行） ---------------- */
async function sendWecom(text) {
  if (!wecomWebhook) return { sent: false, reason: '未配置企微机器人 Webhook（请在页面「⚙ 设置」中填写）' };
  try {
    const r = await fet(wecomWebhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msgtype: 'text', text: { content: text } }) });
    const j = await r.json();
    return { sent: j.errcode === 0, reason: j.errmsg || '', errcode: j.errcode };
  } catch (e) {
    console.warn('[wecom] 发送异常:', e.message);
    return { sent: false, reason: '请求企微失败：' + e.message };
  }
}
/* 自动推送：新重要消息 → 企微群机器人（含事件去重 / 频控 / 推送日志） */
const PUSH = {
  log: [],             // 推送日志（内存，最多 100 条）
  queue: [],           // 待发送队列
  sentKeys: new Set(), // 同事件去重
  lastSent: 0,         // 频控：距上次发送
  enabled: false,
  suppressInitial: true
};
const PUSH_MIN_GAP = 20000;                       // 两次自动推送最小间隔 20s
const PUSH_CRITICAL_ANN = /业绩预告|业绩快报|停牌|复牌|澄清|立案|处罚|重组|并购|回购|要约/;
function pushLogAdd(entry) { PUSH.log.unshift(entry); if (PUSH.log.length > 100) PUSH.log.length = 100; }
/* 对外站点地址（推送消息里的可点击详情链接；部署后可改环境变量 SITE_URL，如 https://wangchaoqun.top/news） */
const SITE_URL = (process.env.SITE_URL || 'https://wangchaoqun.top/news').replace(/\/+$/, '');
function newsUrl(id) { return SITE_URL + '#n=' + encodeURIComponent(id); }

function isAutoPushWorthy(it) {
  if (!it || !it.imp || it.type === '传闻' || it.rumor) return false;
  if (it.type === '公告' && !(it.annType && PUSH_CRITICAL_ANN.test(it.annType))) return false;
  if (!pushRelevant(it)) return false;      // 仅推送与 A股 / 美股 市场相关的消息
  return true;
}
/* 推送相关性过滤：A股市场 / 美股市场（美股含美联储/美债等直接驱动因素）；
 * 纯其他市场/资产（欧股、日经、恒指港股、印度、比特币等）不推送。 */
function pushRelevant(it) {
  if (it.type === '公告') return true;      // 巨潮公告均为 A股上市公司公告
  const t = (it.title || '') + ' ' + (it.summary || '') + ' ' + (it.codes || []).map(c => (c.name || '') + ' ' + (c.code || '')).join(' ');
  const hasUS = /美股|纳指|道指|标普|中概股|美债|美联储|纽交所|纳斯达克|费城半导体|英伟达|苹果公司|特斯拉|微软|亚马逊|谷歌|Meta|甲骨文|AMD|英特尔/.test(t);
  if (hasUS) return true;
  const hasOtherMkt = /欧股|日经|恒生指数|恒指|港股|H股|印度|泰国|越南|巴西|土耳其|英股|德股|法股|比特币|加密货币|以太坊/.test(t);
  // A股强信号（指数/市场/板块/公司）
  const hasACnStrong = /A股|沪深|沪指|深成指|创业板|北交所|两市|证监会|交易所|板块|涨停|跌停|上市公司/.test(t) || it.market === 'A股' || (it.codes && it.codes.length > 0);
  // 国内政策信号（排除"印度/日本/欧/韩等外国央行"的误命中）
  const hasCNPolicy = /央行|降准|降息|LPR|MLF|逆回购|国常会|印花税/.test(t) && !/(印度|日本|欧|欧洲|韩国|澳洲|新西兰|巴西|俄罗斯|土耳其|墨西哥|南非)央行/.test(t);
  const hasACn = hasACnStrong || hasCNPolicy;
  if (hasOtherMkt && !hasACn) return false;
  return hasACn;
}
function wecomText(it) {
  const codes = (it.codes || []).map(c => `${c.name}(${c.code})`).join('、');
  return `【重要消息·财讯雷达】${it.title}\n类型：${it.type}${it.annType ? '·' + it.annType : ''}｜来源：${it.source}\n时间：${new Date(it.ts || it.time || Date.now()).toLocaleString('zh-CN')}${codes ? '\n关联：' + codes : ''}\n点击查看详情：${newsUrl(it.id)}${it.link ? '\n原文：' + it.link : ''}\n（自动推送｜仅供参考，不构成投资建议）`;
}
async function drainPushQueue() {
  while (PUSH.queue.length) {
    if (!wecomWebhook) { PUSH.enabled = false; return; }
    const gap = Date.now() - PUSH.lastSent;
    if (gap < PUSH_MIN_GAP) return;
    const it = PUSH.queue.shift();
    const key = hashKey(it.title) + ':' + Math.floor((it.ts || Date.now()) / 3600e3);
    if (PUSH.sentKeys.has(key)) continue;              // 同事件只推一次
    PUSH.sentKeys.add(key);
    if (PUSH.sentKeys.size > 300) PUSH.sentKeys.clear();
    const r = await sendWecom(wecomText(it));
    PUSH.lastSent = Date.now();
    pushLogAdd({ id: uid2(), ts: Date.now(), title: it.title, type: it.type, newsId: it.id, target: '企微群机器人', status: r.sent ? '已发送' : '发送失败', note: r.sent ? '' : (r.reason || '') });
    if (!r.sent) PUSH.queue.unshift(it);               // 失败放回队尾稍后重试一次
  }
}
function uid2() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

/* ---------------- 源适配器：雪球热帖 / 微博热搜（Cookie 校验 + 采集） ---------------- */
const XQ_HOT_URL = 'https://xueqiu.com/statuses/hot/listV2.json?since_id=-1&max_id=-1&size=15';
const WB_HOT_URL = 'https://m.weibo.cn/api/container/getIndex?containerid=106003type%3D1%26filter_type%3Drealtimehot';
const WB_HOT_RE = /股|基金|央行|证监会|涨停|跌停|银行|券商|黄金|美元|地产|白酒|医药|芯片|半导体|新能源|理财|降息|A股|行情/;
function parseSocialTime(v) {
  if (typeof v === 'number') { const t = v > 1e12 ? v : v * 1000; return Math.min(t, Date.now()); }
  if (typeof v === 'string') { const t = new Date(v.replace(/-/g, '/')).getTime(); return isFinite(t) ? Math.min(t, Date.now()) : Date.now(); }
  return Date.now();
}
function blockReason(text, site) {
  if (!text) return site + '：无响应';
  const t = String(text).slice(0, 2500);
  if (/aliyun_waf|renderData|_waf_|acw_sc|verify/.test(t)) return site + ' 触发安全验证(WAF/反爬)，返回验证页而非数据。请确认复制的是登录浏览器中的<b>整串 Cookie</b>（含 acw_* 验证参数）；若部署在云服务器（与浏览器 IP 不同），可能仍被 IP 风控拦截，需使用浏览器会话或第三方舆情数据。';
  if (/Sina Visitor System|passport\.weibo|请先登录|favicon\.ico/.test(t)) return site + '：未登录或登录态失效（返回"新浪访客验证"页）。请重新登录微博并复制最新 Cookie（SUB/SUBP 等）。';
  return site + '：接口返回非 JSON（可能被反爬拦截）：' + t.replace(/\s+/g, ' ').slice(0, 90);
}
function safeJson(t) { try { const j = JSON.parse(String(t).trim()); if (j && typeof j === 'object') return j; } catch (e) { /* */ } return null; }
/* 雪球判定：true=可用 */
function xqJudge(t) {
  const j = safeJson(t);
  if (!j) return { valid: false, msg: blockReason(t, '雪球'), j: null };
  if (j.code === 400016 || j.error_code) return { valid: false, msg: '雪球登录态无效或已过期（code=' + (j.code || j.error_code) + '，400016=需要登录）。请重新登录雪球并复制最新整串 Cookie（需含 xq_a_token）', j };
  if (typeof j.code === 'number' && j.code !== 0) return { valid: false, msg: '雪球接口异常 code=' + j.code, j };
  const items = (j.items || []).filter(x => x && x.data);
  return { valid: true, msg: '', count: items.length, j, items };
}
/* 微博判定 + 财经话题抽取 */
function wbWords(j) {
  const words = [];
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (typeof o.word === 'string' && o.word.length >= 2 && o.word.length <= 24) words.push(o.word);
    if (typeof o.desc === 'string' && /^#/.test(o.desc) && o.desc.length <= 30) words.push(o.desc.replace(/#/g, ''));
    if (typeof o.title_sub === 'string' && o.title_sub.length >= 2) words.push(o.title_sub);
    for (const k of Object.keys(o)) { if (Array.isArray(o[k])) o[k].forEach(walk); else if (o[k] && typeof o[k] === 'object') walk(o[k]); }
  })(j);
  const seen = new Set(), out = [];
  for (const w of words) { if (!seen.has(w) && !NOISE_RE.test(w) && WB_HOT_RE.test(w)) { seen.add(w); out.push(w); } }
  return out;
}
function wbJudge(t) {
  const j = safeJson(t);
  if (!j) return { valid: false, msg: blockReason(t, '微博'), j: null, words: [] };
  if (j.ok !== 1) {
    const raw = JSON.stringify(j).slice(0, 300);
    const msg = /login|passport|visit|40300004|100001/i.test(raw) ? '微博登录态无效或需要登录（请重新登录后复制最新 Cookie）' : ('微博接口返回异常：' + raw);
    return { valid: false, msg, j, words: [] };
  }
  const cards = (j.data && j.data.cards) || [];
  if (!cards.length) return { valid: false, msg: '微博接口可访问但无热搜卡片（可能需要有效登录态）', j, words: [] };
  const words = wbWords(j);
  return { valid: true, msg: '', count: words.length, j, words };
}
async function validateSocial(source, cookie) {
  if (!cookie) return { valid: false, message: '尚未填写/保存该 Cookie' };
  try {
    if (source === 'xueqiu') {
      const r = await fet(XQ_HOT_URL, { headers: { 'User-Agent': UA, Referer: 'https://xueqiu.com/', Cookie: cookie } });
      const jd = xqJudge(await r.text());
      return jd.valid ? { valid: true, message: '✓ 有效：雪球接口可用，当前返回 ' + jd.count + ' 条热帖', count: jd.count } : { valid: false, message: jd.msg };
    }
    if (source === 'weibo') {
      const r = await fet(WB_HOT_URL, { headers: { 'User-Agent': UA, Referer: 'https://m.weibo.cn/', Cookie: cookie } });
      const jd = wbJudge(await r.text());
      return jd.valid ? { valid: true, message: '✓ 有效：微博接口可用，命中 ' + jd.count + ' 条财经热搜话题', count: jd.count } : { valid: false, message: jd.msg };
    }
    return { valid: false, message: '未知数据源：' + source };
  } catch (e) { return { valid: false, message: '请求失败：' + e.message }; }
}
async function pollXueqiu() {
  if (!XQ_COOKIE) return 0;
  if (Date.now() - SOCIAL.xueqiu.last < 30000) return 0;   // 30s 节流
  SOCIAL.xueqiu.last = Date.now();
  try {
    const r = await fet(XQ_HOT_URL, { headers: { 'User-Agent': UA, Referer: 'https://xueqiu.com/', Cookie: XQ_COOKIE } });
    const jd = xqJudge(await r.text());
    if (!jd.valid) { SOCIAL.xueqiu.ok = false; SOCIAL.xueqiu.err = jd.msg; return 0; }
    const list = [];
    for (const it of jd.items) {
      const d = it.data;
      const txt = stripHtml(d.text || d.title || '');
      if (txt.length < 10) continue;
      list.push({
        srcTag: 'xqhot', sourceType: 'social', source: '雪球热帖', title: clip(txt, 60),
        summary: clip(txt, 220), body: clip(txt, 500),
        link: d.status_id || d.id ? 'https://xueqiu.com/' + (d.status_id || d.id) : 'https://xueqiu.com/',
        time: parseSocialTime(d.created_at), codes: extractCodes(txt)
      });
    }
    const added = addItems(list);
    SOCIAL.xueqiu.ok = true; SOCIAL.xueqiu.err = null;
    return added;
  } catch (e) { SOCIAL.xueqiu.ok = false; SOCIAL.xueqiu.err = '请求异常：' + e.message; return 0; }
}
async function pollWeibo() {
  if (!WB_COOKIE) return 0;
  if (Date.now() - SOCIAL.weibo.last < 60000) return 0;    // 60s 节流
  SOCIAL.weibo.last = Date.now();
  try {
    const r = await fet(WB_HOT_URL, { headers: { 'User-Agent': UA, Referer: 'https://m.weibo.cn/', Cookie: WB_COOKIE } });
    const jd = wbJudge(await r.text());
    if (!jd.valid) { SOCIAL.weibo.ok = false; SOCIAL.weibo.err = jd.msg; return 0; }
    const list = jd.words.slice(0, 12).map(w => ({
      srcTag: 'wbreal', sourceType: 'social', source: '微博热搜', title: clip('微博热搜：' + w, 60),
      summary: '微博热搜话题「' + w + '」引发讨论（社交热度参考，未经证实）', body: '微博热搜：' + w,
      link: 'https://s.weibo.com/weibo?q=' + encodeURIComponent(w),
      time: Date.now(), codes: extractCodes(w + ' 财经话题')
    }));
    const added = addItems(list);
    SOCIAL.weibo.ok = true; SOCIAL.weibo.err = null;
    return added;
  } catch (e) { SOCIAL.weibo.ok = false; SOCIAL.weibo.err = '请求异常：' + e.message; return 0; }
}

/* ---------------- 轮询调度 ---------------- */
async function pollNews(initial) {
  const t0 = Date.now();
  try { if (initial || !universeReady) await loadUniverse(); } catch (e) { console.error('[universe] err', e.message); }
  const results = [];
  try { results.push(['sina7x24', await pollSinaZhibo()]); } catch (e) { touchSource('sinaZhibo', false, e.message); }
  try { results.push(['sinaRoll', await pollSinaRoll()]); } catch (e) { touchSource('sinaRoll', false, e.message); }
  try { results.push(['xueqiu', await pollXueqiu()]); } catch (e) { SOCIAL.xueqiu.err = e.message; }
  try { results.push(['weibo', await pollWeibo()]); } catch (e) { SOCIAL.weibo.err = e.message; }
  const added = results.reduce((s, x) => s + x[1], 0);
  drainPushQueue().catch(e => console.error('[push] err', e.message));
  console.log(`[poll] ${initial ? 'initial' : 'tick'} +${added} items, total=${store.size}, pushQ=${PUSH.queue.length}, ${Date.now() - t0}ms`);
}

/* ---------------- 静态资源 ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8', '.pdf': 'application/pdf' };
function serveStatic(req, res, pathname) {
  const rel0 = decodeURIComponent(pathname);
  if (rel0 === '/favicon.ico') { res.writeHead(204); res.end(); return; }   // 浏览器图标请求，静默
  let rel = rel0;
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  if (rel === '/web') rel = '/web/index.html';                              // 目录无尾斜杠：直接补 index
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // 目录缺尾斜杠 → 301 补斜杠（如 /web → /web/）
      const probe = path.normalize(path.join(ROOT, rel0));
      if (!rel0.endsWith('/') && !path.extname(rel0)) {
        return fs.stat(probe, (e2, s2) => {
          if (!e2 && s2 && s2.isDirectory()) { res.writeHead(301, { Location: rel0 + '/' }); res.end(); return; }
          notFound(req, res, rel0);
        });
      }
      return notFound(req, res, rel0);
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}
function notFound(req, res, pathname) {
  console.warn(`[404] ${req.method} ${req.url}`);
  // 无扩展名的未知路径（如手输 /abc、/index）→ 跳转到应用首页，避免裸 404
  if (!path.extname(pathname)) {
    res.writeHead(302, { Location: '/web/index.html' });
    res.end();
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><title>404</title><body style="font-family:sans-serif;background:#f2f4f8;padding:40px;text-align:center"><h2>404 · 页面不存在</h2><p>资源未找到：<code>' + escapeHtml(pathname) + '</code></p><p><a href="/web/index.html">← 返回财讯雷达首页</a></p></body>');
}
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

/* ---------------- HTTP API ---------------- */
const json = (res, obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)); };
function publicItem(it) {
  return {
    id: it.id, type: it.type, title: it.title, summary: it.summary, body: it.body ? it.body.slice(0, 500) : '',
    source: it.source, link: it.link, time: it.ts, market: it.market, ind: it.ind,
    codes: it.codes, annType: it.annType || null, senti: it.senti, imp: it.imp, rumor: !!it.rumor, merged: it.merged || 1
  };
}
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (req.method === 'OPTIONS') {   // CORS 预检：支持前端跨域连接独立后端（如 api.wangchaoqun.top）
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' });
      res.end();
      return;
    }
    if (p.startsWith('/api/')) {
      if (p === '/api/meta') {
        json(res, {
          mode: 'live', version: '1.3', time: Date.now(), retentionDays: 7, count: store.size,
          universe: universe.size, sources: srcState, universeReady,
          social: {
            configured: SOCIAL.xueqiu.configured || SOCIAL.weibo.configured,
            xueqiu: SOCIAL.xueqiu, weibo: SOCIAL.weibo,
            ok: SOCIAL.xueqiu.ok || SOCIAL.weibo.ok,
            guide: SOCIAL_GUIDE
          },
          wecom: { configured: !!wecomWebhook },
          push: { enabled: !!wecomWebhook, auto: PUSH.queue.length, log: PUSH.log.length },
          siteUrl: SITE_URL
        });
        return;
      }
      if (p === '/api/feed') {
        let list = feedList();
        const q = (u.searchParams.get('q') || '').trim();
        const type = u.searchParams.get('type') || '全部';
        const market = u.searchParams.get('market') || '全部';
        const imp = u.searchParams.get('imp') === '1';
        const max = Math.min(parseInt(u.searchParams.get('max') || '200', 10) || 200, 2000);
        if (type !== '全部') list = list.filter(x => x.type === type);
        if (market !== '全部') list = list.filter(x => x.market === market);
        if (imp) list = list.filter(x => x.imp);
        if (q) list = list.filter(x => (x.title + x.summary + x.body).includes(q));
        json(res, { items: list.slice(0, max).map(publicItem), total: list.length });
        return;
      }
      if (p === '/api/stocks') {
        const q = (u.searchParams.get('q') || '').trim().toLowerCase();
        let out = [];
        if (!q) out = [...universe.values()].slice(0, 0);
        else {
          const seen = new Set();
          for (const s of universe.values()) {
            if (s.code.includes(q) || s.name.includes(q) || (s.ind || '').includes(q)) {
              if (!seen.has(s.name)) { seen.add(s.name); out.push(s); }
            }
            if (out.length >= 12) break;
          }
        }
        json(res, { items: out });
        return;
      }
      if (p === '/api/stocknews') {
        const code = u.searchParams.get('code');
        if (code) {
          const list = feedList().filter(x => x.codes.some(c => c.code === code)).slice(0, 200).map(publicItem);
          json(res, { items: list });
          return;
        }
        json(res, { items: [] });
        return;
      }
      if (p === '/api/item') {
        const id = u.searchParams.get('id');
        if (id) {
          for (const v of store.values()) { if (v.id === id) { json(res, { item: publicItem(v) }); return; } }
          json(res, { item: null });
          return;
        }
        json(res, { item: null });
        return;
      }
      if (p === '/api/quote') {
        const codes = (u.searchParams.get('codes') || '').split(',').filter(Boolean);
        json(res, { quotes: await getQuotes(codes) });
        return;
      }
      if (p === '/api/minute') {
        const code = u.searchParams.get('code');
        json(res, code ? await getMinute(code) : { points: [] });
        return;
      }
      if (p === '/api/kline') {
        const code = u.searchParams.get('code'); const days = parseInt(u.searchParams.get('days') || '120', 10);
        json(res, code ? await getKline(code, days) : { bars: [] });
        return;
      }
      if (p === '/api/social/validate') {
        if (req.method !== 'POST') { json(res, { error: 'method not allowed' }, 405); return; }
        let raw = '';
        for await (const c of req) raw += c;
        try {
          const b = JSON.parse(raw || '{}');
          const src = b.source === 'weibo' ? 'weibo' : 'xueqiu';
          const cookie = (b.cookie && String(b.cookie)) || (src === 'weibo' ? WB_COOKIE : XQ_COOKIE);
          json(res, Object.assign({ source: src }, await validateSocial(src, cookie)));
          return;
        } catch (e) { json(res, { valid: false, message: '请求解析失败：' + e.message }, 400); return; }
      }
      if (p === '/api/push-send') {
        let raw = '';
        for await (const c of req) raw += c;
        try { const b = JSON.parse(raw || '{}'); json(res, await sendWecom(b.text || '')); }
        catch (e) { json(res, { sent: false, reason: 'bad request' }, 400); }
        return;
      }
      if (p === '/api/push-test') {
        const r = await sendWecom('【财讯雷达·测试】推送已连通 ✓ ' + new Date().toLocaleString('zh-CN') + '\n自动推送引擎就绪，重要消息将自动推送到本群\n点击查看：' + SITE_URL);
        pushLogAdd({ id: uid2(), ts: Date.now(), title: '测试推送', type: 'test', newsId: null, target: '企微群机器人', status: r.sent ? '已发送' : '发送失败', note: r.sent ? '' : (r.reason || '') });
        json(res, r);
        return;
      }
      if (p === '/api/push-log') {
        json(res, { items: PUSH.log.slice(0, 50), enabled: !!wecomWebhook });
        return;
      }
      if (p === '/api/settings') {
        if (req.method === 'GET') {
          json(res, {
            xueqiu: { configured: SOCIAL.xueqiu.configured, ok: SOCIAL.xueqiu.ok, err: SOCIAL.xueqiu.err, mask: XQ_COOKIE ? XQ_COOKIE.slice(0, 6) + '…(已配置，长度 ' + XQ_COOKIE.length + ')' : '' },
            weibo: { configured: SOCIAL.weibo.configured, ok: SOCIAL.weibo.ok, err: SOCIAL.weibo.err, mask: WB_COOKIE ? WB_COOKIE.slice(0, 6) + '…(已配置，长度 ' + WB_COOKIE.length + ')' : '' },
            wecom: { configured: !!wecomWebhook, mask: wecomWebhook ? wecomWebhook.slice(0, 30) + '…' : '' },
            socialGuide: SOCIAL_GUIDE
          });
          return;
        }
        if (req.method === 'POST') {
          let raw = '';
          for await (const c of req) raw += c;
          try {
            const body = JSON.parse(raw || '{}');
            const changed = applySettings(body);
            json(res, { ok: true, changed, xueqiu: SOCIAL.xueqiu.configured, weibo: SOCIAL.weibo.configured, wecom: !!wecomWebhook });
            // 立即启用：清除节流并立刻抓取社交源 + 触发一轮轮询
            setImmediate(async () => {
              try { if (XQ_COOKIE) await pollXueqiu(); if (WB_COOKIE) await pollWeibo(); await pollNews(false); } catch (e) { console.error('[settings kick]', e.message); }
            });
            return;
          } catch (e) { json(res, { ok: false, error: e.message }, 400); return; }
        }
        json(res, { error: 'method not allowed' }, 405);
        return;
      }
      json(res, { error: 'not found' }, 404);
      return;
    }
    serveStatic(req, res, p);
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
});

/* ---------------- 启动 ---------------- */
server.listen(PORT, '127.0.0.1', async () => {
  console.log(`[server] 财讯雷达后端 http://127.0.0.1:${PORT} （数据保留 ${RETENTION_MS / 86400e3} 天）`);
  await pollNews(true);
  await pollAnnounce().catch(e => console.error('[ann] err', e.message));
  PUSH.suppressInitial = false;                            // 首次装载完成后自动推送引擎生效
  setInterval(() => pollNews(false).catch(e => console.error('[poll] err', e.message)), 20000);
  setInterval(() => pollAnnounce().catch(e => console.error('[ann] err', e.message)), 120000);
});
