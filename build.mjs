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
function parsePanelWatt(name) { const m = name.match(/(\d{3,4})\s*(?:w|вт|wp)\b/i) || name.match(/\b(\d{3,4})\b/); return m ? Number(m[1]) : null; }
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
        else { const watt = parsePanelWatt(name); if (watt) items.push({ cat, model: name, sup: "YugTorg", avail, watt, brand: panelBrand(name) }); }
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
  if ((q.available || 0) > 0 || (q.free || 0) > 0) return "yes";
  if ((q.expected || 0) > 0) return "soon";
  return "no";
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
        else { const watt = parsePanelWatt(name); if (watt) items.push({ cat, model: name, sup: "Atmo", avail, watt, brand: panelBrand(name) }); }
      }
      const pi = j.data && j.data.paginatorInfo;
      if (pi && (pi.hasMorePages === false || (pi.currentPage && pi.lastPage && pi.currentPage >= pi.lastPage))) break;
    }
  }
  console.log(`Atmo: ${items.length} позицій`);
  return items;
}

// ---------- main ----------
async function main() {
  const prev = JSON.parse(readFileSync("catalog.json", "utf8"));
  const seed = (prev.items || []).filter((i) => i.sup !== "YugTorg" && i.sup !== "Atmo");
  const live = await yugtorg();
  let liveAtmo = [];
  try { liveAtmo = await atmo(); } catch (e) { console.warn("Atmo failed: " + e.message); }
  const items = [...seed, ...live, ...liveAtmo];
  for (const it of items) { if (!it.ds) { const ds = datasheetFor(it); if (ds) it.ds = ds; } delete it.brand; }
  const out = { generated: new Date().toISOString().slice(0, 10), note: "7 таблиць (сид) + YugTorg + Atmo (вживу). Ціни не показуються.", items };
  writeFileSync("catalog.json", JSON.stringify(out, null, 1));
  console.log(`catalog.json: ${items.length} позицій (сид ${seed.length} + YugTorg ${live.length} + Atmo ${liveAtmo.length})`);
}
main();
