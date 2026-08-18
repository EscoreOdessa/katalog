// build.mjs — самодостатній збірник каталогу (для GitHub Action).
// Читає наявний public catalog.json як СИД (7 таблиць), оновлює живі джерела
// (YugTorg + Atmo) і перезаписує catalog.json. Ціни не показуємо.
import { readFileSync, writeFileSync } from "fs";

// ---------- helpers ----------
async function fetchHtml(url, cookie) {
  const res = await fetch(url, {
    headers: { cookie: cookie || "", "user-agent": "Mozilla/5.0 (catalog-bot ESCORE)", "accept-language": "uk,ru;q=0.9" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const html = await res.text();
  if (/name="password"|Авторизація/i.test(html) && !/warehouse|Склад|Артикул|кВт/i.test(html))
    throw new Error("не авторизовано (cookie протух?)");
  return html;
}
const stripTags = (s) => (s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
function normAvail(t) {
  const s = (t || "").toLowerCase();
  if (/нет наличия|немає в наявн|розпрод|закінч/.test(s)) return "no";
  if (/очіку|ожида|в производстве|у резерв|передзамов|під замов|\d{1,2}[.\-/]\d{1,2}/.test(s)) return "soon";
  if (/є в наявн|в наявн|в наличии|\+/.test(s)) return "yes";
  return "no";
}
function classify(name) {
  const s = name || "";
  if (/deye/i.test(s) && /(BOS|SE-F|SE-G|LiFePO|акумул|батаре|АКБ)/i.test(s)) return "bat";
  if (/deye/i.test(s) && /(інверт|инверт|SUN-?\d)/i.test(s)) return "inv";
  if (/(сонячн(а|у) панел|солнечн(ая|ую) панел|фотомодул)/i.test(s) ||
      /\b(Longi|Jinko|JA Solar|Canadian|Risen|Trina|Tongwei|ReneSola|Luxen|Sunerise|Solitek)\b/i.test(s)) return "pan";
  return null;
}
function parseInverter(name) {
  const s = name.toUpperCase();
  const kwM = s.match(/(\d{1,3})\s*К?ВТ/) || s.match(/SUN-?(\d{1,3})K/);
  let ph = null;
  if (/ТРЕХФАЗ|ТРИФАЗ|3\s*ФАЗ|LP3|HP3/.test(s)) ph = 3; else if (/ОДНОФАЗ|1\s*ФАЗ|LP1|HP1/.test(s)) ph = 1;
  return { kw: kwM ? Number(kwM[1]) : null, ph, hv: /\bHV\b|HP3|HP1/.test(s) };
}
function parseBattery(name) {
  const m = name.match(/([\d.,]+)\s*(?:кВт\s*[·*\-]?\s*год|квт\s*[·*\-]?\s*год|kwt|kwh)/i);
  return { kwh: m ? Number(m[1].replace(",", ".")) : null, hv: /BOS|HV/i.test(name) && !/48\s?[ВB]/i.test(name) };
}
function parsePanelWatt(name) {
  const s = name || "";
  // 1) явна одиниця: "620 W", "450Вт", "600 Wp"
  const u = s.match(/(\d{3,4})\s*(?:wp|w|вт|ватт)\b/i);
  if (u) return Number(u[1]);
  // 2) інакше — перше число 100..900, що НЕ є частиною габариту (не оточене * х ×)
  const re = /(?<![\d.,])(\d{3,4})(?![\d.,])/g; let m;
  while ((m = re.exec(s))) {
    const n = Number(m[1]); if (n < 100 || n > 900) continue; // 1722/2382 тощо — це розмір, не ват
    const before = s.slice(Math.max(0, m.index - 2), m.index);
    const after = s.slice(re.lastIndex, re.lastIndex + 2);
    if (/[*хx×]\s*$/i.test(before) || /^\s*[*хx×]/i.test(after)) continue; // частина розміру
    return n;
  }
  return null;
}
function parseDim(s) { // повертає {dim:"1722×1134", len:1722} з тексту, якщо є габарит
  const m = (s || "").match(/(\d{3,4})\s*[*хx×]\s*(\d{3,4})/i);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  if (a < 300 || b < 300 || a > 3000 || b > 3000) return null;
  return { dim: Math.max(a, b) + "×" + Math.min(a, b), len: Math.max(a, b) };
}
function panelSize(len, watt) { // 'small' | 'med' | 'large'
  // Пороги від Anna: малі ≤465Вт (≈1762мм), середні 466–485Вт (≈1800мм), великі >485Вт.
  if (watt != null) return watt <= 465 ? "small" : watt <= 485 ? "med" : "large";
  if (len) return len <= 1780 ? "small" : len <= 1850 ? "med" : "large";
  return null;
}
function panelInfo(name, cells) { // watt (виправлено) + розмір + клас
  const watt = parsePanelWatt(name);
  let d = parseDim(name);
  if (!d && cells) for (const c of cells) { d = parseDim(c); if (d) break; } // напр. колонка «Розмір» у таблиці
  return { watt, dim: d ? d.dim : null, len: d ? d.len : null, size: panelSize(d ? d.len : null, watt) };
}
function panelBrand(name) { const b = name.match(/\b(Longi|Jinko|JA Solar|JA|Canadian|Risen|Trina|Tongwei|ReneSola|Luxen|Sunerise|Solitek)\b/i); return b ? b[1] : null; }
const D = (id) => "https://drive.google.com/file/d/" + id + "/view";
function datasheetFor(it) {
  if (it.cat !== "pan") return null; const m = (it.model || "").toUpperCase(); const b = (it.brand || "").toLowerCase(); const w = it.watt;
  if (b.includes("longi")) { if (w===445) return D("1ZePdEDRupd_OoEUU6qsmearNHtEv3pra"); if (w===480||w===485) return D("1DJ40A4QXEG71i5j1QOE6r2C2iqNFkcC_"); if (w===615) return D("1MlcaC8l-yIgtavlFrtcqZR98h6gM_0MF"); if (w===620) return /72HGD/.test(m)?D("1PDTfzF7RApdLF7sG3ySxyDg_xUmyheRv"):D("1MlcaC8l-yIgtavlFrtcqZR98h6gM_0MF"); if (w===645) return D("1awbrcqFqujX77zM1CCkLPVTOH6ZThu6R"); if (w===650) return D("18vt_4LfNzNBPMKKYBYMTfVZ-M1-IO7AC"); if (w===655) return D("1XX1WB0Pvjqllv5qle992UKZGPpRZawKt"); }
  if (b.includes("jinko")) { if (w===450||w===460) return D("1rQq46SwyXfR6EoaZnFjxJMhFJthhOmhS"); if (w===465) return D("1sx19xz6qhNZ6PZvKS36BnzrPMBAXpYPz"); if (w===590) return D("1q61Dx6h1XHQHT3IdEXo7S_rGO2uNfxx7"); if (w===620) return D("1-nWc28iHCpss_BOgYc1qyYEH0ekZPHJ5"); if (w===625) return D("1zfwuKd82B4Cy2PT-TBkzEbeS2vll8Mui"); if (w===630) return D("1H1wfgeHAryi7Qff5ohPSk6sL0H4X2pol"); }
  if (b==="ja"||b.includes("ja solar")) { if (w===460||w===465) return D("1AbwcWmCHFu9JeLwTtWZ1nMq0zICzerp8"); if (w===590) return D("1eSkLlyrdzWbX8Qq-mQu1lP_oOokyCQLM"); if (w===610) return D("1fHykKDHWKVpoZWy9q7PMKX4Y8fHiX6Xz"); if (w===620) return D("15vPIPgHKePAYoKoh344hBn4l94hj5gX4"); if (w===630) return D("19JSAtWLa-1qLTDawNAy4aMpk_gDqApcM"); if (w===635) return D("1PTHpfwXQ-JbaTy02E2BaJdFNb-qgECF4"); if (w===645) return D("1eTdcKnEmSge1LgnMpB0VuYth7PXovvE_"); }
  return null;
}

// ---------- YugTorg (OpenCart, HTML, класи name_good/warehouse) ----------
const YUG_BASE = "https://b2b.yugtorg.com/index.php?route=product/category&category_id=";
const YUG_CATS = [38429, 36851, 32360, 44908, 37262, 30211, 38559, 38558, 31271, 38584];
async function yugtorg() {
  const cookie = process.env.YUGTORG_COOKIE;
  if (!cookie) { console.warn("YugTorg: немає YUGTORG_COOKIE — пропускаю"); return []; }
  const items = [];
  for (const cid of YUG_CATS) {
    for (let page = 1; page <= 8; page++) {
      let rows = [];
      try {
        const html = await fetchHtml(`${YUG_BASE}${cid}&limit=100&page=${page}`, cookie);
        for (const r of html.split(/<tr[\s>]/i).slice(1)) {
          const nm = r.match(/name_good[^>]*>([\s\S]*?)<\/td>/i), wh = r.match(/warehouse[^>]*>([\s\S]*?)<\/td>/i);
          if (nm && wh) rows.push({ name: stripTags(nm[1]), avail: normAvail(stripTags(wh[1])) });
        }
      } catch (e) { console.warn(`YugTorg cat ${cid} p${page}: ${e.message}`); break; }
      if (!rows.length) break;
      for (const { name, avail } of rows) {
        const cat = classify(name); if (!cat) continue;
        if (cat === "inv") { const s = parseInverter(name); if (s.kw) items.push({ cat, model: name, sup: "YugTorg", avail, ...s }); }
        else if (cat === "bat") { const s = parseBattery(name); items.push({ cat, model: name, sup: "YugTorg", avail, ...s }); }
        else { const pi = panelInfo(name); if (pi.watt != null || pi.len != null) items.push({ cat, model: name, sup: "YugTorg", avail, watt: pi.watt, brand: panelBrand(name), dim: pi.dim, size: pi.size }); }
      }
    }
  }
  console.log(`YugTorg: ${items.length} позицій`);
  return items;
}

// ---------- Atmo (api-my.atmo.pro, JSON API, логін email/пароль → Bearer-токен) ----------
const ATMO_BASE = "https://api-my.atmo.pro";
const ATMO_CATS = [448, 494, 202]; // Інвертори (448), Акумуляторні батареї (494), Фотоелектричні модулі (202)
function deepFindToken(o) {
  if (!o || typeof o !== "object") return null;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (typeof v === "string" && /token/i.test(k) && !/expir/i.test(k) && v.length > 20) return v;
  }
  for (const k of Object.keys(o)) { const r = deepFindToken(o[k]); if (r) return r; }
  return null;
}
function atmoAvail(q) {
  if (!q) return "no";
  // ВАЖЛИВО: available = free + reserved. Орієнтуємось на ВІЛЬНИЙ залишок (без резерву),
  // інакше повністю зарезервовані позиції хибно показуються як «в наявності».
  const free = (typeof q.free === "number") ? q.free : (q.available || 0) - (q.reserved || 0);
  if (free > 0) return "yes";
  if ((q.expected || 0) > 0) return "soon"; // вільного немає, але очікується поставка
  return "no";                              // все в резерві / немає
}
async function atmoLogin() {
  const email = process.env.ATMO_EMAIL, password = process.env.ATMO_PASSWORD;
  if (!email || !password) { console.warn("Atmo: немає ATMO_EMAIL/ATMO_PASSWORD — пропускаю"); return null; }
  const res = await fetch(`${ATMO_BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) { console.warn("Atmo login: HTTP " + res.status + " (перевір ATMO_EMAIL/ATMO_PASSWORD)"); return null; }
  const tok = deepFindToken(await res.json());
  if (!tok) console.warn("Atmo: токен не знайдено у відповіді логіна");
  return tok;
}
async function atmo() {
  const tok = await atmoLogin();
  if (!tok) return [];
  const H = { headers: { authorization: "Bearer " + tok, accept: "application/json" } };
  const items = [];
  for (const cid of ATMO_CATS) {
    for (let page = 1; page <= 40; page++) {
      let j;
      try {
        const url = `${ATMO_BASE}/api/v1/products?pagination[page]=${page}&pagination[per_page]=100&filters[categoryId]=${cid}`;
        const res = await fetch(url, H);
        if (!res.ok) { console.warn(`Atmo cat ${cid} p${page}: HTTP ${res.status}`); break; }
        j = await res.json();
      } catch (e) { console.warn(`Atmo cat ${cid} p${page}: ${e.message}`); break; }
      const rows = (j.data && j.data.data) || [];
      if (!rows.length) break;
      for (const p of rows) {
        const name = p.name || "";
        const cat = classify(name); if (!cat) continue;
        const avail = atmoAvail(p.quantity);
        if (cat === "inv") { const s = parseInverter(name); if (s.kw) items.push({ cat, model: name, sup: "Atmo", avail, ...s }); }
        else if (cat === "bat") { const s = parseBattery(name); items.push({ cat, model: name, sup: "Atmo", avail, ...s }); }
        else { const pi = panelInfo(name); if (pi.watt != null || pi.len != null) items.push({ cat, model: name, sup: "Atmo", avail, watt: pi.watt, brand: panelBrand(name), dim: pi.dim, size: pi.size }); }
      }
      const pi = j.data && j.data.paginatorInfo;
      if (pi && (pi.hasMorePages === false || (pi.currentPage && pi.lastPage && pi.currentPage >= pi.lastPage))) break;
    }
  }
  console.log(`Atmo: ${items.length} позицій`);
  return items;
}

// ---------- Google Sheets постачальників (публічні, gviz CSV, без логіну) ----------
// Живі: Sakoenergy, Intersolar, Helius, SunRise + Solarity (через публічне дзеркало IMPORTRANGE).
// Altek/Vimmer поки лишаються сидом (нестандартна верстка).
// Дзеркало Solarity: приватна таблиця постачальника → Anna робить публічне дзеркало з 3 вкладками
// (panels / inv / bat, кожна IMPORTRANGE відповідної вкладки Solarity). ID підставляється нижче.
const SOLARITY_MIRROR = process.env.SOLARITY_MIRROR || "1i3u_awTfs-TMYt1YvHqXmfzguB_ThPGSt4bJYh4vg70"; // публічне дзеркало Solarity
const SHEETS_LIVE = [
  { sup: "Sakoenergy", id: "1fL5fwlGeWSeiogJFD6NeXQrmtdD3-SeDZljh0XYMBRc" },
  { sup: "Intersolar", id: "1urSlWzmui3nszA03kA9XFUoXgFhUHwUFRfraaiC5hE8" },
  { sup: "Helius", id: "1ddbl4d574RN5Q4WDMg4WW13heV_hOyYy" },
  { sup: "SunRise", id: "1Wog9MpKlV90ItO3GfagvxUHqGbWPLiZJ9fJnL_KbAFc" },
  ...(SOLARITY_MIRROR ? [
    { sup: "Solarity", id: SOLARITY_MIRROR, tab: "panels" },
    { sup: "Solarity", id: SOLARITY_MIRROR, tab: "inv" },
    { sup: "Solarity", id: SOLARITY_MIRROR, tab: "bat" },
  ] : []),
];
const KNOWN_BRAND = /deye|longi|jinko|ja solar|\bja\b|canadian|risen|trina|tongwei|renesola|luxen|sunerise|solitek/i;
const normCell = (s) => {
  const v = (s || "").replace(/[‐‑‒–—−]/g, "-").replace(/ /g, " ").replace(/\s+/g, " ").trim();
  return /^#(REF|N\/A|ERROR|VALUE|DIV|NAME|NUM|NULL)!?/i.test(v) ? "" : v; // ігнор помилок формул (#REF! у колонці бренду)
};
function sectionOf(cells) {
  const ne = cells.map(normCell).filter(Boolean);
  const uniq = [...new Set(ne)];
  if (uniq.length !== 1 || uniq[0].length >= 60) return "";
  const v = uniq[0];
  // не плутати з рядком-товаром (модель): напр. "SUN-5K", "450 Вт", "BOS-G"
  if (/\d{2,}\s*(вт|w|kw|кв|год)/i.test(v) || /(SUN|BOS|SE-)[\s-]?\d/i.test(v)) return "";
  return v;
}
function parseCSV(s) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { row.push(cur); cur = ""; } else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; } else if (c === "\r") {} else cur += c; }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
function sheetAvail(t) {
  // Увага: \b у JS-regex не працює з кирилицею — не використовувати навколо укр/рос слів.
  const s = (t || "").toLowerCase();
  if (/нема|стоп|розпрод|закінчил|знято|відсутн|нет налич|нет в/.test(s)) return "no";
  if (/в наявн|наявн|сьогодн|в налич/.test(s)) return "yes";
  return "soon"; // очікується/предзамовлення/в дорозі/в роботі/дата/порожньо → консервативно "скоро"
}
async function sheets() {
  const items = [];
  for (const { sup, id, tab } of SHEETS_LIVE) {
    const label = sup + (tab ? "/" + tab : "");
    try {
      const url = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv` + (tab ? `&sheet=${encodeURIComponent(tab)}` : "");
      const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (catalog-bot ESCORE)" }, redirect: "follow" });
      if (!res.ok) { console.warn(`${label}: HTTP ${res.status}`); continue; }
      const rows = parseCSV(await res.text());
      let availCol = -1;
      for (let i = 0; i < Math.min(rows.length, 25) && availCol < 0; i++)
        for (let j = 0; j < rows[i].length; j++) if (/наявн|статус|status/i.test(rows[i][j] || "")) { availCol = j; break; }
      let section = "", n = 0;
      for (const cells of rows) {
        const sec = sectionOf(cells); if (sec) { section = sec; continue; }
        // 1) пряме розпізнавання: перша ячейка, що класифікується за назвою
        let cat = null, model = null;
        for (const c of cells) { const cc = normCell(c); if (cc.length >= 8) { const k = classify(cc); if (k) { cat = k; model = cc; break; } } }
        // 2) фолбек для секцій без бренду в рядку (напр. Deye у Solarity): найдовша «літерна» ячейка + бренд секції
        if (!cat) {
          let cand = ""; for (const c of cells) { const cc = normCell(c); if (/[a-zа-яіїєґ]/i.test(cc) && cc.length > cand.length) cand = cc; }
          if (cand.length >= 6) {
            let name = cand;
            if (!KNOWN_BRAND.test(name) && /deye/i.test(section)) name = "Deye " + name;
            const k = classify(name); if (k) { cat = k; model = name; }
          }
        }
        if (!cat) continue;
        model = normCell(model);
        if (/бренд|модель|наявність|прайс|найменування/i.test(model)) continue; // рядок-шапка, не товар
        let raw = availCol >= 0 ? (cells[availCol] || "") : "";
        if (!raw) raw = cells.find((c) => /наявн|немає|стоп|дороз|очіку|замов/i.test(c || "")) || "";
        const avail = sheetAvail(raw);
        if (cat === "inv") { const s = parseInverter(model); if (s.kw) { items.push({ cat, model, sup, avail, ...s }); n++; } }
        else if (cat === "bat") { const s = parseBattery(model); items.push({ cat, model, sup, avail, ...s }); n++; }
        else { const pi = panelInfo(model, cells); if (pi.watt != null || pi.len != null) { items.push({ cat, model, sup, avail, watt: pi.watt, brand: panelBrand(model), dim: pi.dim, size: pi.size }); n++; } }
      }
      console.log(`${label}: ${n} позицій`);
    } catch (e) { console.warn(`${label}: ${e.message}`); }
  }
  return items;
}

// ---------- main ----------
async function main() {
  const prev = JSON.parse(readFileSync("catalog.json", "utf8"));
  const live = await yugtorg();
  let liveAtmo = [];
  try { liveAtmo = await atmo(); } catch (e) { console.warn("Atmo failed: " + e.message); }
  let liveSheets = [];
  try { liveSheets = await sheets(); } catch (e) { console.warn("sheets failed: " + e.message); }
  const allLive = [...live, ...liveAtmo, ...liveSheets];
  // будь-який постачальник, що дав живі дані, замінює свій сид; хто не відповів — лишається зі снимка
  const gotSups = new Set(allLive.map((i) => i.sup));
  const seed = (prev.items || []).filter((i) => !gotSups.has(i.sup));
  const items = [...seed, ...allLive];
  for (const it of items) { if (!it.ds) { const ds = datasheetFor(it); if (ds) it.ds = ds; } delete it.brand; }
  const out = { generated: new Date().toISOString().slice(0, 10), note: "Постачальники вживу: YugTorg, Atmo, Sakoenergy, Intersolar, Helius, SunRise. Altek/Vimmer/Solarity — снимок. Ціни не показуються.", items };
  writeFileSync("catalog.json", JSON.stringify(out, null, 1));
  console.log(`catalog.json: ${items.length} позицій (сид ${seed.length} + YugTorg ${live.length} + Atmo ${liveAtmo.length} + таблиці ${liveSheets.length})`);
}
main();
