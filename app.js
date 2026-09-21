'use strict';

/* ==========================================================================
   Manga Koleksiyonum
   Kaynaklar (hepsi ücretsiz, anahtar gerektirmez):
     - AniList  : ana katalog (kapak, özet, puan, tür, cilt sayısı)
     - MangaDex : az bilinen seriler + devam eden serilerin cilt sayısı
     - Kitsu    : ek katalog + cilt sayısı
   Koleksiyon bu cihazın tarayıcısında (localStorage) saklanır.
   ========================================================================== */

const API = 'https://graphql.anilist.co';
const MD_API = 'https://api.mangadex.org';
const KITSU_API = 'https://kitsu.io/api/edge';
const STORE_KEY = 'manga-koleksiyon-v1';
const BACKUP_KEY = 'manga-koleksiyon-yedek';
const BACKUP_DAYS = 7; // bu kadar günde bir yedek hatırlat
const PER_PAGE = 24;
const VOL_RECHECK_MS = 12 * 3600 * 1000;

const GENRES = {
  Action: 'Aksiyon', Adventure: 'Macera', Comedy: 'Komedi', Drama: 'Drama',
  Ecchi: 'Ecchi', Fantasy: 'Fantastik', Horror: 'Korku', 'Mahou Shoujo': 'Büyülü Kız',
  Mecha: 'Mecha', Music: 'Müzik', Mystery: 'Gizem', Psychological: 'Psikolojik',
  Romance: 'Romantik', 'Sci-Fi': 'Bilim Kurgu', 'Slice of Life': 'Günlük Yaşam',
  Sports: 'Spor', Supernatural: 'Doğaüstü', Thriller: 'Gerilim',
};
const STATUS_TR = {
  FINISHED: 'Tamamlandı', RELEASING: 'Devam ediyor', NOT_YET_RELEASED: 'Henüz yayınlanmadı',
  CANCELLED: 'İptal edildi', HIATUS: 'Ara verildi',
};
const FORMAT_TR = { MANGA: 'Manga', ONE_SHOT: 'Tek cilt' };
const ORIGIN_TR = { JP: 'Japonya', KR: 'Kore (Manhwa)', CN: 'Çin (Manhua)', TW: 'Tayvan' };
const READ_STATUS = {
  okuyacagim: 'Okuyacağım', okuyorum: 'Okuyorum', okudum: 'Okudum', biraktim: 'Bıraktım',
};
const DISCOVER_SORTS = {
  POPULARITY_DESC: 'Popüler', TRENDING_DESC: 'Trend', SCORE_DESC: 'En yüksek puan',
  START_DATE_DESC: 'En yeni', TITLE_ROMAJI: 'A – Z',
};
const LOCAL_SORTS = { added: 'Son eklenen', title: 'A – Z', progress: 'Tamamlanma' };

const MD_STATUS = { ongoing: 'RELEASING', completed: 'FINISHED', hiatus: 'HIATUS', cancelled: 'CANCELLED' };
const MD_ORIGIN = { ja: 'JP', ko: 'KR', zh: 'CN', 'zh-hk': 'CN' };
const KITSU_STATUS = { current: 'RELEASING', finished: 'FINISHED', tba: 'NOT_YET_RELEASED', unreleased: 'NOT_YET_RELEASED', upcoming: 'NOT_YET_RELEASED' };
const KITSU_ORIGIN = { manga: 'JP', oneshot: 'JP', doujin: 'JP', manhwa: 'KR', manhua: 'CN' };
const COLORED_RE = /\bcolou?red\b/i; // MangaDex'teki "(Official Colored)" gibi tekrar kayıtlar

const FIELDS = `
  id
  title { romaji english native }
  coverImage { large color }
  description(asHtml: false)
  genres averageScore status volumes chapters format countryOfOrigin
  startDate { year }
  siteUrl`;

const LIST_QUERY = `
  query ($page: Int, $search: String, $genre: String, $sort: [MediaSort]) {
    Page(page: $page, perPage: ${PER_PAGE}) {
      pageInfo { hasNextPage }
      media(type: MANGA, isAdult: false, format_in: [MANGA, ONE_SHOT],
            search: $search, genre: $genre, sort: $sort) { ${FIELDS} }
    }
  }`;
const ONE_QUERY = `query ($id: Int) { Media(id: $id, type: MANGA) { ${FIELDS} } }`;

/* ---------- yardımcılar ---------- */

const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return el;
}

function fillSelect(select, options, value) {
  select.replaceChildren(...Object.entries(options).map(([v, label]) => h('option', { value: v, text: label })));
  select.value = value;
}

function cleanText(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, '\n'), 'text/html');
  return doc.body.textContent.replace(/\n{3,}/g, '\n\n').trim();
}

function cleanMarkdown(s) {
  return String(s || '')
    .split(/\n\s*-{3,}/)[0]
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*`#>]+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const safeColor = (c) => (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : '');
const trLower = (s) => String(s).toLocaleLowerCase('tr');
const enc = encodeURIComponent;
const money = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', maximumFractionDigits: 2 });
const fmtMoney = (n) => money.format(n);
const normTitle = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

/* ---------- kaynaklara istekler ---------- */

const NET_ERR = 'İnternet bağlantısı yok ya da sunucuya ulaşılamıyor.';

async function gql(query, variables) {
  let res;
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    throw new Error(NET_ERR);
  }
  if (res.status === 429) throw new Error('Çok hızlı istek gönderildi. Birkaç saniye bekleyip tekrar dene.');
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.errors) throw new Error(json?.errors?.[0]?.message || 'AniList’ten cevap alınamadı.');
  return json.data;
}

async function getJSON(url) {
  let res;
  try { res = await fetch(url); } catch { throw new Error(NET_ERR); }
  if (!res.ok) throw new Error(`Sunucu hatası (${res.status})`);
  return res.json();
}

function normalize(m) {
  const t = m.title || {};
  return {
    id: `al:${m.id}`,
    title: t.english || t.romaji || t.native || 'Adsız',
    romaji: t.romaji || '',
    native: t.native || '',
    cover: m.coverImage?.large || '',
    color: safeColor(m.coverImage?.color),
    volumes: m.volumes || null,
    volumesDerived: false,
    chapters: m.chapters || null,
    status: m.status || '',
    format: m.format || '',
    year: m.startDate?.year || null,
    score: m.averageScore || null,
    genres: m.genres || [],
    description: cleanText(m.description),
    origin: m.countryOfOrigin || '',
    url: m.siteUrl || '',
  };
}

function mdTitle(x) {
  const t = x.attributes.title || {};
  return t.en || t['ja-ro'] || Object.values(t)[0] || '';
}

function normalizeMD(x) {
  const a = x.attributes;
  const alts = (a.altTitles || []).map((o) => o.en || o['ja-ro']).filter(Boolean).slice(0, 8);
  const file = x.relationships?.find((r) => r.type === 'cover_art')?.attributes?.fileName;
  const lastVol = parseInt(a.lastVolume, 10);
  const lastCh = parseInt(a.lastChapter, 10);
  return {
    id: `md:${x.id}`,
    title: mdTitle(x) || 'Adsız',
    romaji: a.title?.['ja-ro'] || (a.altTitles || []).find((o) => o['ja-ro'])?.['ja-ro'] || '',
    native: (a.altTitles || []).find((o) => o.ja)?.ja || '',
    cover: file ? `https://uploads.mangadex.org/covers/${x.id}/${file}.256.jpg` : '',
    color: '',
    volumes: lastVol > 0 ? lastVol : null,
    volumesDerived: lastVol > 0 && a.status !== 'completed',
    chapters: lastCh > 0 ? lastCh : null,
    status: MD_STATUS[a.status] || '',
    format: 'MANGA',
    year: a.year || null,
    score: null,
    genres: (a.tags || [])
      .filter((t) => t.attributes?.group === 'genre' || t.attributes?.group === 'theme')
      .map((t) => t.attributes.name?.en).filter(Boolean).slice(0, 8),
    description: cleanMarkdown(a.description?.en || Object.values(a.description || {})[0]),
    origin: MD_ORIGIN[a.originalLanguage] || '',
    url: `https://mangadex.org/title/${x.id}`,
    alId: a.links?.al || null,
    alts,
  };
}

function normalizeKitsu(d) {
  const a = d.attributes;
  const t = a.titles || {};
  return {
    id: `kt:${d.id}`,
    title: t.en || a.canonicalTitle || t.en_jp || 'Adsız',
    romaji: t.en_jp || '',
    native: t.ja_jp || '',
    cover: a.posterImage?.small || a.posterImage?.medium || '',
    color: '',
    volumes: a.volumeCount || null,
    volumesDerived: !!a.volumeCount && a.status !== 'finished',
    chapters: a.chapterCount || null,
    status: KITSU_STATUS[a.status] || '',
    format: a.subtype === 'oneshot' ? 'ONE_SHOT' : 'MANGA',
    year: a.startDate ? parseInt(a.startDate.slice(0, 4), 10) || null : null,
    score: a.averageRating ? Math.round(parseFloat(a.averageRating)) : null,
    genres: [],
    description: a.synopsis || '',
    origin: KITSU_ORIGIN[a.subtype] || '',
    url: a.slug ? `https://kitsu.io/manga/${a.slug}` : '',
    alts: [a.canonicalTitle].filter(Boolean),
  };
}

async function fetchAniList(d, page) {
  const data = await gql(LIST_QUERY, {
    page,
    search: d.search || null,
    genre: d.genre || null,
    sort: [d.search ? 'SEARCH_MATCH' : d.sort],
  });
  return { items: data.Page.media.map(normalize), hasNext: data.Page.pageInfo.hasNextPage };
}

async function fetchMangaDex(q, page) {
  const limit = 24;
  const offset = (page - 1) * limit;
  const j = await getJSON(`${MD_API}/manga?title=${enc(q)}&limit=${limit}&offset=${offset}&includes[]=cover_art`
    + '&order[relevance]=desc&contentRating[]=safe&contentRating[]=suggestive');
  return {
    items: j.data.map(normalizeMD).filter((m) => !COLORED_RE.test(m.title)),
    hasNext: offset + limit < j.total,
  };
}

async function fetchKitsu(q, page) {
  const limit = 20;
  const offset = (page - 1) * limit;
  const j = await getJSON(`${KITSU_API}/manga?filter[text]=${enc(q)}&page[limit]=${limit}&page[offset]=${offset}`);
  return {
    items: j.data
      .filter((d) => d.attributes.subtype !== 'novel' && !d.attributes.nsfw && d.attributes.ageRating !== 'R18')
      .map(normalizeKitsu),
    hasNext: !!j.links?.next,
  };
}

/* Aynı mangayı farklı kaynaklardan bir kez göstermek için anahtarlar */
function keysOf(m) {
  const ks = new Set();
  for (const t of [m.title, m.romaji, m.native, ...(m.alts || [])]) {
    const k = normTitle(t);
    if (k.length >= 2) ks.add(`t:${k}`);
  }
  if (m.id.startsWith('al:')) ks.add(m.id);
  if (m.alId) ks.add(`al:${m.alId}`);
  return [...ks];
}

/* ---------- cilt sayısı bulma (devam eden seriler için) ---------- */

async function findMangaDexId(m) {
  const alId = m.id.startsWith('al:') ? m.id.slice(3) : null;
  const names = [...new Set([m.romaji, m.title, m.native].filter(Boolean))];
  const wanted = new Set(names.map(normTitle).filter((k) => k.length >= 2));
  for (const name of names.slice(0, 2)) {
    const j = await getJSON(`${MD_API}/manga?title=${enc(name)}&limit=10`
      + '&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&contentRating[]=pornographic');
    const hit = j.data.find((x) => alId && x.attributes.links?.al === alId)
      || j.data.find((x) => {
        const linked = x.attributes.links?.al;
        if (linked && alId && linked !== alId) return false; // başka bir eser
        if (COLORED_RE.test(mdTitle(x))) return false;
        return [x.attributes.title, ...(x.attributes.altTitles || [])]
          .some((o) => Object.values(o).some((v) => wanted.has(normTitle(v))));
      });
    if (hit) return hit.id;
  }
  return null;
}

async function mangaDexVolumes(m) {
  const id = m.id.startsWith('md:') ? m.id.slice(3) : await findMangaDexId(m);
  if (!id) return 0;
  const a = await getJSON(`${MD_API}/manga/${id}/aggregate`);
  const nums = Object.keys(a.volumes || {}).filter((k) => /^\d+$/.test(k)).map(Number).filter((n) => n < 2000);
  return nums.length ? Math.max(...nums) : 0;
}

async function kitsuVolumes(m) {
  const names = [...new Set([m.romaji, m.title].filter(Boolean))];
  const wanted = new Set(names.map(normTitle).filter((k) => k.length >= 2));
  for (const name of names.slice(0, 2)) {
    const j = await getJSON(`${KITSU_API}/manga?filter[text]=${enc(name)}&page[limit]=5`);
    const hit = j.data.find((d) => d.attributes.subtype !== 'novel'
      && Object.values(d.attributes.titles || {}).concat(d.attributes.canonicalTitle || '').some((v) => wanted.has(normTitle(v))));
    if (hit) return hit.attributes.volumeCount || 0;
  }
  return 0;
}

async function resolveVolumes(m) {
  const jobs = [mangaDexVolumes(m).catch(() => 0)];
  if (!m.id.startsWith('kt:')) jobs.push(kitsuVolumes(m).catch(() => 0));
  return Math.max(0, ...(await Promise.all(jobs)));
}

/* ---------- koleksiyon deposu ---------- */

function normId(id) {
  if (Number.isInteger(id) && id > 0) return `al:${id}`; // eski sürümden kalan kayıtlar
  return typeof id === 'string' && /^(al|md|kt|my):[\w-]{1,60}$/.test(id) ? id : null;
}

function sanitizeEntry(x) {
  const id = x && normId(x.id);
  if (!id || typeof x.title !== 'string') return null;
  if (x.list !== 'koleksiyon' && x.list !== 'istek') return null;
  const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
  const num = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : null);
  return {
    id,
    title: str(x.title) || 'Adsız',
    romaji: str(x.romaji),
    native: str(x.native),
    cover: /^https:\/\//.test(x.cover) ? x.cover : '',
    color: safeColor(x.color),
    volumes: num(x.volumes),
    volumesDerived: !!x.volumesDerived && !!num(x.volumes),
    chapters: num(x.chapters),
    status: str(x.status, 40),
    format: str(x.format, 40),
    year: num(x.year),
    score: num(x.score),
    genres: Array.isArray(x.genres) ? x.genres.filter((g) => typeof g === 'string').slice(0, 20) : [],
    description: str(x.description, 6000),
    origin: str(x.origin, 4),
    url: /^https:\/\/(anilist\.co|mangadex\.org|kitsu\.(io|app))\//.test(x.url) ? x.url : '',
    list: x.list,
    readStatus: READ_STATUS[x.readStatus] ? x.readStatus : 'okuyacagim',
    owned: Array.isArray(x.owned)
      ? [...new Set(x.owned.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 10000))].sort((a, b) => a - b)
      : [],
    extraVols: num(x.extraVols) || 0,
    added: Number.isFinite(x.added) ? x.added : Date.now(),
    refreshed: Number.isFinite(x.refreshed) ? x.refreshed : 0,
    volChecked: Number.isFinite(x.volChecked) ? x.volChecked : 0,
    hasCover: !!x.hasCover,
    unitPrice: Number.isFinite(x.unitPrice) && x.unitPrice > 0 && x.unitPrice < 1e6 ? Math.round(x.unitPrice * 100) / 100 : 0,
  };
}

const store = {
  items: {},

  load() {
    try {
      const data = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      for (const raw of Object.values(data.items || {})) {
        const e = sanitizeEntry(raw);
        if (e) this.items[e.id] = e;
      }
    } catch {
      this.items = {};
    }
  },

  save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ version: 2, items: this.items }));
    } catch {
      toast('Kaydedilemedi: tarayıcı depolaması dolu ya da kapalı.');
    }
    updateCounts();
  },

  list(kind) {
    return Object.values(this.items).filter((e) => e.list === kind);
  },
};

const totalVols = (e) => Math.max(e.volumes || 0, e.extraVols || 0);
const isOngoing = (m) => m.status === 'RELEASING' || !!m.volumesDerived;
const volumeText = (m) => (m.volumes ? `${m.volumes}${isOngoing(m) ? '+' : ''} cilt` : '');

function setList(m, list) {
  const existing = store.items[m.id];
  if (existing) {
    existing.list = list;
    if (list === 'koleksiyon' && !existing.readStatus) existing.readStatus = 'okuyacagim';
  } else {
    store.items[m.id] = sanitizeEntry({
      ...m, list, readStatus: 'okuyacagim', owned: [], extraVols: 0, added: Date.now(), refreshed: Date.now(),
    });
  }
  store.save();
}

function removeEntry(id) {
  if (store.items[id]?.hasCover) {
    covers.del(id).catch(() => {});
    covers.forget(id);
  }
  delete store.items[id];
  store.save();
}

/* ---------- kendi kapakların (IndexedDB) ---------- */

const covers = {
  dbp: null,
  db() {
    this.dbp ||= new Promise((resolve, reject) => {
      const req = indexedDB.open('manga-koleksiyon', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('covers');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbp;
  },
  async tx(mode, fn) {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const t = db.transaction('covers', mode);
      const r = fn(t.objectStore('covers'));
      t.oncomplete = () => resolve(r.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  },
  put(id, blob) { return this.tx('readwrite', (s) => s.put(blob, id)); },
  get(id) { return this.tx('readonly', (s) => s.get(id)); },
  del(id) { return this.tx('readwrite', (s) => s.delete(id)); },
  urls: new Map(),
  async url(id) {
    if (this.urls.has(id)) return this.urls.get(id);
    const blob = await this.get(id);
    if (!blob) return '';
    const u = URL.createObjectURL(blob);
    this.urls.set(id, u);
    return u;
  },
  forget(id) {
    const u = this.urls.get(id);
    if (u) URL.revokeObjectURL(u);
    this.urls.delete(id);
  },
};

/* Fotoğrafı kapak boyutuna küçült (depolama ve yedek şişmesin) */
async function makeCoverBlob(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 480 / bmp.width, 720 / bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('blob'))), 'image/jpeg', 0.82));
}

function coversChanged() {
  renderLocal('koleksiyon');
  renderLocal('istek');
  if (currentId && store.items[currentId]) renderDetail();
}

async function setCover(id, file) {
  const e = store.items[id];
  if (!e) return;
  try {
    await covers.put(id, await makeCoverBlob(file));
    covers.forget(id);
    e.hasCover = true;
    store.save();
    coversChanged();
    toast('Kapak kaydedildi');
  } catch {
    toast('Bu resim eklenemedi. Başka bir fotoğraf dene.');
  }
}

async function clearCover(id) {
  const e = store.items[id];
  if (!e) return;
  try { await covers.del(id); } catch { /* zaten yok */ }
  covers.forget(id);
  e.hasCover = false;
  store.save();
  coversChanged();
}

/* ---------- durum ---------- */

const state = { tab: 'kesfet' };
const discover = {
  search: '', genre: '', sort: 'POPULARITY_DESC',
  page: 0, hasNext: true, loading: false, error: false, token: 0, count: 0,
  seen: new Set(), src: { al: true, md: true, kt: true },
};
const local = {
  koleksiyon: { q: '', status: '', sort: 'added' },
  istek: { q: '', sort: 'added' },
};

/* ---------- kartlar ---------- */

/* Kendi eklediğin kapak varsa o, yoksa kaynaktan gelen kapak. Hiçbiri açılmazsa onFail çalışır. */
function coverImgEl(m, onFail) {
  const own = !!store.items[m.id]?.hasCover;
  if (!own && !m.cover) return null;
  const img = h('img', { alt: m.title, loading: 'lazy', decoding: 'async', onerror() { img.remove(); onFail?.(); } });
  const fallback = () => {
    if (m.cover) img.src = m.cover;
    else { img.remove(); onFail?.(); }
  };
  if (own) covers.url(m.id).then((u) => (u ? (img.src = u) : fallback())).catch(fallback);
  else img.src = m.cover;
  return img;
}

function coverImg(m) {
  const box = h('div', { class: 'cover', style: m.color ? `background:${m.color}` : null });
  const placeholder = () => box.append(h('div', { class: 'noimg', text: m.title }));
  const img = coverImgEl(m, placeholder);
  if (img) box.append(img);
  else placeholder();
  return box;
}

function metaLine(m) {
  return [FORMAT_TR[m.format], m.year, volumeText(m), m.score ? `★ ${(m.score / 10).toFixed(1)}` : '']
    .filter(Boolean).join(' · ');
}

function updateBadge(cardEl) {
  const e = store.items[cardEl.dataset.id];
  const badge = $('.badge', cardEl);
  badge.textContent = e ? (e.list === 'koleksiyon' ? 'Koleksiyonda' : 'İstekte') : '';
  badge.classList.toggle('wish', !!e && e.list === 'istek');
}

function card(m, { progress = false } = {}) {
  const cover = coverImg(m);
  cover.append(h('span', { class: 'badge' }));
  const el = h('button', { class: 'card', type: 'button', dataset: { id: m.id }, onclick: () => openDetail(m.id, m) },
    cover,
    h('div', { class: 'card-title', text: m.title }),
    h('div', { class: 'card-meta', text: metaLine(m) }),
  );
  if (progress) {
    const e = store.items[m.id];
    const total = totalVols(e);
    const pct = total ? Math.min(100, (e.owned.length / total) * 100) : 0;
    el.append(
      h('div', { class: `progress${pct >= 100 ? ' full' : ''}` }, h('i', { style: `width:${pct}%` })),
      h('div', { class: 'card-meta', text: total ? `${e.owned.length} / ${total} cilt` : `${e.owned.length} cilt` }),
    );
    $('.badge', el).textContent = READ_STATUS[e.readStatus];
  } else {
    updateBadge(el);
  }
  return el;
}

function refreshBadges() {
  document.querySelectorAll('#grid-kesfet .card').forEach(updateBadge);
}

/* ---------- Keşfet ---------- */

const grid = () => $('#grid-kesfet');

function setStatus(kind, msg) {
  const el = $('#status-kesfet');
  el.replaceChildren();
  if (kind === 'loading') el.append(h('div', { class: 'spinner', role: 'progressbar', 'aria-label': 'Yükleniyor' }));
  else if (kind === 'error') {
    el.append(h('p', { text: msg }), h('button', {
      class: 'btn', type: 'button', text: 'Tekrar dene',
      onclick() { discover.error = false; loadDiscover(); },
    }));
  } else if (kind === 'empty') {
    el.append(
      h('p', { text: 'Üç kaynakta da sonuç bulunamadı. Yazımı değiştirmeyi dene (örn. Japonca okunuşuyla).' }),
      discover.search
        ? h('button', { class: 'btn primary', type: 'button', text: `“${discover.search}” mangasını elle ekle`, onclick: () => openManual(discover.search) })
        : null,
    );
  }
}

async function loadDiscover(reset = false) {
  const d = discover;
  if (reset) {
    d.page = 0; d.hasNext = true; d.error = false; d.count = 0;
    d.seen = new Set(); d.src = { al: true, md: true, kt: true };
    grid().replaceChildren();
    setStatus();
  } else if (d.loading || !d.hasNext || d.error) return;

  const token = ++d.token;
  d.loading = true;
  setStatus('loading');
  try {
    // Aramada üç kaynak birden taranır; türe göre gezinirken yalnızca AniList (tür/sıralama ona özgü)
    const page = d.page + 1;
    const multi = !!d.search && !d.genre;
    const jobs = [];
    if (d.src.al) jobs.push(['al', fetchAniList(d, page)]);
    if (multi && d.src.md) jobs.push(['md', fetchMangaDex(d.search, page)]);
    if (multi && d.src.kt) jobs.push(['kt', fetchKitsu(d.search, page)]);

    const settled = await Promise.allSettled(jobs.map((j) => j[1]));
    if (token !== d.token) return;
    if (settled.every((s) => s.status === 'rejected')) throw settled[0].reason;

    const fresh = [];
    settled.forEach((s, i) => {
      if (s.status === 'rejected') return; // bu kaynak takıldı; diğerleri gösterilir
      const src = jobs[i][0];
      d.src[src] = s.value.hasNext;
      for (const m of s.value.items) {
        const keys = keysOf(m);
        if (src !== 'al' && keys.some((k) => d.seen.has(k))) continue; // aynı manga zaten listede
        keys.forEach((k) => d.seen.add(k));
        fresh.push(m);
      }
    });

    grid().append(...fresh.map((m) => card(m)));
    d.page = page;
    d.count += fresh.length;
    d.hasNext = d.src.al || (multi && (d.src.md || d.src.kt));
    setStatus(d.count === 0 ? 'empty' : null);
  } catch (err) {
    if (token !== d.token) return;
    d.error = true;
    setStatus('error', err.message);
  } finally {
    if (token === d.token) {
      d.loading = false;
      setTimeout(checkSentinel, 100);
    }
  }
}

function checkSentinel() {
  const d = discover;
  if (state.tab !== 'kesfet' || d.loading || !d.hasNext || d.error || !d.count) return;
  if ($('#sentinel').getBoundingClientRect().top < window.innerHeight + 600) loadDiscover();
}

/* ---------- Koleksiyon / İstek listesi ---------- */

function renderLocal(kind) {
  if (kind === 'koleksiyon') renderBackupBanner();
  const f = local[kind];
  const all = store.list(kind);
  const q = trLower(f.q.trim());
  const items = all.filter((e) => (!f.status || e.readStatus === f.status)
    && (!q || [e.title, e.romaji, e.native].some((s) => trLower(s).includes(q))));

  const byTitle = (a, b) => a.title.localeCompare(b.title, 'tr');
  const pct = (e) => (totalVols(e) ? e.owned.length / totalVols(e) : 0);
  if (f.sort === 'title') items.sort(byTitle);
  else if (f.sort === 'progress') items.sort((a, b) => pct(b) - pct(a) || byTitle(a, b));
  else items.sort((a, b) => b.added - a.added);

  const summary = $(`#summary-${kind}`);
  summary.replaceChildren();
  if (all.length) {
    summary.append(h('div', { class: 'stat' }, h('b', { text: all.length }), h('span', { text: 'manga' })));
    if (kind === 'koleksiyon') {
      const vols = all.reduce((n, e) => n + e.owned.length, 0);
      const done = all.filter((e) => e.readStatus === 'okudum').length;
      const reading = all.filter((e) => e.readStatus === 'okuyorum').length;
      summary.append(
        h('div', { class: 'stat' }, h('b', { text: vols }), h('span', { text: 'cilt' })),
        h('div', { class: 'stat' }, h('b', { text: reading }), h('span', { text: 'okunuyor' })),
        h('div', { class: 'stat' }, h('b', { text: done }), h('span', { text: 'bitirildi' })),
      );
      const spent = all.reduce((n, e) => n + e.unitPrice * e.owned.length, 0);
      if (spent > 0) summary.append(h('div', { class: 'stat' }, h('b', { text: fmtMoney(spent) }), h('span', { text: 'harcama' })));
    }
  }

  const g = $(`#grid-${kind}`);
  if (!items.length) {
    const msg = all.length
      ? h('div', { class: 'empty' }, h('h3', { text: 'Eşleşen manga yok' }), h('p', { text: 'Aramayı ya da filtreyi değiştir.' }))
      : h('div', { class: 'empty' },
        h('h3', { text: kind === 'koleksiyon' ? 'Koleksiyonun henüz boş' : 'İstek listen boş' }),
        h('p', { text: 'Keşfet sekmesinden manga arayıp ekleyebilirsin.' }),
        h('button', { class: 'btn primary', type: 'button', text: 'Keşfet’e git', onclick: () => switchTab('kesfet') }));
    msg.id = `grid-${kind}`;
    g.replaceWith(msg);
    return;
  }
  const gridEl = g.classList.contains('grid') ? g : h('div', { class: 'grid', id: `grid-${kind}` });
  if (gridEl !== g) g.replaceWith(gridEl);
  gridEl.replaceChildren(...items.map((e) => card(e, { progress: kind === 'koleksiyon' })));
}

/* ---------- Ayrıntı penceresi ---------- */

const dlg = () => $('#detail');
let currentId = null;
let currentManga = null;
const volCache = new Map(); // kayıtlı olmayan mangalar için oturum boyunca "en son ne zaman baktık"

function openDetail(id, m) {
  currentId = id;
  currentManga = store.items[id] || m;
  renderDetail();
  if (!dlg().open) dlg().showModal();
  const e = store.items[id];
  if (e && id.startsWith('al:') && navigator.onLine && Date.now() - e.refreshed > 86400000) refreshEntry(id);
  enrichVolumes(id);
}

async function refreshEntry(id) {
  try {
    const data = await gql(ONE_QUERY, { id: Number(id.slice(3)) });
    const e = store.items[id];
    if (!e || !data.Media) return;
    const n = normalize(data.Media);
    Object.assign(e, {
      title: n.title, romaji: n.romaji, native: n.native, cover: n.cover, color: n.color,
      chapters: n.chapters, status: n.status, format: n.format, year: n.year, score: n.score,
      genres: n.genres, description: n.description, origin: n.origin, url: n.url, refreshed: Date.now(),
    });
    if (n.volumes) { e.volumes = n.volumes; e.volumesDerived = false; } // bulunmuş cilt sayısı boşla ezilmesin
    store.save();
    if (currentId === id) { currentManga = e; renderDetail(); }
  } catch { /* çevrimdışıysa eldeki bilgi yeterli */ }
}

/* AniList'te cilt sayısı boşsa (devam eden seriler) MangaDex ve Kitsu'dan bul */
async function enrichVolumes(id) {
  const target = store.items[id] || currentManga;
  if (!target || target.id !== id || id.startsWith('my:') || !navigator.onLine) return;
  if (target.volumes && !target.volumesDerived && target.status === 'FINISHED') return;
  if (Date.now() - (target.volChecked || volCache.get(id) || 0) < VOL_RECHECK_MS) return;
  volCache.set(id, Date.now());

  const n = await resolveVolumes(target).catch(() => 0);
  const e = store.items[id] || (currentId === id ? currentManga : null);
  if (!e) return;
  if (n > (e.volumes || 0)) { e.volumes = n; e.volumesDerived = true; }
  if (store.items[id]) {
    e.volChecked = Date.now();
    store.save();
    renderLocal('koleksiyon');
    renderLocal('istek');
  }
  if (currentId === id) { currentManga = e; renderDetail(); }
}

function chip(text, cls = '') {
  return h('span', { class: `chip ${cls}`.trim(), text });
}

function sourceLabel(url) {
  if (/anilist\.co/.test(url)) return 'AniList’te aç ↗';
  if (/mangadex\.org/.test(url)) return 'MangaDex’te aç ↗';
  return 'Kitsu’da aç ↗';
}

function renderDetail() {
  const m = store.items[currentId] || currentManga;
  const e = store.items[currentId];
  const body = $('#detail-body');

  const cover = h('div', { class: 'detail-cover' });
  const coverEl = coverImgEl(m);
  if (coverEl) cover.append(coverEl);

  const chips = h('div', { class: 'chips' },
    m.score && chip(`★ ${(m.score / 10).toFixed(1)}`, 'score'),
    m.status && chip(STATUS_TR[m.status] || m.status, 'hl'),
    m.format && chip(FORMAT_TR[m.format] || m.format),
    m.origin && ORIGIN_TR[m.origin] && chip(ORIGIN_TR[m.origin]),
    m.year && chip(m.year),
    m.volumes && chip(volumeText(m), 'hl'),
    m.chapters && chip(`${m.chapters} bölüm`),
  );
  const genres = h('div', { class: 'chips' }, m.genres.map((g) => chip(GENRES[g] || g)));

  const actions = h('div', { class: 'actions' });
  if (!e) {
    actions.append(
      h('button', { class: 'btn primary', type: 'button', text: 'Koleksiyonuma ekle', onclick: () => change(() => setList(m, 'koleksiyon'), 'Koleksiyona eklendi') }),
      h('button', { class: 'btn', type: 'button', text: 'İstek listesine ekle', onclick: () => change(() => setList(m, 'istek'), 'İstek listesine eklendi') }),
    );
  } else if (e.list === 'istek') {
    actions.append(
      h('button', { class: 'btn primary', type: 'button', text: 'Koleksiyona taşı', onclick: () => change(() => setList(m, 'koleksiyon'), 'Koleksiyona taşındı') }),
      h('button', { class: 'btn danger', type: 'button', text: 'Listeden çıkar', onclick: () => change(() => removeEntry(m.id), 'Listeden çıkarıldı') }),
    );
  } else {
    actions.append(
      h('button', { class: 'btn danger', type: 'button', text: 'Koleksiyondan çıkar', onclick() {
        if (confirm(`“${m.title}” koleksiyondan çıkarılsın mı? İşaretlediğin ciltler silinir.`)) change(() => removeEntry(m.id), 'Koleksiyondan çıkarıldı');
      } }),
    );
  }
  if (m.url) actions.append(h('a', { class: 'btn', href: m.url, target: '_blank', rel: 'noopener noreferrer', text: sourceLabel(m.url) }));
  if (e) {
    actions.append(h('label', { class: 'btn' },
      e.hasCover ? 'Kapağı değiştir' : 'Kapak ekle',
      h('input', { type: 'file', accept: 'image/*', hidden: true, onchange(ev) {
        const file = ev.target.files[0];
        ev.target.value = '';
        if (file) setCover(m.id, file);
      } }),
    ));
    if (e.hasCover) actions.append(h('button', { class: 'btn', type: 'button', text: 'Kapağı kaldır', onclick: () => clearCover(m.id) }));
    if (m.id.startsWith('my:')) actions.append(h('button', { class: 'btn', type: 'button', text: 'Adı / cildi düzenle', onclick: () => openManual('', e) }));
  }

  const info = h('div', {},
    h('h2', { text: m.title }),
    (m.native && m.native !== m.title) || (m.romaji && m.romaji !== m.title)
      ? h('div', { class: 'alt', text: [m.romaji !== m.title && m.romaji, m.native].filter(Boolean).join(' · ') })
      : null,
    chips, genres,
    h('p', { class: 'desc', text: m.description || 'Bu manga için özet bulunmuyor.' }),
    actions,
    e && e.list === 'koleksiyon' ? collectionSection(e) : null,
  );

  body.replaceChildren(h('div', { class: 'detail' }, cover, info));
}

function collectionSection(e) {
  const total = totalVols(e);
  const owned = new Set(e.owned);
  const redraw = () => { store.save(); renderLocal('koleksiyon'); renderDetail(); };

  const statusSel = h('select', { 'aria-label': 'Okuma durumu', onchange(ev) {
    e.readStatus = ev.target.value;
    store.save(); renderLocal('koleksiyon');
  } });
  fillSelect(statusSel, READ_STATUS, e.readStatus);

  const toggle = (n) => {
    owned.has(n) ? owned.delete(n) : owned.add(n);
    e.owned = [...owned].sort((a, b) => a - b);
    redraw();
  };

  const vols = h('div', { class: 'vol-grid' });
  for (let n = 1; n <= total; n++) {
    vols.append(h('button', {
      class: `vol${owned.has(n) ? ' on' : ''}`, type: 'button', text: n,
      'aria-pressed': String(owned.has(n)), 'aria-label': `Cilt ${n}`, onclick: () => toggle(n),
    }));
  }

  const setAll = (all) => {
    e.owned = all ? Array.from({ length: total }, (_, i) => i + 1) : [];
    redraw();
  };
  const minVols = Math.max(e.volumes || 0, ...e.owned);
  const tools = h('div', { class: 'vol-tools' },
    total ? h('button', { class: 'btn small', type: 'button', text: 'Hepsi bende', onclick: () => setAll(true) }) : null,
    e.owned.length ? h('button', { class: 'btn small', type: 'button', text: 'Temizle', onclick: () => setAll(false) }) : null,
    h('button', { class: 'btn small', type: 'button', text: '+ Cilt', onclick() { e.extraVols = total + 1; redraw(); } }),
    h('button', { class: 'btn small', type: 'button', text: '− Cilt', disabled: total <= minVols, onclick() {
      e.extraVols = Math.max(minVols, total - 1); redraw();
    } }),
  );

  const missing = total ? Array.from({ length: total }, (_, i) => i + 1).filter((n) => !owned.has(n)) : [];
  const note = !total
    ? 'Bu mangada toplam cilt sayısı bulunamadı. “+ Cilt” ile kendin ekleyebilirsin.'
    : isOngoing(e)
      ? 'Devam eden seri: cilt sayısı kaynaklardan otomatik bulunur ve yeni ciltler çıktıkça güncellenir. Farklıysa “+ Cilt” ile düzeltebilirsin.'
      : '';

  const priceInput = h('input', {
    type: 'number', class: 'price', min: '0', step: 'any', inputmode: 'decimal', placeholder: 'örn. 95',
    'aria-label': 'Cilt başı fiyat', value: e.unitPrice || null,
    onchange(ev) {
      const v = ev.target.valueAsNumber;
      e.unitPrice = Number.isFinite(v) && v > 0 && v < 1e6 ? Math.round(v * 100) / 100 : 0;
      redraw();
    },
  });
  const spent = e.unitPrice * e.owned.length;

  return h('div', { class: 'section' },
    h('h3', { text: 'Koleksiyon durumu' }),
    h('div', { class: 'field' }, h('span', { text: 'Okuma durumu' }), statusSel),
    h('div', { class: 'field' }, h('span', { text: 'Cilt başı fiyat (₺)' }), priceInput,
      spent > 0 ? h('span', { class: 'spent', text: `Harcama: ${fmtMoney(spent)} (${e.owned.length} × ${fmtMoney(e.unitPrice)})` }) : null),
    h('div', { class: 'vol-head' },
      h('strong', { text: total ? `Ciltlerim: ${e.owned.length} / ${total}${isOngoing(e) ? '+' : ''}` : `Ciltlerim: ${e.owned.length}` }),
      tools,
    ),
    total ? vols : null,
    note ? h('p', { class: 'muted small', text: note }) : null,
    missing.length && missing.length < total
      ? h('p', { class: 'missing', text: `Eksik: ${summarizeRanges(missing)}` })
      : null,
  );
}

function summarizeRanges(nums) {
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(j - i >= 2 ? `${nums[i]}–${nums[j]}` : nums.slice(i, j + 1).join(', '));
    i = j;
  }
  return out.join(', ');
}

function change(fn, message) {
  fn();
  if (message) toast(message);
  refreshBadges();
  renderLocal('koleksiyon');
  renderLocal('istek');
  if (store.items[currentId]) { renderDetail(); enrichVolumes(currentId); }
  else dlg().close();
}

/* ---------- elle manga ekleme ---------- */

function openManual(prefill = '', edit = null) {
  const form = $('#manual-form');
  form.reset();
  form.dataset.edit = edit ? edit.id : '';
  form.elements.title.value = edit ? edit.title : prefill;
  form.elements.volumes.value = edit?.volumes || '';
  $('#manual-title').textContent = edit ? 'Mangayı düzenle' : 'Elle manga ekle';
  $('#manual-intro').hidden = !!edit;
  form.querySelector('[data-when="add"]').hidden = !!edit;
  form.querySelector('[data-when="edit"]').hidden = !edit;
  if (!$('#manual').open) $('#manual').showModal();
  form.elements.title.focus();
}

function setupManual() {
  document.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-manual]')) openManual(state.tab === 'kesfet' ? discover.search : '');
  });
  $('#manual-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.currentTarget);
    const title = String(fd.get('title')).trim();
    if (!title) return;
    const vols = parseInt(fd.get('volumes'), 10);

    const editId = ev.currentTarget.dataset.edit;
    if (editId && store.items[editId]) {
      const e = store.items[editId];
      e.title = title.slice(0, 300);
      e.volumes = vols > 0 ? vols : null;
      store.save();
      $('#manual').close();
      renderLocal('koleksiyon');
      renderLocal('istek');
      if (currentId === editId) { currentManga = e; renderDetail(); }
      toast('Kaydedildi');
      return;
    }

    const list = ev.submitter?.value === 'istek' ? 'istek' : 'koleksiyon';
    const m = {
      id: `my:${Date.now().toString(36)}`, title, romaji: '', native: '', cover: '', color: '',
      volumes: vols > 0 ? vols : null, volumesDerived: false, chapters: null, status: '', format: 'MANGA',
      year: null, score: null, genres: [], description: '', origin: '', url: '',
    };
    setList(m, list);
    $('#manual').close();
    renderLocal('koleksiyon');
    renderLocal('istek');
    refreshBadges();
    toast(list === 'istek' ? 'İstek listesine eklendi' : 'Koleksiyona eklendi');
    openDetail(m.id, store.items[m.id]);
  });
}

/* ---------- sekmeler ve arama ---------- */

const PLACEHOLDER = { kesfet: 'Manga ara…', koleksiyon: 'Koleksiyonda ara…', istek: 'İstek listesinde ara…' };

function updateCounts() {
  for (const kind of ['koleksiyon', 'istek']) {
    const el = $(`#count-${kind}`);
    const n = store.list(kind).length;
    el.textContent = n;
    el.toggleAttribute('data-zero', n === 0);
  }
}

function switchTab(tab) {
  state.tab = tab;
  for (const t of document.querySelectorAll('.tab')) {
    if (t.dataset.tab === tab) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  }
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${tab}`;
  const input = $('#search');
  input.placeholder = PLACEHOLDER[tab];
  input.value = tab === 'kesfet' ? discover.search : local[tab].q;
  if (tab !== 'kesfet') renderLocal(tab);
  window.scrollTo(0, 0);
  try { history.replaceState(null, '', `#${tab}`); } catch { /* önemsiz */ }
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function setupUI() {
  fillSelect($('#genre'), { '': 'Tümü', ...GENRES }, '');
  fillSelect($('#sort'), DISCOVER_SORTS, discover.sort);
  fillSelect($('#filter-status'), { '': 'Tümü', ...READ_STATUS }, '');
  fillSelect($('#sort-koleksiyon'), LOCAL_SORTS, 'added');
  fillSelect($('#sort-istek'), { added: LOCAL_SORTS.added, title: LOCAL_SORTS.title }, 'added');

  $('#genre').addEventListener('change', (ev) => { discover.genre = ev.target.value; loadDiscover(true); });
  $('#sort').addEventListener('change', (ev) => { discover.sort = ev.target.value; loadDiscover(true); });
  $('#filter-status').addEventListener('change', (ev) => { local.koleksiyon.status = ev.target.value; renderLocal('koleksiyon'); });
  $('#sort-koleksiyon').addEventListener('change', (ev) => { local.koleksiyon.sort = ev.target.value; renderLocal('koleksiyon'); });
  $('#sort-istek').addEventListener('change', (ev) => { local.istek.sort = ev.target.value; renderLocal('istek'); });

  const onSearch = debounce((value) => {
    if (state.tab === 'kesfet') {
      if (value.trim() === discover.search) return;
      discover.search = value.trim();
      loadDiscover(true);
    } else {
      local[state.tab].q = value;
      renderLocal(state.tab);
    }
  }, 400);
  $('#search').addEventListener('input', (ev) => onSearch(ev.target.value));

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // Pencereler: × düğmesi ve arka plana tıklayınca kapat
  for (const d of document.querySelectorAll('dialog')) {
    d.addEventListener('click', (ev) => {
      if (ev.target === d || ev.target.closest('[data-close]')) d.close();
    });
  }
  $('#detail').addEventListener('close', () => { currentId = null; currentManga = null; });
  $('#open-settings').addEventListener('click', () => { updateBackupInfo(); $('#settings').showModal(); });

  // Sonsuz kaydırma
  new IntersectionObserver((entries) => {
    if (entries.some((en) => en.isIntersecting)) checkSentinel();
  }, { rootMargin: '600px' }).observe($('#sentinel'));

  setupManual();
  setupBackup();
}

/* ---------- yedekleme ---------- */

const backupMeta = {
  read() {
    try { return JSON.parse(localStorage.getItem(BACKUP_KEY) || '{}'); } catch { return {}; }
  },
  write(patch) {
    try { localStorage.setItem(BACKUP_KEY, JSON.stringify({ ...this.read(), ...patch })); } catch { /* önemsiz */ }
  },
};

function backupState() {
  const items = Object.values(store.items);
  const { last = 0, snooze = 0 } = backupMeta.read();
  const base = last || Math.min(Infinity, ...items.map((e) => e.added)); // hiç yedek yoksa ilk ekleme tarihinden say
  return {
    last,
    days: last ? Math.floor((Date.now() - last) / 86400000) : null,
    due: items.length >= 3 && Date.now() >= snooze && Date.now() - base > BACKUP_DAYS * 86400000,
  };
}

function renderBackupBanner() {
  const el = $('#backup-banner');
  const { days, due } = backupState();
  el.hidden = !due;
  if (!due) return;
  el.replaceChildren(
    h('span', { text: days == null
      ? 'Koleksiyonunun yedeği yok. Telefon değişirse ya da tarayıcı verisi silinirse kaybolur.'
      : `Son yedeğin ${days} gün önce alındı.` }),
    h('div', { class: 'row' },
      h('button', { class: 'btn small primary', type: 'button', text: 'Yedek al', onclick: () => (canShareFile() ? shareBackup() : downloadBackup()) }),
      h('button', { class: 'btn small', type: 'button', text: 'Sonra', onclick() {
        backupMeta.write({ snooze: Date.now() + 3 * 86400000 });
        renderBackupBanner();
      } }),
    ),
  );
}

function updateBackupInfo() {
  const { last } = backupMeta.read();
  $('#backup-info').textContent = last
    ? `Son yedek: ${new Date(last).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' })}`
    : 'Henüz yedek almadın.';
}

function markBackedUp() {
  backupMeta.write({ last: Date.now(), snooze: 0 });
  renderBackupBanner();
  updateBackupInfo();
}

const blobToDataURL = (b) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(b);
});

async function buildBackupFile() {
  const coverData = {};
  for (const e of Object.values(store.items)) {
    if (!e.hasCover) continue;
    try {
      const b = await covers.get(e.id);
      if (b) coverData[e.id] = await blobToDataURL(b);
    } catch { /* bu kapak yedeğe girmez */ }
  }
  const payload = { app: 'manga-koleksiyon', version: 3, exported: new Date().toISOString(), items: store.items, covers: coverData };
  return new File([JSON.stringify(payload)], `manga-koleksiyon-${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' });
}

async function downloadBackup() {
  const file = await buildBackupFile();
  const a = h('a', { href: URL.createObjectURL(file), download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  markBackedUp();
  toast('Yedek indirildi');
}

function canShareFile() {
  try {
    return !!navigator.canShare && navigator.canShare({ files: [new File(['{}'], 'a.json', { type: 'application/json' })] });
  } catch { return false; }
}

async function shareBackup() {
  const file = await buildBackupFile();
  try {
    await navigator.share({ files: [file], title: 'Manga koleksiyon yedeği' });
    markBackedUp();
    toast('Yedek gönderildi');
  } catch (err) {
    if (err.name !== 'AbortError') toast('Paylaşılamadı. “Dışa aktar” ile indirmeyi dene.');
  }
}

function setupBackup() {
  $('#export').addEventListener('click', downloadBackup);
  const shareBtn = $('#share-backup');
  shareBtn.hidden = !canShareFile();
  shareBtn.addEventListener('click', shareBackup);

  $('#import').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const incoming = Object.values(data.items || {}).map(sanitizeEntry).filter(Boolean);
      if (!incoming.length) throw new Error('empty');
      for (const e of incoming) {
        if (e.hasCover) { // yedekteki kapak resmini geri yükle
          const url = data.covers?.[e.id];
          try {
            if (typeof url !== 'string' || !url.startsWith('data:image/')) throw new Error('kapak yok');
            await covers.put(e.id, await (await fetch(url)).blob());
            covers.forget(e.id);
          } catch { e.hasCover = false; }
        }
        store.items[e.id] = e;
      }
      store.save();
      renderLocal('koleksiyon');
      renderLocal('istek');
      refreshBadges();
      $('#settings').close();
      toast(`${incoming.length} manga içe aktarıldı`);
    } catch {
      toast('Bu dosya okunamadı. Uygulamadan aldığın bir yedek dosyası seç.');
    }
  });

  $('#wipe').addEventListener('click', () => {
    if (!confirm('Koleksiyonun ve istek listen tamamen silinecek. Bu işlem geri alınamaz. Emin misin?')) return;
    for (const e of Object.values(store.items)) {
      if (e.hasCover) { covers.del(e.id).catch(() => {}); covers.forget(e.id); }
    }
    store.items = {};
    store.save();
    renderLocal('koleksiyon');
    renderLocal('istek');
    refreshBadges();
    $('#settings').close();
    toast('Tüm veriler silindi');
  });
}

/* ---------- başlangıç ---------- */

store.load();
setupUI();
updateCounts();
const startTab = ['kesfet', 'koleksiyon', 'istek'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'kesfet';
switchTab(startTab);
loadDiscover(true);

// Tarayıcıdan "bu siteyi silme" izni iste (verilerin kendiliğinden temizlenmesini zorlaştırır)
navigator.storage?.persist?.().catch(() => {});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* önemsiz */ });
}
