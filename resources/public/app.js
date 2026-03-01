// Fixed category filtering + stable object card + per-object color + object editing
const state={cats:[],selectedCats:new Set(),catFilter:"",q:"",showLabels:true,map:null,layer:null,lastReq:0,abort:null};
const debounce=(fn,ms)=>{let t=null;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms);};};
const setStatus=(t)=>{const el=document.getElementById("status");if(el) el.textContent=t;};
async function fetchJSON(url,{signal,method="GET",headers,body}={}){
  const r=await fetch(url,{signal,method,headers,body});
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

function ensurePopupStyles(){
  if(document.getElementById("tg-popup-style")) return;
  const css=`
.tg-popup .leaflet-popup-content{margin:14px 16px;}
.tg-popup .leaflet-popup-content-wrapper{border-radius:14px;}
.tg-card{max-width:640px; font-size:14px; line-height:1.35;}
.tg-title{font-weight:900; font-size:18px; line-height:1.15; margin:0 0 6px; display:flex; align-items:flex-start; gap:10px;}
.tg-color-dot{width:10px; height:10px; border-radius:999px; border:1px solid rgba(0,0,0,.18); margin-top:5px; flex:0 0 auto;}
.tg-meta{color:#666; font-size:12.5px; margin:0 0 10px;}
.tg-warning{padding:8px 10px; border:1px solid #ffe3a8; background:#fff7e6; border-radius:10px; font-size:12.5px; color:#6a4b00; margin:0 0 10px;}
.tg-photo{border:1px solid #eee; border-radius:12px; overflow:hidden; background:#f6f6f6;}
.tg-photo img{width:100%; height:260px; object-fit:cover; display:block;}
.tg-photo-empty{height:220px; display:flex; align-items:center; justify-content:center; color:#888; font-size:12.5px;}
.tg-photo-caption{margin:8px 0 0; font-size:12px; color:#777;}
.tg-desc{margin:10px 0 0; font-size:13px; color:#1b1b1b;}
.tg-section{margin:12px 0 0;}
.tg-section-title{font-size:12px; color:#777; margin:0 0 6px;}
.tg-chips{display:flex; flex-wrap:wrap; gap:6px;}
.tg-chip{display:inline-block; padding:3px 8px; border:1px solid #e6e6e6; border-radius:999px; font-size:12px; background:#fafafa;}
.tg-links{display:flex; flex-wrap:wrap; gap:8px;}
.tg-links a{font-size:12px; color:#1558d6; text-decoration:none; word-break:break-all;}
.tg-card-actions{margin-top:12px; padding-top:10px; border-top:1px dashed #e5e5e5; display:flex; gap:8px;}
.tg-edit{margin-top:12px; padding-top:10px; border-top:1px dashed #e5e5e5;}
.tg-edit-title{font-size:12px; color:#666; margin:0 0 8px;}
.tg-edit-row{margin:0 0 8px;}
.tg-edit-input,.tg-edit-textarea{width:100%; border:1px solid #ddd; border-radius:10px; padding:7px 9px; font-size:13px; font-family:inherit;}
.tg-edit-textarea{min-height:90px; resize:vertical;}
.tg-edit-actions{display:flex; gap:8px; align-items:center;}
.tg-edit-btn{padding:7px 10px; border:1px solid #d5d5d5; border-radius:10px; background:#f8f8f8; cursor:pointer;}
.tg-edit-btn:hover{background:#efefef;}
.tg-edit-status{font-size:12px; color:#666;}
`;
  const style=document.createElement("style");
  style.id="tg-popup-style";
  style.textContent=css;
  document.head.appendChild(style);
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

  const title=obj.title||obj["wm-название"]||obj.id||id;
  const address=idToAddress(id);
  const desc=obj.description||obj["описание"]||"";
  const catsRaw=obj.categories ?? obj["wm-категория"] ?? [];
  const cats=parseMaybeJsonArray(catsRaw);
  const photos=pickPhotos(obj);
  const color=(obj.viewer_color||obj["viewer_color"]||"").trim();

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
    <div class="tg-title">${colorDot}<span>${escapeHtml(title)}</span></div>
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
  openBtn.addEventListener("click",()=>{
    popup.setContent(buildEditorHTML(obj,id));
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
    attachCardHandlers(popup,obj,id);
  };

  if(cancelBtn){
    cancelBtn.addEventListener("click",()=>showCard(sourceObj));
  }

  const setEditStatus=(text,isError=false)=>{
    statusEl.textContent=text;
    statusEl.style.color=isError?"#8b0000":"#666";
  };

  saveBtn.addEventListener("click", async ()=>{
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

async function openPopupFor(id,latlng){
  ensurePopupStyles();
  const popup=L.popup({className:"tg-popup",maxWidth:660,minWidth:520})
    .setLatLng(latlng)
    .setContent('<div style="font-size:13px;color:#777">Loading…</div>')
    .openOn(state.map);
  try{
    const obj=await fetchJSON(`/api/object/${encodeURIComponent(id)}`);
    popup.setContent(buildCardHTML(obj,id));
    attachCardHandlers(popup,obj,id);
  }catch(e){
    popup.setContent(`<div class="tg-card">
      <div class="tg-title"><span>${escapeHtml(id)}</span></div>
      <div class="tg-meta">Адрес: ${escapeHtml(idToAddress(id))}</div>
      <div class="tg-warning" style="border-color:#ffd0d0;background:#fff3f3;color:#7a0000">Card error: ${escapeHtml(String(e.message||e))}</div>
      <div class="tg-meta">Tried URL: /api/object/${escapeHtml(encodeURIComponent(id))}</div>
    </div>`);
  }
}

function onEachFeature(feature,layer){
  const p=feature.properties||{};
  const id=String(p.id??"");
  bindOrUnbindTooltip(layer,p.title||id||"");
  layer.on("click",(ev)=>{
    const latlng=ev.latlng||(layer.getBounds&&layer.getBounds().getCenter&&layer.getBounds().getCenter())||(layer.getLatLng&&layer.getLatLng());
    openPopupFor(id,latlng);
  });
}

function normalizeCats(list){
  const arr=Array.isArray(list)?list:[];
  return arr.map((x)=>({category:String(x?.category??x?.name??x?.title??""),count:Number(x?.count??0)||0})).filter(x=>x.category);
}

function renderCats(){
  const wrap=document.getElementById("cats"); const hint=document.getElementById("catsHint");
  if(!wrap) return; wrap.innerHTML="";
  const f=state.catFilter.trim().toLowerCase();
  const visible=state.cats.filter(c=>!f||c.category.toLowerCase().includes(f));
  if(hint) hint.textContent=`Categories: ${state.cats.length}. Selected: ${state.selectedCats.size}.`;
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
  if(state.selectedCats.size===0){ if(state.layer){state.layer.remove(); state.layer=null;} setStatus("Select categories…"); return; }
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

    const out={type:"FeatureCollection",features:(geo.features||[]).filter(featureHasAnySelectedCategory)};

    if(state.layer) state.layer.remove();
    state.layer=L.geoJSON(out,{style:featureStyle,onEachFeature}).addTo(state.map);

    setStatus(`In view: ${(out.features||[]).length}`);
    refreshTooltips();
  }catch(e){
    if(String(e.name)==="AbortError") return;
    setStatus("Error: "+(e.message||e));
  }
}

const scheduleReload=debounce(reloadObjects,200);

async function init(){
  state.map=L.map("map",{preferCanvas:true}).setView([47.2099,38.9316],14);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"&copy; OpenStreetMap"}).addTo(state.map);
  state.map.on("moveend", scheduleReload);

  const catFilterEl=document.getElementById("catFilter");
  if(catFilterEl) catFilterEl.addEventListener("input",(e)=>{state.catFilter=e.target.value; renderCats();});

  const qEl=document.getElementById("q");
  if(qEl) qEl.addEventListener("input",(e)=>{state.q=e.target.value; scheduleReload();});

  const clearEl=document.getElementById("clearCats");
  if(clearEl) clearEl.addEventListener("click",()=>{state.selectedCats.clear(); renderCats(); scheduleReload();});

  const toggle=document.getElementById("toggleLabels");
  if(toggle){
    toggle.addEventListener("change",()=>{state.showLabels=!!toggle.checked; refreshTooltips();});
    state.showLabels=!!toggle.checked;
  }

  try{
    const raw=await fetchJSON("/api/categories");
    state.cats=normalizeCats(raw);
    renderCats();
    setStatus("Select categories…");
  }catch(e){
    const hint=document.getElementById("catsHint");
    if(hint) hint.textContent="Categories load error: "+(e.message||e);
  }
}

init();
