// Fixed category filtering + stable object card + per-object color + object editing
const state={shownCount:0,cats:[],catsAll:[],selectedCats:new Set(),catFilter:"",q:"",showLabels:true,map:null,layer:null,lastReq:0,abort:null,year:{min:null,max:null,from:null,to:null,step:10,includeUnknown:true},styleRules:[]};
const STYLE_RULES_STORAGE_KEY="tg_style_rules_v1";
const debounce=(fn,ms)=>{let t=null;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms);};};
const setStatus=(t)=>{const el=document.getElementById("status");if(el) el.textContent=t;};

const ensureShownCountBox=()=>{
  let box=document.getElementById("shownCountBox");
  if(box) return;
  const hint=document.getElementById("catsHint");
  const parent=(hint && hint.parentNode) || document.getElementById("sidebar") || document.body;
  box=document.createElement("div");
  box.id="shownCountBox";
  box.style.cssText="padding:8px 10px;border:1px solid #ddd;border-radius:10px;background:#fff;margin:8px 0;font-size:13px;line-height:1.25;";
  const title=document.createElement("div");
  title.textContent="На карте сейчас";
  title.style.cssText="font-weight:600;margin-bottom:4px;";
  const val=document.createElement("div");
  val.innerHTML=`<span id="shownCount" style="font-size:18px;font-weight:700;">0</span> объектов`;
  box.appendChild(title);
  box.appendChild(val);
  if(hint && hint.parentNode){
    hint.parentNode.insertBefore(box, hint);
  }else{
    parent.insertBefore(box, parent.firstChild);
  }
};

const setShownCount=(n)=>{
  state.shownCount = Number(n)||0;
  const el=document.getElementById("shownCount");
  if(el) el.textContent=String(state.shownCount);
};

async function fetchJSON(url,{signal,method="GET",headers,body,timeoutMs=20000}={}){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(), timeoutMs);
  const onAbort=()=>controller.abort(signal?.reason);
  if(signal) signal.addEventListener("abort", onAbort, {once:true});
  let r;
  try{
    r=await fetch(url,{signal:controller.signal,method,headers,body});
  }catch(e){
    if(String(e?.name)==="AbortError" && !signal?.aborted){
      const err=new Error(`Request timeout after ${timeoutMs}ms`);
      err.code="ETIMEDOUT";
      throw err;
    }
    throw e;
  }finally{
    clearTimeout(timer);
    if(signal) signal.removeEventListener("abort", onAbort);
  }
  if(!r.ok){
    let detail="";
    try{ const e=await r.json(); detail=e?.message||e?.error||""; }catch(_){ }
    const suffix=detail?`: ${detail}`:"";
    const err=new Error(`${r.status} ${r.statusText}${suffix}`);
    err.status=r.status;
    throw err;
  }
  return r.json();
}
const bboxParam=(map)=>{const b=map.getBounds();return [b.getWest().toFixed(7),b.getSouth().toFixed(7),b.getEast().toFixed(7),b.getNorth().toFixed(7)].join(",");};
const escapeHtml=(s)=>String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
const escapeAttr=(s)=>escapeHtml(s).replaceAll("`","&#096;");
const norm=(s)=>String(s??"").trim().toLowerCase();
const categoryMatches=(feature,cat)=>{
  const expected=norm(cat);
  if(!expected) return false;
  const cats=new Set(featureCategories(feature));
  return cats.has(expected);
};

function defaultStyleRule(){
  return {category:"",color:"#3388FF",fillOpacity:0.12,weight:1,noStroke:false,minZoom:0,maxZoom:20};
}

function sanitizeStyleRule(raw){
  const base=defaultStyleRule();
  const color=String(raw?.color ?? base.color).trim();
  const isHex=/^#[0-9a-fA-F]{6}$/.test(color);
  const minZoom=Math.max(0, Math.min(22, Number(raw?.minZoom)));
  const maxZoom=Math.max(0, Math.min(22, Number(raw?.maxZoom)));
  return {
    category:String(raw?.category ?? "").trim(),
    color:isHex?color.toUpperCase():base.color,
    fillOpacity:Math.max(0, Math.min(1, Number(raw?.fillOpacity ?? base.fillOpacity))),
    weight:Math.max(0, Math.min(12, Number(raw?.weight ?? base.weight))),
    noStroke:Boolean(raw?.noStroke),
    minZoom:Number.isFinite(minZoom)?minZoom:base.minZoom,
    maxZoom:Number.isFinite(maxZoom)?Math.max(minZoom,maxZoom):base.maxZoom
  };
}

function loadStyleRules(){
  try{
    const raw=localStorage.getItem(STYLE_RULES_STORAGE_KEY);
    if(!raw) return [];
    const arr=JSON.parse(raw);
    if(!Array.isArray(arr)) return [];
    return arr.map(sanitizeStyleRule);
  }catch(_){ return []; }
}

function saveStyleRules(){
  try{ localStorage.setItem(STYLE_RULES_STORAGE_KEY, JSON.stringify(state.styleRules)); }catch(_){ }
}

function findStyleRuleForFeature(feature){
  return state.styleRules.find(r=>categoryMatches(feature,r.category)) || null;
}

function shouldFeatureBeVisibleAtZoom(feature,zoom){
  const r=findStyleRuleForFeature(feature);
  if(!r) return true;
  return zoom>=r.minZoom && zoom<=r.maxZoom;
}

const asText=(v)=>typeof v==="string"?v:String(v??"");
function isTimeCategory(cat){
  const s=String(cat||"").trim();
  if(!s) return false;
  // New format
  if(/^год\s*:\s*\d{4}$/i.test(s)) return true;
  if(/^десятилетие\s*:/i.test(s)) return true;
  if(/^период\s*:/i.test(s)) return true;
  // Legacy format
  if(/^строение\s+\d{4}\s+года$/i.test(s)) return true;
  if(/^строение\s+\d{3,4}-х\s+годов$/i.test(s)) return true;
  if(/^строение\s+\d{1,2}\s*го\s*века$/i.test(s)) return true;
  if(/^строение\s+\d{1,2}-го\s+века$/i.test(s)) return true;
  if(/^строение\s+\d{1,2}го\s+века$/i.test(s)) return true;
  if(/^строение\s+\d{4}-х\s+годов$/i.test(s)) return true;
  return false;
}

function extractYearsFromCategories(cats){
  const years=[];
  for(const it of (cats||[])){
    const cat=String(it?.category ?? it ?? "").trim();
    let m=cat.match(/^год\s*:\s*(\d{4})$/i);
    if(m){ years.push(+m[1]); continue; }
    m=cat.match(/^строение\s+(\d{4})\s+года$/i);
    if(m){ years.push(+m[1]); continue; }
    m=cat.match(/^строение\s+(\d{3,4})-х\s+годов$/i);
    if(m){ years.push(+m[1]); continue; }
    m=cat.match(/(\d{4})/);
    if(m && /строение|год|века|период|десятилетие/i.test(cat)) years.push(+m[1]);
  }
  return years.filter(y=>y>=1600 && y<=2100);
}

function getFeatureYear(feature){
  const p=(feature && feature.properties) || {};
  const direct = p.year ?? p["год"] ?? p["строительство_год"] ?? p["build_year"];
  const n = Number(direct);
  if(Number.isFinite(n) && n>1500 && n<2100) return n;

  const cats = featureCategories(feature).map(c=>String(c));
  // cats are normalized lower-case; try raw too
  const rawCats = parseMaybeJsonArray(p.categories ?? p["wm-категория"] ?? []);
  const candidates = [];
  for(const c of [...rawCats, ...cats]){
    const s=String(c||"").trim();
    let m=s.match(/год\s*:\s*(\d{4})/i);
    if(m){ candidates.push(+m[1]); continue; }
    m=s.match(/строение\s+(\d{4})\s+года/i);
    if(m){ candidates.push(+m[1]); continue; }
    m=s.match(/строение\s+(\d{3,4})-х\s+годов/i);
    if(m){ candidates.push(+m[1]); continue; }
    // fallback: any 4-digit year in context words
    m=s.match(/(\d{4})/);
    if(m && /(год|строен|постро)/i.test(s)) candidates.push(+m[1]);
  }
  const y=candidates.find(y=>y>=1600 && y<=2100);
  return y ?? null;
}

function yearFilterActive(){
  const y=state.year;
  if(y.min==null || y.max==null || y.from==null || y.to==null) return false;
  return (y.from!==y.min) || (y.to!==y.max) || (y.includeUnknown===false);
}

function initYearControl(){
  // determine global min/max from categories list (full list, including time cats)
  const years = extractYearsFromCategories(state.catsAll);
  const min = years.length ? Math.floor(Math.min(...years)/10)*10 : 1800;
  const max = years.length ? Math.ceil(Math.max(...years)/10)*10 : 2020;

  state.year.min=min; state.year.max=max;
  state.year.from=min; state.year.to=max;

  if(!(window.L && state.map)) return;

  const ctrl=L.control({position:"topright"});
  ctrl.onAdd=function(){
    const div=L.DomUtil.create("div","tg-year-control");
    div.style.background="rgba(237,243,255,.96)";
    div.style.border="1px solid #c6d7f3";
    div.style.borderRadius="14px";
    div.style.padding="10px 10px 8px";
    div.style.boxShadow="0 10px 24px rgba(12,20,33,.16)";
    div.style.minWidth="210px";

    div.innerHTML = `
      <div style="font-weight:800;font-size:12px;color:#1b2430;margin-bottom:6px;">Год постройки</div>
      <div data-year-label style="font-size:12px;color:#3b4a60;margin-bottom:6px;"></div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        <input data-year-from type="range" min="${min}" max="${max}" step="${state.year.step}" value="${min}">
        <input data-year-to type="range" min="${min}" max="${max}" step="${state.year.step}" value="${max}">
      </div>
      <label style="display:flex;gap:8px;align-items:center;margin-top:7px;font-size:12px;color:#3b4a60;">
        <input data-year-unknown type="checkbox" checked>
        <span>показывать без года</span>
      </label>
    `;

    // prevent map interactions when using sliders
    if(L.DomEvent){
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
    }

    const label=div.querySelector("[data-year-label]");
    const fromEl=div.querySelector("[data-year-from]");
    const toEl=div.querySelector("[data-year-to]");
    const unkEl=div.querySelector("[data-year-unknown]");

    const syncLabel=()=>{
      label.textContent = `${state.year.from} — ${state.year.to} (шаг ${state.year.step})`;
    };

    const clamp=()=>{
      let a=Number(fromEl.value), b=Number(toEl.value);
      if(a>b){ const t=a; a=b; b=t; }
      state.year.from=a; state.year.to=b;
      fromEl.value=String(a); toEl.value=String(b);
      state.year.includeUnknown=!!unkEl.checked;
      syncLabel();
    };

    fromEl.addEventListener("input",()=>{clamp(); scheduleReload();});
    toEl.addEventListener("input",()=>{clamp(); scheduleReload();});
    unkEl.addEventListener("change",()=>{clamp(); scheduleReload();});

    syncLabel();
    return div;
  };
  ctrl.addTo(state.map);
}

function ensurePopupStyles(){
  if(document.getElementById("tg-popup-style")) return;
  const css=`
.tg-popup .leaflet-popup-content{margin:12px 14px;}
.tg-popup .leaflet-popup-content-wrapper{border-radius:16px; box-shadow:0 16px 34px rgba(12,20,33,.22); background:#edf3ff;}
.tg-popup .leaflet-popup-tip{box-shadow:0 8px 20px rgba(12,20,33,.18); background:#edf3ff;}
.tg-card{max-width:640px; font-size:14px; line-height:1.42; color:#17212e;}
.tg-card-head{display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin:0 0 8px;}
.tg-title{font-weight:900; font-size:19px; line-height:1.15; margin:0; display:flex; align-items:flex-start; gap:10px; flex:1;}
.tg-color-dot{width:10px; height:10px; border-radius:999px; border:1px solid rgba(0,0,0,.18); margin-top:5px; flex:0 0 auto;}
.tg-meta{color:#667085; font-size:12.5px; margin:0 0 12px;}
.tg-warning{padding:9px 11px; border:1px solid #ffe3a8; background:#fff7e6; border-radius:10px; font-size:12.5px; color:#6a4b00; margin:0 0 12px;}
.tg-photo{border:1px solid #d9e5f7; border-radius:14px; overflow:hidden; background:#eaf2ff;}
.tg-photo img{width:100%; height:260px; object-fit:cover; display:block;}
.tg-photo-empty{height:220px; display:flex; align-items:center; justify-content:center; color:#8b96a6; font-size:12.5px;}
.tg-photo-caption{margin:8px 0 0; font-size:12px; color:#748093;}
.tg-desc{margin:12px 0 0; font-size:13.5px; color:#1b2430;}
.tg-section{margin:12px 0 0;}
.tg-section-title{font-size:12px; color:#748093; margin:0 0 6px; text-transform:uppercase; letter-spacing:.02em;}
.tg-chips{display:flex; flex-wrap:wrap; gap:6px;}
.tg-chip{display:inline-block; padding:4px 10px; border:1px solid #c6d7f3; border-radius:999px; font-size:12px; background:#e8f0ff; color:#28518f;}
.tg-links{display:flex; flex-wrap:wrap; gap:8px;}
.tg-links a{font-size:12px; color:#1558d6; text-decoration:none; word-break:break-all;}
.tg-card-actions{margin-top:12px; padding-top:10px; border-top:1px dashed #e5e5e5; display:flex; gap:8px;}
.tg-edit{margin-top:12px; padding-top:10px; border-top:1px dashed #e5e5e5;}
.tg-edit-title{font-size:12px; color:#666; margin:0 0 8px;}
.tg-edit-row{margin:0 0 8px;}
.tg-edit-input,.tg-edit-textarea{width:100%; border:1px solid #c4d2e8; border-radius:10px; padding:8px 10px; font-size:13px; font-family:inherit; background:#f3f7ff;}
.tg-edit-input:focus,.tg-edit-textarea:focus{border-color:#4d86ff; box-shadow:0 0 0 3px rgba(77,134,255,.14); outline:none;}
.tg-edit-textarea{min-height:100px; resize:vertical;}
.tg-edit-actions{display:flex; gap:8px; align-items:center; flex-wrap:wrap;}
.tg-edit-btn{padding:7px 11px; border:1px solid #b9cbe8; border-radius:10px; background:linear-gradient(180deg,#f7faff,#e4eeff); color:#1d2838; cursor:pointer; font-weight:600;}
.tg-edit-btn:hover{background:linear-gradient(180deg,#ffffff,#dbe8ff);}
.tg-edit-btn-primary{border-color:#2f6df6; background:linear-gradient(180deg,#4e84ff,#2f6df6); color:#fff;}
.tg-edit-btn-primary:hover{background:linear-gradient(180deg,#5a8cff,#2f6df6);}
.tg-edit-status{font-size:12px; color:#667085;}
`;
  const style=document.createElement("style");
  style.id="tg-popup-style";
  style.textContent=css;
  document.head.appendChild(style);
}

function protectPopupInteractions(popup){
  // Prevent click/scroll inside popup from triggering map actions (drag/zoom)
  const apply=()=>{
    const el=popup && popup.getElement && popup.getElement();
    if(!el) return false;
    if(window.L && L.DomEvent){
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
    }
    return true;
  };
  // popup element may not exist immediately after openOn / setContent
  if(!apply()) setTimeout(apply, 0);
}



function bindPopupAction(el, handler){
  if(!el) return;
  el.addEventListener("click", async (ev)=>{
    try{
      ev.preventDefault();
      ev.stopPropagation();
    }catch(_){}
    await handler(ev);
  });
}

function parseMaybeJsonArray(v){
  if(Array.isArray(v)) return v;
  if(typeof v!=="string") return [];
  const s=v.trim(); if(!s) return [];
  try{ const j=JSON.parse(s); if(Array.isArray(j)) return j; }catch(_){ }
  if(s.startsWith("[") && s.endsWith("]")){
    const m=s.slice(1,-1).match(/"([^"]+)"/g)||[];
    return m.map(x=>x.replaceAll('"',""));
  }
  return [s];
}

function featureCategories(feature){
  const p=feature.properties||{};
  const raw=p.categories ?? p["wm-категория"] ?? p["wm-category"] ?? p["wm_категория"];
  return parseMaybeJsonArray(raw).map(norm).filter(Boolean);
}

function featureHasAnySelectedCategory(feature){
  const setCats=new Set(featureCategories(feature));
  for(const c of state.selectedCats){ if(setCats.has(norm(c))) return true; }
  return false;
}

function getFeatureColor(feature){
  const p=(feature && feature.properties) || {};
  const c = p.viewer_color ?? p.viewerColor ?? p.color ?? p["viewer_color"] ?? p["viewerColor"];
  if(typeof c === "string" && c.trim()) return c.trim();
  return "#3388ff";
}

function featureStyle(feature){
  const rule=findStyleRuleForFeature(feature);
  if(rule){
    return {
      color:rule.noStroke?"transparent":rule.color,
      fillColor:rule.color,
      weight:rule.noStroke?0:rule.weight,
      fillOpacity:rule.fillOpacity,
      opacity:rule.noStroke?0:1
    };
  }
  const c=getFeatureColor(feature);
  const cu=(c||"").toUpperCase();
  const isYellow = (cu==="#FFEB00" || cu==="#FFFF00" || cu==="#FFD400");
  return {color:c,fillColor:c,weight:(isYellow?3:1),fillOpacity:(isYellow?0.22:0.12)};
}

function bindOrUnbindTooltip(layer,title){
  if(layer.getTooltip && layer.getTooltip()) layer.unbindTooltip();
  if(state.showLabels && title) layer.bindTooltip(title,{direction:"top",sticky:true});
}

function refreshTooltips(){
  if(!state.layer) return;
  state.layer.eachLayer((layer)=>{const p=(layer.feature&&layer.feature.properties)||{};bindOrUnbindTooltip(layer,p.title||p.id||"");});
}

function pickPhotos(obj){
  return parseMaybeJsonArray(obj["wm-фото"] || obj["wm_photo"] || obj.photos || obj.photo || obj["photos"] || []);
}

function featureToCardObject(feature){
  const p=(feature && feature.properties) || {};
  return {
    id:p.id,
    title:p.title || p["wm-название"],
    description:p.description || p["описание"],
    categories:p.categories ?? p["wm-категория"] ?? p["wm-category"] ?? p["wm_категория"] ?? [],
    viewer_color:p.viewer_color ?? p.viewerColor ?? p.color,
    "wm-фото":p["wm-фото"] ?? p["wm_photo"] ?? p.photos ?? p.photo ?? [],
    _viewer:{partial:true,warning:"Показаны данные из слоя карты. Полная карточка догружается…"}
  };
}

function idToAddress(id){
  const s=String(id??"");
  return s.replaceAll("_"," ").replace(/\s+/g," ").trim();
}

function editableFields(obj,id){
  const rawColor=(obj.viewer_color||obj["viewer_color"]||"").trim();
  const color=/^#[0-9a-fA-F]{6}$/.test(rawColor)?rawColor.toUpperCase():"#3388FF";
  return {
    title: obj.title||obj["wm-название"]||obj.id||id,
    description: obj.description||obj["описание"]||"",
    categories: parseMaybeJsonArray(obj.categories ?? obj["wm-категория"] ?? []),
    viewer_color: color
  };
}

function buildCardHTML(obj,id){
  const viewer=obj._viewer||obj.viewer||{};
  const partial=!!viewer.partial;
  const warning=viewer.warning||"";

  const title=asText(obj.title||obj["wm-название"]||obj.id||id);
  const address=idToAddress(id);
  const desc=asText(obj.description||obj["описание"]||"");
  const catsRaw=obj.categories ?? obj["wm-категория"] ?? [];
  const cats=parseMaybeJsonArray(catsRaw);
  const photos=pickPhotos(obj);
  const color=asText(obj.viewer_color ?? obj["viewer_color"]).trim();

  const warnBlock = partial || warning
    ? `<div class="tg-warning">${escapeHtml((warning||"Данные могут быть неполными"))}</div>`
    : "";

  const colorDot = color ? `<span class="tg-color-dot" title="${escapeAttr(color)}" style="background:${escapeAttr(color)}"></span>` : "";

  const photoBlock = photos.length
    ? `<div class="tg-photo"><img src="${escapeAttr(photos[0])}" alt=""/></div>`
    : `<div class="tg-photo"><div class="tg-photo-empty">Фото нет</div></div>`;

  const photoCaption = `<div class="tg-photo-caption">Фото</div>`;

  const descHtml = desc
    ? `<div class="tg-desc">${escapeHtml(desc).replace(/\n/g,"<br>")}</div>`
    : `<div class="tg-desc" style="color:#666">Описание отсутствует</div>`;

  const catsHtml = cats.length
    ? `<div class="tg-section"><div class="tg-section-title">Категории</div>
        <div class="tg-chips">${cats.map(x=>`<span class="tg-chip">${escapeHtml(x)}</span>`).join("")}</div>
      </div>`
    : ``;

  const morePhotos = photos.length>1
    ? `<div class="tg-section"><div class="tg-section-title">Ещё фото (ссылки)</div><div class="tg-links">${photos.slice(1).map(u=>`<a href="${escapeAttr(u)}" target="_blank" rel="noopener">${escapeHtml(u)}</a>`).join(" ")}</div></div>`
    : ``;

  return `
  <div class="tg-card">
    ${warnBlock}
    <div class="tg-card-head">
      <div class="tg-title">${colorDot}<span>${escapeHtml(title)}</span></div>
      <div class="tg-card-actions">
        <button type="button" class="tg-edit-btn" data-open-editor>Ред.</button>
      </div>
    </div>
    <div class="tg-meta">Адрес: ${escapeHtml(address)}</div>
    ${photoBlock}
    ${photoCaption}
    ${descHtml}
    ${catsHtml}
    ${morePhotos}
    <div class="tg-card-actions">
      <button type="button" class="tg-edit-btn" data-open-editor>Ред.</button>
    </div>
  </div>`;
}

function buildEditorHTML(obj,id){
  const title=obj.title||obj["wm-название"]||obj.id||id;
  const desc=obj.description||obj["описание"]||"";
  const catsRaw=obj.categories ?? obj["wm-категория"] ?? [];
  const cats=parseMaybeJsonArray(catsRaw);

  return `
  <div class="tg-card">
    <div class="tg-title"><span>Редактирование</span></div>
    <div class="tg-meta">Адрес: ${escapeHtml(idToAddress(id))}</div>
    <div class="tg-edit" data-editor-root data-object-id="${escapeAttr(id)}">
      <div class="tg-edit-row"><input class="tg-edit-input" data-edit-title placeholder="Название" value="${escapeAttr(title)}"/></div>
      <div class="tg-edit-row"><textarea class="tg-edit-textarea" data-edit-description placeholder="Описание">${escapeHtml(desc)}</textarea></div>
      <div class="tg-edit-row"><input class="tg-edit-input" data-edit-categories placeholder="Категории через запятую" value="${escapeAttr(cats.join(", "))}"/></div>
      <div class="tg-edit-actions">
        <button type="button" class="tg-edit-btn" data-edit-save>Сохранить</button>
        <button type="button" class="tg-edit-btn" data-edit-cancel>Отмена</button>
        <span class="tg-edit-status" data-edit-status></span>
      </div>
    </div>
  </div>`;
}

function parseCategoriesInput(raw){
  return String(raw||"").split(",").map(s=>s.trim()).filter(Boolean);
}

function attachCardHandlers(popup,obj,id){
  const root=popup.getElement && popup.getElement();
  if(!root) return;
  const openBtn=root.querySelector("[data-open-editor]");
  if(!openBtn) return;
  openBtn.addEventListener("click",(ev)=>{
    try{ ev.preventDefault(); ev.stopPropagation(); }catch(_){ }
    popup.setContent(buildEditorHTML(obj,id));
    protectPopupInteractions(popup);
    attachEditorHandlers(popup,id,obj);
  });
}

function attachEditorHandlers(popup,id,sourceObj){
  const root=popup.getElement && popup.getElement();
  if(!root) return;
  const editor=root.querySelector("[data-editor-root]");
  if(!editor) return;
  const titleEl=editor.querySelector("[data-edit-title]");
  const descEl=editor.querySelector("[data-edit-description]");
  const catsEl=editor.querySelector("[data-edit-categories]");
  const saveBtn=editor.querySelector("[data-edit-save]");
  const cancelBtn=editor.querySelector("[data-edit-cancel]");
  const statusEl=editor.querySelector("[data-edit-status]");
  if(!titleEl || !descEl || !catsEl || !saveBtn || !statusEl) return;

  const showCard=(obj)=>{
    popup.setContent(buildCardHTML(obj,id));
    protectPopupInteractions(popup);
    attachCardHandlers(popup,obj,id);
  };

  if(cancelBtn){
    cancelBtn.addEventListener("click",(ev)=>{ try{ ev.preventDefault(); ev.stopPropagation(); }catch(_){ } showCard(sourceObj); });
  }

  const setEditStatus=(text,isError=false)=>{
    statusEl.textContent=text;
    statusEl.style.color=isError?"#8b0000":"#666";
  };

  bindPopupAction(saveBtn, async ()=>{
    const payload={
      title:String(titleEl.value||"").trim(),
      description:String(descEl.value||""),
      categories:parseCategoriesInput(catsEl.value)
    };
    if(!payload.title){ setEditStatus("Название не может быть пустым",true); return; }
    saveBtn.disabled=true;
    setEditStatus("Сохраняю…");
    try{
      await fetchJSON(`/api/object/${encodeURIComponent(id)}`,{
        method:"PUT",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify(payload)
      });
      setEditStatus("Сохранено");
      await reloadObjects();
      try{
        const fresh=await fetchJSON(`/api/object/${encodeURIComponent(id)}`);
        showCard(fresh);
      }catch(_){ }
    }catch(e){
      setEditStatus(`Ошибка: ${e.message||e}`,true);
    }finally{
      saveBtn.disabled=false;
    }
  });
}

async function openPopupFor(id,latlng,feature){
  ensurePopupStyles();

  // Show something immediately (data from the map layer), then try to load full card
  const fallbackObj=featureToCardObject(feature);
  const popup=L.popup({className:"tg-popup",maxWidth:660,minWidth:520,closeOnClick:false,autoClose:true})
    .setLatLng(latlng)
    .setContent(buildCardHTML(fallbackObj,id))
    .openOn(state.map);

  protectPopupInteractions(popup);

  try{
    const obj=await fetchJSON(`/api/object/${encodeURIComponent(id)}?t=${Date.now()}`,{timeoutMs:13000});
    popup.setContent(buildCardHTML(obj,id));
    protectPopupInteractions(popup);
    attachCardHandlers(popup,obj,id);
  }catch(e){
    const msg = e && e.message ? e.message : String(e);
    // keep fallback card, but show warning
    fallbackObj._viewer = fallbackObj._viewer || {};
    fallbackObj._viewer.partial = true;
    fallbackObj._viewer.warning = `Не удалось загрузить полную карточку: ${msg}`;
    popup.setContent(buildCardHTML(fallbackObj,id));
    protectPopupInteractions(popup);
    attachCardHandlers(popup,fallbackObj,id);
  }
}

function onEachFeature(feature,layer){
  const p=feature.properties||{};
  const id=String(p.id??"");
  bindOrUnbindTooltip(layer,p.title||id||"");
  layer.on("click",(ev)=>{
    const latlng=ev.latlng||(layer.getBounds&&layer.getBounds().getCenter&&layer.getBounds().getCenter())||(layer.getLatLng&&layer.getLatLng());
    openPopupFor(id,latlng,feature);
  });
}

function normalizeCats(list){
  const arr=Array.isArray(list)?list:[];
  return arr.map((x)=>({category:String(x?.category??x?.name??x?.title??""),count:Number(x?.count??0)||0})).filter(x=>x.category);
}

function renderStyleRules(){
  const wrap=document.getElementById("styleRulesList");
  if(!wrap) return;
  wrap.innerHTML="";
  state.styleRules.forEach((rule,idx)=>{
    const row=document.createElement("div");
    row.className="styleRuleRow";
    row.innerHTML=`
      <input class="input styleRuleCat" placeholder="Категория" value="${escapeAttr(rule.category)}">
      <div class="styleRuleGrid">
        <label>Цвет <input class="input" type="color" value="${escapeAttr(rule.color)}"></label>
        <label>Прозр. <input class="input" type="number" min="0" max="1" step="0.01" value="${escapeAttr(rule.fillOpacity)}"></label>
        <label>Обводка <input class="input" type="number" min="0" max="12" step="1" value="${escapeAttr(rule.weight)}"></label>
      </div>
      <div class="styleRuleGrid">
        <label>Мин. zoom <input class="input" type="number" min="0" max="22" step="1" value="${escapeAttr(rule.minZoom)}"></label>
        <label>Макс. zoom <input class="input" type="number" min="0" max="22" step="1" value="${escapeAttr(rule.maxZoom)}"></label>
        <label class="toggle"><input type="checkbox" ${rule.noStroke?"checked":""}> <span>Без обводки</span></label>
      </div>
      <button type="button" class="btn btnSmall">Удалить</button>
    `;
    const [catEl,colorEl,opEl,weightEl,minZoomEl,maxZoomEl,noStrokeEl,delBtn]=[
      row.querySelector('.styleRuleCat'),
      row.querySelectorAll('input')[1],
      row.querySelectorAll('input')[2],
      row.querySelectorAll('input')[3],
      row.querySelectorAll('input')[4],
      row.querySelectorAll('input')[5],
      row.querySelectorAll('input')[6],
      row.querySelector('button')
    ];
    const sync=()=>{
      state.styleRules[idx]=sanitizeStyleRule({
        category:catEl.value,
        color:colorEl.value,
        fillOpacity:opEl.value,
        weight:weightEl.value,
        minZoom:minZoomEl.value,
        maxZoom:maxZoomEl.value,
        noStroke:noStrokeEl.checked
      });
      saveStyleRules();
      scheduleReload();
    };
    [catEl,colorEl,opEl,weightEl,minZoomEl,maxZoomEl].forEach(el=>el.addEventListener('input',sync));
    noStrokeEl.addEventListener('change',sync);
    delBtn.addEventListener('click',()=>{state.styleRules.splice(idx,1); saveStyleRules(); renderStyleRules(); scheduleReload();});
    wrap.appendChild(row);
  });
}

function renderCats(){
  const wrap=document.getElementById("cats"); const hint=document.getElementById("catsHint");
  if(!wrap) return; wrap.innerHTML="";
  const f=state.catFilter.trim().toLowerCase();
  const visible=state.cats.filter(c=>!isTimeCategory(c.category)).filter(c=>!f||c.category.toLowerCase().includes(f));
  const catsShown=state.cats.filter(c=>!isTimeCategory(c.category)).length;
  if(hint) hint.textContent=`Categories: ${catsShown} (без лет/периодов). Selected: ${state.selectedCats.size}. Year filter: ${yearFilterActive()?"on":"off"}.`;
  for(const c of visible.slice(0,2000)){
    const row=document.createElement("div"); row.className="cat";
    const cb=document.createElement("input"); cb.type="checkbox"; cb.checked=state.selectedCats.has(c.category);
    cb.addEventListener("change",()=>{cb.checked?state.selectedCats.add(c.category):state.selectedCats.delete(c.category); renderCats(); scheduleReload();});
    const name=document.createElement("div"); name.className="catName"; name.textContent=c.category;
    const count=document.createElement("div"); count.className="catCount"; count.textContent=c.count;
    row.appendChild(cb); row.appendChild(name); row.appendChild(count); wrap.appendChild(row);
  }
}

async function reloadObjects(){
  if(state.selectedCats.size===0 && !yearFilterActive()){ if(state.layer){state.layer.remove(); state.layer=null;} setShownCount(0); setStatus("Select categories (or set year range)…"); return; }
  const params=new URLSearchParams();
  params.set("bbox", bboxParam(state.map));
  if(state.q.trim()) params.set("q", state.q.trim());

  const reqId=++state.lastReq;
  if(state.abort) state.abort.abort();
  state.abort=new AbortController();
  setStatus("Loading…");

  try{
    const geo=await fetchJSON(`/api/objects_raw?${params.toString()}`,{signal:state.abort.signal});
    if(reqId!==state.lastReq) return;

    let feats=(geo.features||[]);
    if(state.selectedCats.size>0) feats=feats.filter(featureHasAnySelectedCategory);
    const zoom=state.map.getZoom();
    feats=feats.filter(f=>shouldFeatureBeVisibleAtZoom(f,zoom));
    // Year range filter (step 10 by default). If year is unknown, keep it only when includeUnknown=true.
    if(state.year.min!=null && state.year.max!=null){
      const a=state.year.from??state.year.min; const b=state.year.to??state.year.max;
      feats=feats.filter(f=>{const y=getFeatureYear(f); if(y==null) return !!state.year.includeUnknown; return y>=a && y<=b;});
    }
    const out={type:"FeatureCollection",features:feats};

    if(state.layer) state.layer.remove();
    state.layer=L.geoJSON(out,{style:featureStyle,onEachFeature}).addTo(state.map);

    setShownCount((out.features||[]).length);
    setStatus(`In view: ${(out.features||[]).length}`);
    refreshTooltips();
  }catch(e){
    if(String(e.name)==="AbortError") return;
    setShownCount(0);
    setStatus("Error: "+(e.message||e));
  }
}

const scheduleReload=debounce(reloadObjects,200);

async function init(){
  ensureShownCountBox();
  setShownCount(0);
  state.map=L.map("map",{preferCanvas:true}).setView([47.2099,38.9316],14);
  // Базовая подложка без подписей/POI (минимальная детализация)
const base=L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png",{
  subdomains:"abcd",
  maxZoom:20,
  attribution:"&copy; OpenStreetMap contributors &copy; CARTO"
});
base.addTo(state.map);
// Если захочешь вернуть подписи отдельным слоем — раскомментируй:
// const labels=L.tileLayer("https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png",{subdomains:"abcd",maxZoom:20,opacity:1});
// labels.addTo(state.map);
  state.map.on("moveend", scheduleReload);
  state.map.on("zoomend", scheduleReload);

  const catFilterEl=document.getElementById("catFilter");
  if(catFilterEl) catFilterEl.addEventListener("input",(e)=>{state.catFilter=e.target.value; renderCats();});

  const qEl=document.getElementById("q");
  if(qEl) qEl.addEventListener("input",(e)=>{state.q=e.target.value; scheduleReload();});

  const clearEl=document.getElementById("clearCats");
  if(clearEl) clearEl.addEventListener("click",()=>{state.selectedCats.clear(); renderCats(); scheduleReload();});

// Кнопка "Показать все" — отметить все категории одним кликом
// (годы/периоды сюда не включаем, они управляются отдельным ползунком)
if(clearEl){
  const showAllBtn=document.createElement("button");
  showAllBtn.id="showAllCats";
  showAllBtn.type="button";
  showAllBtn.textContent="Показать все";
  showAllBtn.style.marginRight="8px";
  showAllBtn.addEventListener("click",()=>{
    // сбрасываем фильтр по списку категорий, чтобы было видно, что реально выбрано
    state.catFilter="";
    const cf=document.getElementById("catFilter"); if(cf) cf.value="";
    state.selectedCats.clear();
    for(const c of state.catsAll){
      if(!isTimeCategory(c.category)) state.selectedCats.add(c.category);
    }
    renderCats();
    scheduleReload();
  });
  // Вставляем рядом с "Сбросить"
  if(clearEl.parentNode){
    clearEl.parentNode.insertBefore(showAllBtn, clearEl);
  }
}

  const addRuleBtn=document.getElementById("addStyleRule");
  if(addRuleBtn){
    addRuleBtn.addEventListener("click",()=>{state.styleRules.push(defaultStyleRule()); saveStyleRules(); renderStyleRules();});
  }

  const reloadStylesBtn=document.getElementById("reloadStyles");
  if(reloadStylesBtn){
    reloadStylesBtn.addEventListener("click",()=>{state.styleRules=loadStyleRules(); renderStyleRules(); scheduleReload();});
  }

  const toggle=document.getElementById("toggleLabels");
  if(toggle){
    toggle.addEventListener("change",()=>{state.showLabels=!!toggle.checked; refreshTooltips();});
    state.showLabels=!!toggle.checked;
  }

  state.styleRules=loadStyleRules();
  if(state.styleRules.length===0){
    state.styleRules=[sanitizeStyleRule({category:"зеленая зона",color:"#2ECC71",noStroke:true,fillOpacity:0.24,weight:0,minZoom:0,maxZoom:20})];
    saveStyleRules();
  }
  renderStyleRules();

  try{
    const raw=await fetchJSON("/api/categories");
    state.catsAll=normalizeCats(raw).sort((a,b)=> (b.count-a.count) || String(a.category).localeCompare(String(b.category), "ru"));
    state.cats=state.catsAll;
    initYearControl();
    renderCats();
    setStatus("Select categories…");
  }catch(e){
    const hint=document.getElementById("catsHint");
    if(hint) hint.textContent="Categories load error: "+(e.message||e);
  }
}

init();
