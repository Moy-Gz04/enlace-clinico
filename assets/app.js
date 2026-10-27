/* =====================================================================
   ENLACE CLÍNICO — recepción médica virtual (versión de pruebas)

   Los datos viven en el servidor (API en Render + PostgreSQL en Neon).
   `Store` guarda en memoria lo que el servidor permite ver a este usuario
   y, al guardar, manda al servidor solo los registros que cambiaron. El
   servidor valida permisos, horarios y firma los tickets; si rechaza algo,
   el cliente recarga el estado real y avisa el motivo.

   Seguridad ya aplicada en el cliente:
   - contraseñas con PBKDF2-SHA256 (150 000 iteraciones, sal única)
   - bloqueo de 5 min tras 5 intentos fallidos; mensaje genérico
   - sesión que caduca a los 20 min sin actividad
   - contraseña temporal obligatoria de cambiar en el primer acceso
   - permisos por rol en cada acción (admin / médico solo lo suyo)
   - tickets firmados con HMAC-SHA256 (clave secreta de la instalación)
   - bitácora de accesos y cambios
   - todo texto del usuario se escapa al pintar; límites de longitud
   ===================================================================== */
"use strict";

/* ================= utilidades ================= */
const $ = s => document.querySelector(s);
const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const pad = n => String(n).padStart(2,"0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const fromYmd = s => { const [y,m,d] = String(s).split("-").map(Number); return new Date(y,m-1,d); };
const hoy = () => ymd(new Date());
const addDays = (s,n) => { const d = fromYmd(s); d.setDate(d.getDate()+n); return ymd(d); };
const addMonths = (s,n) => { const d = fromYmd(s); d.setMonth(d.getMonth()+n); return ymd(d); };
const DIAS = ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"];
const fechaLarga = s => fromYmd(s).toLocaleDateString("es-MX",{weekday:"long",day:"numeric",month:"long",year:"numeric"});
const fechaCorta = s => fromYmd(s).toLocaleDateString("es-MX",{day:"numeric",month:"short"});
const fechaHora = iso => new Date(iso).toLocaleString("es-MX",{dateStyle:"medium",timeStyle:"short"});
const dinero = n => Number(n||0).toLocaleString("es-MX",{style:"currency",currency:"MXN",maximumFractionDigits:0});
const minutos = h => { const [a,b] = String(h).split(":").map(Number); return a*60+b; };
const hhmm = m => `${pad(Math.floor(m/60))}:${pad(m%60)}`;
/* Hora para mostrar: 12 h con AM / PM (internamente se guarda en 24 h) */
const h12 = h => { if(!h) return ""; const [H,M] = String(h).split(":").map(Number); return `${((H+11)%12)+1}:${pad(M)} ${H>=12?"PM":"AM"}`; };
const iniciales = n => String(n||"?").replace(/^(dr|dra|lic)\.?\s+/i,"").split(/\s+/).slice(0,2).map(w=>w[0]||"").join("").toUpperCase();
const limpiar = (v, max=120) => String(v ?? "").replace(/[\u0000-\u001F\u007F]/g," ").trim().slice(0,max);
const limpiarTexto = (v, max=600) => String(v ?? "").replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g," ").trim().slice(0,max);
const hex = buf => [...new Uint8Array(buf)].map(x=>x.toString(16).padStart(2,"0")).join("");
const bytesHex = h => new Uint8Array(h.match(/../g).map(x=>parseInt(x,16)));
const randHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
function aleatorio(n, abc="ABCDEFGHJKMNPQRSTUVWXYZ23456789"){ const a = crypto.getRandomValues(new Uint8Array(n)); return [...a].map(x=>abc[x%abc.length]).join(""); }
const espera = ms => new Promise(r=>setTimeout(r,ms));
const COLORES = ["#0B7A63","#2563A8","#9A4A9B","#C2552E","#2D7F8F","#7A6A1E","#B23A62"];
/* Catálogo inicial de planes. Desde la pantalla "Planes" el administrador los edita;
   lo que se guarda en los datos es lo que manda. Límite 0 = ilimitado. */
const PLANES_BASE = [
  { id:"prueba", nombre:"Prueba gratis", precio:0, dias:7, orden:0, activo:true, destacado:false, prueba:true,
    lema:"Conoce la recepción virtual sin costo durante 7 días.",
    limites:{ citasMes:15, descargas:false, reagendar:false, recordatorios:false, reportes:false },
    incluye:["Hasta 15 citas durante la prueba","Tickets con QR verificable","Portal del médico en celular y tablet","Escaneo de QR en consultorio"],
    excluye:["Descarga de tickets en PDF o imagen","Reagendar citas","Recordatorios a pacientes","Reporte mensual"] },
  { id:"esencial", nombre:"Esencial", precio:890, orden:1, activo:true, destacado:false,
    lema:"Para el consultorio que empieza a delegar su agenda.",
    limites:{ citasMes:60, descargas:true, reagendar:true, recordatorios:false, reportes:false },
    incluye:["Hasta 60 citas al mes","Tickets con QR en PDF e imagen","Reagendar y cancelar sin costo","Portal del médico"],
    excluye:["Recordatorios a pacientes","Reporte mensual"] },
  { id:"profesional", nombre:"Profesional", precio:1490, orden:2, activo:true, destacado:true,
    lema:"La recepción completa para una consulta con agenda llena.",
    limites:{ citasMes:0, descargas:true, reagendar:true, recordatorios:true, reportes:true },
    incluye:["Citas ilimitadas","Recordatorio al paciente un día antes","Reporte mensual de citas y asistencia","Todo lo del plan Esencial"],
    excluye:[] },
  { id:"clinica", nombre:"Clínica", precio:2490, orden:3, activo:true, destacado:false,
    lema:"Para consultorios con varios horarios, sedes o asistentes.",
    limites:{ citasMes:0, descargas:true, reagendar:true, recordatorios:true, reportes:true },
    incluye:["Todo lo del plan Profesional","Atención prioritaria de la recepción","Lista de espera para huecos que se liberan","Hasta 2 sedes de consulta"],
    excluye:[] },
];
const PLAN_POR_NOMBRE = { "Esencial":"esencial", "Profesional":"profesional", "Clínica":"clinica", "Prueba gratis":"prueba" };
const planes = () => d().planes.slice().sort((a,b)=>a.orden-b.orden);
const planPorId = id => d().planes.find(p=>p.id===id) || d().planes.find(p=>p.id==="esencial") || d().planes[0];
const planDe = doc => planPorId(doc?.plan);
function migrar(){
  const x = Store.d; if(!x) return;
  for(const k of ["doctores","citas","planes","solicitudes","mensajes","usuarios","bitacora"]) if(!Array.isArray(x[k])) x[k] = [];
}
/* uso y límites del plan de un médico */
function citasDelMes(doctorId, fecha=hoy()){ const m=fecha.slice(0,7); return d().citas.filter(c=>c.doctorId===doctorId && c.estado!=="cancelada" && c.fecha.slice(0,7)===m).length; }
function citasDePrueba(doc){ return d().citas.filter(c=>c.doctorId===doc.id && c.estado!=="cancelada" && (!doc.pruebaInicio || (c.creado||"")>=doc.pruebaInicio)).length; }
function diasDePrueba(doc){ if(!doc.pruebaHasta) return null; return Math.round((fromYmd(doc.pruebaHasta)-fromYmd(hoy()))/864e5); }
function puede(doc, accion){
  const p = planDe(doc); const L = p.limites||{};
  if(accion==="agendar"){
    if(doc.estado==="pausada") return "La suscripción está pausada.";
    if(p.prueba){ const r=diasDePrueba(doc); if(r!==null && r<0) return "La prueba gratis terminó. Elige un plan para seguir recibiendo citas.";
      if(L.citasMes && citasDePrueba(doc)>=L.citasMes) return `Se alcanzó el límite de ${L.citasMes} citas de la prueba gratis.`; }
    else if(L.citasMes && citasDelMes(doc.id, S.ag.fecha||hoy())>=L.citasMes) return `El plan ${p.nombre} incluye ${L.citasMes} citas al mes y ya se alcanzaron.`;
    return "";
  }
  if(accion==="descargas") return L.descargas===false ? `Las descargas no están incluidas en el plan ${p.nombre}.` : "";
  if(accion==="reagendar") return L.reagendar===false ? `Reagendar no está incluido en el plan ${p.nombre}.` : "";
  return "";
}
const USUARIO_RE = /^[a-z0-9._-]{4,32}$/;

/* ================= criptografía ================= */
async function pbkdf2(password, saltHex){
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({name:"PBKDF2", salt:bytesHex(saltHex), iterations:150000, hash:"SHA-256"}, key, 256);
  return hex(bits);
}
async function hmac(secretHex, texto){
  const key = await crypto.subtle.importKey("raw", bytesHex(secretHex), {name:"HMAC", hash:"SHA-256"}, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(texto)));
}
function igualSeguro(a,b){ if(a.length!==b.length) return false; let r=0; for(let i=0;i<a.length;i++) r|=a.charCodeAt(i)^b.charCodeAt(i); return r===0; }
function fuerza(pw){
  let p=0; if(pw.length>=8) p++; if(pw.length>=12) p++; if(/[a-z]/.test(pw)&&/[A-Z]/.test(pw)) p++; if(/\d/.test(pw)) p++; if(/[^A-Za-z0-9]/.test(pw)) p++;
  return p; // 0-5
}
function validarPassword(pw){
  if(pw.length<10) return "Usa al menos 10 caracteres.";
  if(!/[a-z]/.test(pw) || !/[A-Z]/.test(pw)) return "Combina mayúsculas y minúsculas.";
  if(!/\d/.test(pw)) return "Incluye al menos un número.";
  if(!/[^A-Za-z0-9]/.test(pw)) return "Incluye al menos un símbolo (#, $, !…).";
  return "";
}
const passwordTemporal = () => aleatorio(4,"ABCDEFGHJKMNPQRSTUVWXYZ") + aleatorio(4,"abcdefghjkmnpqrstuvwxyz") + aleatorio(3,"23456789") + "#";
const firmaTexto = c => [c.folio,c.doctorId,c.fecha,c.hora,(c.paciente?.nombre||"").trim().toUpperCase(),c.token].join("|");
const b64url = t => btoa(String.fromCharCode(...new TextEncoder().encode(t))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const deB64url = t => new TextDecoder().decode(Uint8Array.from(atob(t.replace(/-/g,"+").replace(/_/g,"/")), ch=>ch.charCodeAt(0)));
function qrTexto(c){
  const doc = typeof docById==="function" ? docById(c.doctorId) : null;
  const datos = { f:c.folio, p:c.paciente?.nombre||"", m:doc?.nombre||"", e:doc?.especialidad||"", c:doc?.consultorio||"", d:c.fecha, h:c.hora, t:c.token };
  return `EC1.${b64url(JSON.stringify(datos))}.${(c.firma||"").slice(0,16)}`;
}
/* Lee cualquier formato: QR nuevo (EC1.…), QR anterior (ENLACE-CLINICO|…) o el folio escrito a mano */
function leerCodigo(t){
  t = String(t||"").trim();
  if(t.startsWith("EC1.")){ const [,cuerpo,frag] = t.split("."); try{ const x = JSON.parse(deB64url(cuerpo)); return { folio:x.f, token:x.t, frag, datos:x }; }catch(e){ return { folio:null, invalido:true }; } }
  if(t.startsWith("ENLACE-CLINICO|")){ const [,folio,token,frag] = t.split("|"); return { folio, token, frag }; }
  return { folio:t.toUpperCase() };
}

/* ================= almacén de pruebas (localStorage) ================= */
const API = String(window.EC_API || "").replace(/\/$/, "");
/* Ventana de "cargando": aparece si una operación con el servidor tarda más
   de medio segundo, bloquea la pantalla mientras tanto y dice qué ocurre. */
const Cargando = (() => {
  let n = 0, timer = null, lento = null, el = null, texto = "Cargando…";
  const crear = () => { el = document.createElement("div"); el.className = "cargando"; el.setAttribute("role","status"); el.setAttribute("aria-live","polite");
    el.innerHTML = `<div class="cargando-caja"><span class="cargando-marca">${typeof ICON!=="undefined"?ICON.marca:""}</span><span class="cargando-barra"><i></i></span><b></b><small>Un momento, por favor.</small></div>`; document.body.appendChild(el); };
  const mostrar = () => { if(!el) crear(); el.querySelector("b").textContent = texto; el.querySelector("small").textContent = "Un momento, por favor."; el.classList.add("visible");
    lento = setTimeout(()=>{ if(el) el.querySelector("small").textContent = "El servidor está despertando; puede tardar hasta un minuto la primera vez."; }, 6000); };
  return {
    inicio(t){ texto = t || texto; if(n++ === 0){ clearTimeout(timer); timer = setTimeout(mostrar, 450); } else if(el?.classList.contains("visible")) el.querySelector("b").textContent = texto; },
    fin(){ if(n === 0) return; if(--n === 0){ clearTimeout(timer); clearTimeout(lento); el?.classList.remove("visible"); } },
  };
})();
const TOKEN_KEY = "enlace-clinico:token";
const Store = (() => {
  const COLS = ["doctores","citas","planes","solicitudes","mensajes"];
  let datos = null, base = {}, token = null, version = "", cola = Promise.resolve(true), sincronizando = false;
  try{ token = sessionStorage.getItem(TOKEN_KEY); }catch(e){}
  const foto = () => { base = {}; COLS.forEach(c=>{ base[c] = new Map((datos[c]||[]).map(x=>[x.id, JSON.stringify(x)])); }); };
  async function api(metodo, ruta, cuerpo, opc={}){
    let r;
    if(!opc.silencioso) Cargando.inicio(opc.texto || (metodo==="GET" ? "Cargando…" : metodo==="DELETE" ? "Eliminando…" : "Guardando…"));
    try{
      r = await fetch(`${API}/api${ruta}`, { method:metodo, headers:{ ...(cuerpo!==undefined?{"Content-Type":"application/json"}:{}), ...(token?{Authorization:`Bearer ${token}`}:{}) }, body: cuerpo!==undefined ? JSON.stringify(cuerpo) : undefined });
    }catch(e){ if(!opc.silencioso) Cargando.fin(); const er = new Error("No hay conexión con el servidor. Revisa tu internet."); er.red = true; throw er; }
    let j = {}; try{ j = await r.json(); }catch(e){}
    if(!opc.silencioso) Cargando.fin();
    if(r.status===401 && token && !ruta.startsWith("/auth/login")){ token=null; try{ sessionStorage.removeItem(TOKEN_KEY); }catch(e){} if(typeof cerrarSesion==="function" && S.usuario) setTimeout(()=>cerrarSesion("expirada"),0); }
    if(!r.ok){ const er = new Error(j.error || "El servidor no respondió como se esperaba."); er.status = r.status; er.datos = j; throw er; }
    return j;
  }
  async function sincronizar(){
    if(!datos) return true;
    sincronizando = true;
    let cambioServidor = false;
    try{
      for(const c of COLS){
        const lista = datos[c] || [], vistos = new Set();
        for(const x of lista){
          vistos.add(x.id);
          const txt = JSON.stringify(x);
          if(base[c].get(x.id) === txt) continue;
          const { data } = await api("PUT", `/docs/${c}/${encodeURIComponent(x.id)}`, { data:x }, { silencioso: c==="mensajes", texto: c==="citas" ? "Guardando la cita…" : c==="doctores" ? "Guardando el perfil…" : "Guardando…" });
          const i = lista.findIndex(o=>o.id===x.id); if(i>=0) lista[i] = data;
          const nuevo = JSON.stringify(data); base[c].set(x.id, nuevo); if(nuevo!==txt) cambioServidor = true;
        }
        for(const id of [...base[c].keys()]) if(!vistos.has(id)){ await api("DELETE", `/docs/${c}/${encodeURIComponent(id)}`); base[c].delete(id); }
      }
      return true;
    }catch(e){
      toast(e.message);
      try{ await Store.cargar(); }catch(_){}
      cambioServidor = true;
      return false;
    }finally{
      sincronizando = false;
      if(cambioServidor && S.usuario && !$("#ov")) render();
    }
  }
  return {
    api,
    get d(){ return datos; },
    get token(){ return token; },
    ponerToken(t){ token = t; try{ t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); }catch(e){} },
    async cargar(opc={}){ const j = await api("GET","/estado",undefined,opc); datos = j; version = j.version; migrar(); foto(); return datos; },
    /* manda al servidor lo que cambió; devuelve una promesa con true/false */
    guardar(){ cola = cola.then(sincronizar, sincronizar); return cola; },
    /* ¿hay cambios en el servidor? (otro usuario agendó, escribió, etc.) */
    async revisar(){
      if(!token || !datos || sincronizando) return false;
      const { version:v } = await api("GET","/version",undefined,{silencioso:true});
      if(v === version) return false;
      await cola; await this.cargar({silencioso:true}); return true;
    },
    limpiar(){ datos = null; base = {}; version = ""; },
  };
})();

function bitacora(accion, detalle=""){
  const x = Store.d; if(!x || !S.usuario) return;
  const e = { fecha:new Date().toISOString(), usuario:S.usuario.usuario, accion, detalle:limpiar(detalle,200) };
  if(Array.isArray(x.bitacora)) x.bitacora.unshift(e);
  Store.api("POST","/bitacora",{accion, detalle:e.detalle},{silencioso:true}).catch(()=>{});
}

function nuevoFolio(){ const d=new Date(); return `EC-${String(d.getFullYear()).slice(2)}${pad(d.getMonth()+1)}-${aleatorio(5)}`; }

/* ================= estado y sesión ================= */
const S = { chatCon:"", chatBorrador:{}, chatBusca:"", usuario:null, vista:"", filtro:{q:"",estado:"proximas",doctor:""}, ag:{doctorId:"",fecha:"",hora:""}, intentoLogin:{} };
const SESION_KEY = "enlace-clinico:sesion";
const INACTIVIDAD_MS = 20*60*1000;
const d = () => Store.d;
const docById = id => d().doctores.find(x=>x.id===id);
const esAdmin = () => S.usuario?.rol==="admin";
const miDoctor = () => S.usuario?.rol==="medico" ? docById(S.usuario.doctorId) : null;

function exigir(rol, doctorId){
  if(!S.usuario) throw new Error("Tu sesión terminó. Vuelve a entrar.");
  if(rol==="admin" && !esAdmin()) throw new Error("Solo la recepción puede hacer esto.");
  if(rol==="medico" && !esAdmin() && S.usuario.doctorId!==doctorId) throw new Error("Esta cita no pertenece a tu consultorio.");
}
function guardarSesion(){ try{ sessionStorage.setItem(SESION_KEY, JSON.stringify({exp:Date.now()+INACTIVIDAD_MS})); }catch(e){} }
function leerSesion(){ try{ const s = JSON.parse(sessionStorage.getItem(SESION_KEY)||"null"); if(!s || s.exp<Date.now()) return null; return s; }catch(e){ return null; } }
function cerrarSesion(motivo){
  if(S.usuario && motivo!=="expirada"){ bitacora("Cierre de sesión", motivo||""); Notif.baja(); }
  S.usuario=null; Store.ponerToken(null); Store.limpiar(); try{ sessionStorage.removeItem(SESION_KEY); }catch(e){}
  document.querySelectorAll(".toast").forEach(t=>t.remove());
  cerrarCapa(); pintarLogin(motivo==="inactividad" ? "Tu sesión se cerró por inactividad." : motivo==="expirada" ? "Tu sesión terminó. Vuelve a entrar." : "");
}
let ultimoToque = 0;
["click","keydown","touchstart"].forEach(ev=>document.addEventListener(ev,()=>{ if(S.usuario && Date.now()-ultimoToque>15000){ ultimoToque=Date.now(); guardarSesion(); } },{passive:true}));
setInterval(()=>{ if(S.usuario && !leerSesion()) cerrarSesion("inactividad"); }, 30000);
// otra pestaña cambió los datos (p. ej. la recepción agenda y el médico tiene su portal abierto)
/* Sincronización: cada pocos segundos se pregunta al servidor si hubo cambios
   (más seguido en Mensajes). No se repinta mientras se llena un formulario. */
let ocupadoEscribiendo = false;
document.addEventListener("focusin", e=>{ ocupadoEscribiendo = !!e.target.closest?.("#fAgenda, #fDoc, #fPlan, #fPerfil, #fCert, #fHor, #fBloq, #fAus, #fPw, #fSol, #fAviso"); });
document.addEventListener("focusout", ()=>{ ocupadoEscribiendo = false; });
async function sondear(){
  try{
    if(!S.usuario || !$("#app") || document.hidden) return;
    if(await Store.revisar()){
      const u = Store.d.usuarios?.find(x=>x.id===S.usuario.id); if(u && !u.activo) return cerrarSesion("cuenta desactivada");
      avisarMensajeNuevo();
      if(!$("#ov") && !ocupadoEscribiendo) render(); else pintarNav();
    }
  }catch(e){ /* sin conexión: se reintenta en el siguiente ciclo */ }
  finally{ setTimeout(sondear, S.vista==="mensajes" ? 3000 : 8000); }
}
document.addEventListener("visibilitychange", ()=>{ if(!document.hidden) Store.revisar().then(c=>{ if(c && S.usuario && !$("#ov") && !ocupadoEscribiendo) render(); }).catch(()=>{}); });

/* ================= horarios ================= */
const enAusencia = (doc, fecha) => (doc?.ausencias||[]).find(a=>fecha>=a.desde && fecha<=a.hasta) || null;
/* Horario de un día: cada día de la semana puede tener su propio rango
   (horario.horas[dia] = {inicio, fin}); si no, se usa el rango general. */
function rangoDelDia(doc, fecha){
  const h = doc?.horario; if(!h) return null;
  const dia = fromYmd(fecha).getDay();
  if(!(h.dias||[]).includes(dia)) return null;
  const r = h.horas?.[dia] || { inicio:h.inicio, fin:h.fin };
  return { inicio:minutos(r.inicio), fin:minutos(r.fin), dur:Number(h.duracion||30) };
}
const durCita = (c, doc) => Number(c.duracion || doc?.horario?.duracion || 30);
const traslapa = (a1,a2,b1,b2) => a1 < b2 && b1 < a2;
function ocupacion(doc, fecha, citas, excepto){
  const out = [];
  citas.forEach(c=>{ if(c.doctorId===doc.id && c.fecha===fecha && c.estado!=="cancelada" && c.id!==excepto){ const m=minutos(c.hora); out.push({ini:m, fin:m+durCita(c,doc), tipo:"cita", c}); } });
  (doc.bloqueos||[]).forEach(bq=>{ if(bq.fecha===fecha) out.push({ini:minutos(bq.desde), fin:minutos(bq.hasta), tipo:"bloqueo", bq}); });
  return out;
}
/* Por qué no se puede agendar a esa hora ("" = sí se puede). */
function conflicto(doc, fecha, hora, excepto, dur){
  if(!doc) return "Elige un médico.";
  if(!/^\d{2}:\d{2}$/.test(hora||"")) return "Escribe una hora válida.";
  if(enAusencia(doc, fecha)) return `${doc.nombre} estará ausente ese día.`;
  const r = rangoDelDia(doc, fecha); if(!r) return `${doc.nombre} no atiende ese día.`;
  const m = minutos(hora), fin = m + (dur || r.dur);
  if(m < r.inicio || fin > r.fin) return `Fuera de su horario (${h12(hhmm(r.inicio))} a ${h12(hhmm(r.fin))}; cada cita dura ${r.dur} min).`;
  const ahora = new Date(); if(fecha===hoy() && m <= ahora.getHours()*60+ahora.getMinutes()) return "Esa hora ya pasó.";
  const choque = ocupacion(doc, fecha, d().citas, excepto).find(o=>traslapa(m, fin, o.ini, o.fin));
  if(choque) return choque.tipo==="cita" ? `Choca con la cita de las ${h12(choque.c.hora)} (${h12(hhmm(choque.ini))} a ${h12(hhmm(choque.fin))}).` : `El médico marcó de ${h12(hhmm(choque.ini))} a ${h12(hhmm(choque.fin))} como no disponible${choque.bq.motivo?` (${choque.bq.motivo})`:""}.`;
  return "";
}
function horariosPara(doc, fecha, citas, excepto){
  if(!doc?.horario || enAusencia(doc, fecha)) return [];
  const r = rangoDelDia(doc, fecha); if(!r) return [];
  const ocup = ocupacion(doc, fecha, citas, excepto);
  const ahora = new Date(), esHoy = fecha===hoy(), min = ahora.getHours()*60+ahora.getMinutes(), out = [];
  for(let m=r.inicio; m+r.dur<=r.fin; m+=r.dur){
    const o = ocup.find(x=>traslapa(m, m+r.dur, x.ini, x.fin));
    const estado = o ? (o.tipo==="cita"?"ocupado":"bloqueado") : (esHoy && m<=min) ? "pasado" : "libre";
    out.push({ hora:hhmm(m), libre:estado==="libre", estado });
  }
  // citas a hora exacta que no caen en la rejilla: se muestran también
  ocup.filter(o=>o.tipo==="cita" && !out.some(s=>s.hora===o.c.hora)).forEach(o=>out.push({hora:o.c.hora, libre:false, estado:"ocupado", extra:true}));
  return out.sort((a,b)=>a.hora.localeCompare(b.hora));
}
const horarios = (doc,fecha,excepto) => horariosPara(doc, fecha, d().citas, excepto);
const ocupada = (doctorId,fecha,hora,excepto) => !!conflicto(docById(doctorId), fecha, hora, excepto);
function estadoSuscripcion(x){
  if(x.estado==="pausada") return {txt:"Pausada",cls:"neu"};
  if(planDe(x)?.prueba){ const r=diasDePrueba(x); if(r===null) return {txt:"En prueba",cls:"warn"}; return r<0 ? {txt:"Prueba vencida",cls:"bad"} : {txt:r===0?"Prueba: último día":`Prueba: quedan ${r} d`,cls:"warn"}; }
  if(!x.proximoPago) return {txt:"Activa",cls:"ok"};
  const dias = Math.round((fromYmd(x.proximoPago)-fromYmd(hoy()))/864e5);
  if(dias<0) return {txt:`Pago vencido (${-dias} d)`,cls:"bad"};
  if(dias<=5) return {txt:dias===0?"Pago hoy":`Pago en ${dias} d`,cls:"warn"};
  return {txt:"Al corriente",cls:"ok"};
}
const chipEstadoCita = e => e==="atendida" ? '<span class="chip neu">Atendida</span>' : e==="cancelada" ? '<span class="chip bad">Cancelada</span>' : '<span class="chip ok">Confirmada</span>';
function textoHorario(x){
  const h=x.horario||{}; const orden=[1,2,3,4,5,6,0].filter(n=>(h.dias||[]).includes(n));
  const rango = n => { const r=h.horas?.[n]||{inicio:h.inicio,fin:h.fin}; return `${h12(r.inicio)} a ${h12(r.fin)}`; };
  const grupos=[]; orden.forEach(n=>{ const g=grupos[grupos.length-1]; if(g && g.r===rango(n)) g.d.push(n); else grupos.push({r:rango(n), d:[n]}); });
  return `${grupos.map(g=>`${g.d.map(n=>DIAS[n]).join(", ")} ${g.r}`).join(" · ")} · citas de ${h.duracion||30} min`;
}

/* ================= iconos ================= */
const svg = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICON = {
  panel:svg('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>'),
  agendar:svg('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M12 14v4M10 16h4"/>'),
  citas:svg('<path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z"/><path d="M14 5v14" stroke-dasharray="2 2"/>'),
  medicos:svg('<path d="M6 3v6a4 4 0 0 0 8 0V3"/><path d="M10 13v3a5 5 0 0 0 10 0v-2"/><circle cx="20" cy="12" r="2"/>'),
  camara:svg('<path d="M3 8a2 2 0 0 1 2-2h2l2-2h6l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/>'),
  reloj:svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  sala:svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4M7 9h3M7 12h6"/>'),
  campana:svg('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
  estetoscopio:svg('<path d="M6 3v5a4 4 0 0 0 8 0V3"/><path d="M10 12v2a5 5 0 0 0 10 0v-1"/><circle cx="20" cy="11" r="2"/>'),
  mas_menu:svg('<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>'),
  mensajes:svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/><path d="M8.5 11h7M8.5 14.5h4.5"/>'),
  enviar:svg('<path d="M21 3L10.5 13.5"/><path d="M21 3l-6.5 18-4-7.5L3 9.5z"/>'),
  clip:svg('<path d="M20.5 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/>'),
  megafono:svg('<path d="M3 10v4a1 1 0 0 0 1 1h3l6 4V5L7 9H4a1 1 0 0 0-1 1z"/><path d="M17 8.5a4.5 4.5 0 0 1 0 7M19.5 6a8 8 0 0 1 0 12"/>'),
  perfil:svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="11" r="2.5"/><path d="M5.5 17a3.5 3.5 0 0 1 7 0M15 9h3M15 13h3"/>'),
  planes:svg('<path d="M12 3l8.5 4.5L12 12 3.5 7.5z"/><path d="M3.5 12L12 16.5 20.5 12"/><path d="M3.5 16.5L12 21l8.5-4.5"/>'),
  verificar:svg('<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>'),
  bitacora:svg('<path d="M4 4h12l4 4v12H4z"/><path d="M8 10h8M8 14h8M8 18h5"/>'),
  agenda:svg('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'),
  cuenta:svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  salir:svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
  png:svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/>'),
  pdf:svg('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 18v-6M9 15l3 3 3-3"/>'),
  mas:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  cerrar:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  candado:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  marca:'<svg class="marca" width="18" height="18" viewBox="4.4 1.6 25.6 25.6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4.5v6.2a6 6 0 0 0 12 0V4.5"/><circle cx="7" cy="4" r="1.3" fill="currentColor" stroke="none"/><circle cx="19" cy="4" r="1.3" fill="currentColor" stroke="none"/><path d="M13 16.7v3.1a5.6 5.6 0 0 0 11.2 0v-1.2"/><circle cx="24.2" cy="14" r="5"/><path class="latido" d="M24.2 17.1c-.4 0-3.4-2-3.4-4.1a1.75 1.75 0 0 1 3.4-.8 1.75 1.75 0 0 1 3.4.8c0 2.1-3 4.1-3.4 4.1z" fill="#FF8A8A" stroke="none"/></svg>',
};

function toast(msg){ document.querySelectorAll(".toast").forEach(t=>t.remove()); const t=document.createElement("div"); t.className="toast"; t.setAttribute("role","status"); t.textContent=msg; document.body.appendChild(t); setTimeout(()=>t.remove(),2800); }
function qrPng(text, size=600){
  const qr = qrcode(0,"M"); qr.addData(text); qr.make();
  const n = qr.getModuleCount(), q = 2, cell = Math.max(2, Math.floor(size/(n+q*2)));
  const cv = document.createElement("canvas"); cv.width = cv.height = cell*(n+q*2);
  const g = cv.getContext("2d"); g.fillStyle="#fff"; g.fillRect(0,0,cv.width,cv.height); g.fillStyle="#10242A";
  for(let r=0;r<n;r++) for(let c=0;c<n;c++) if(qr.isDark(r,c)) g.fillRect((c+q)*cell,(r+q)*cell,cell,cell);
  return cv.toDataURL("image/png");
}

/* La marca en PNG (trazo blanco) para dibujarla dentro del PDF */
let MARCA_PNG = null, MARCA_PNG_B = null;
const cargarPng = (url, cb) => { const img=new Image(); img.onload=()=>{ const cv=document.createElement("canvas"); cv.width=img.width; cv.height=img.height; cv.getContext("2d").drawImage(img,0,0); cb(cv.toDataURL("image/png")); }; img.src=url; };
cargarPng("assets/logo-a-negro.png", d=>{ MARCA_PNG = d; }); cargarPng("assets/logo-a-blanco.png", d=>{ MARCA_PNG_B = d; });
(()=>{ return; const svgTxt = ICON.marca.replace('stroke="currentColor"','stroke="#ffffff"').replace(/fill="currentColor"/g,'fill="#ffffff"').replace('width="18" height="18"','width="256" height="256" xmlns="http://www.w3.org/2000/svg"');
  const img = new Image(); img.onload = () => { const cv=document.createElement("canvas"); cv.width=cv.height=256; cv.getContext("2d").drawImage(img,0,0,256,256); MARCA_PNG = cv.toDataURL("image/png"); };
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgTxt); })();

/* ================= LOGIN ================= */
/* Datos de la empresa para el pie de página y los documentos legales (ficticios, de prueba) */
const EMPRESA = {
  nombre:"Assistant", razon:"Assistant Asistentes en Línea, S.A.S. de C.V.",
  correo:"contacto@assistant.mx", privacidad:"privacidad@assistant.mx",
  telefono:"771 450 2210", horario:"Lunes a viernes, 8:00 a 20:00 h · Sábado, 9:00 a 14:00 h",
  domicilio:"Blvd. Felipe Ángeles 1010, Col. Venta Prieta, C.P. 42083, Pachuca de Soto, Hidalgo, México",
};
const LOGO_A = `<span class="logo-a" aria-hidden="true"><img class="solo-claro" src="assets/logo-a-negro.png" alt=""><img class="solo-oscuro" src="assets/logo-a-blanco.png" alt=""></span>`;
const LOGO_COMPLETO = `<span class="logo-completo"><img class="solo-claro" src="assets/logo-negro.png" alt="Assistant · Asistentes en línea"><img class="solo-oscuro" src="assets/logo-blanco.png" alt="Assistant · Asistentes en línea"></span>`;
const MARCA = (sub="") => `<div class="brand">${LOGO_A}<div><b class="marca-txt">ASSISTANT</b>${sub?`<small>${sub}</small>`:""}</div></div>`;
/* Tema: claro (blanco y negro, botones verdes) u oscuro (negro y grises, azul) */
const TEMA_KEY = "assistant:tema";
function temaActual(){ return document.documentElement.dataset.theme || "light"; }
function aplicarTema(t){ document.documentElement.dataset.theme = t; try{ localStorage.setItem(TEMA_KEY, t); }catch(e){} document.querySelectorAll(".tema-switch").forEach(b=>{ b.setAttribute("aria-checked", String(t==="dark")); b.title = t==="dark" ? "Cambiar a modo claro" : "Cambiar a modo oscuro"; }); document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t==="dark" ? "#0A0A0A" : "#FFFFFF"); }
(()=>{ let t=null; try{ t=localStorage.getItem(TEMA_KEY); }catch(e){} if(!t) t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; document.documentElement.dataset.theme = t; })();
function switchTema(){
  const osc = temaActual()==="dark";
  return `<button type="button" class="tema-switch" role="switch" aria-checked="${osc}" aria-label="Modo oscuro" title="${osc?"Cambiar a modo claro":"Cambiar a modo oscuro"}">
    <span class="ts-ico sol" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></span>
    <span class="ts-ico luna" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></span>
    <span class="ts-perilla" aria-hidden="true"></span></button>`;
}
document.addEventListener("click", e=>{ if(e.target.closest(".tema-switch")) aplicarTema(temaActual()==="dark" ? "light" : "dark"); });

function marcoAcceso(contenido){
  const anio = new Date().getFullYear();
  return `
  <div class="acceso">
    <header class="acc-top">
      ${MARCA("Asistentes en línea")}
      <span class="acc-top-der">${switchTema()}<span class="acc-ayuda">¿Problemas para entrar? <span class="num">${EMPRESA.telefono}</span></span></span>
    </header>
    <main class="acc-main">
      <div class="acc-col">${contenido}</div>
    </main>
    <footer class="acc-pie acc-pie-corto">
      <span>© ${anio} ${esc(EMPRESA.razon)}</span>
      <span>Tel. <span class="num">${esc(EMPRESA.telefono)}</span> · ${esc(EMPRESA.correo)}</span>
      <span class="acc-pie-links"><button type="button" class="acc-link" data-legal="privacidad">Aviso de privacidad</button><button type="button" class="acc-link" data-legal="terminos">Términos</button><button type="button" class="acc-link" data-legal="seguridad">Seguridad</button></span>
    </footer>
  </div>`;
}
const LEGAL = {
  privacidad:["Aviso de privacidad", () => `
    <p><b>${esc(EMPRESA.razon)}</b>, con domicilio en ${esc(EMPRESA.domicilio)}, es responsable del tratamiento de los datos personales que se recaban a través de esta plataforma, conforme a la Ley Federal de Protección de Datos Personales en Posesión de los Particulares.</p>
    <h3>Datos que recabamos</h3><p>De pacientes: nombre, teléfono, edad, motivo de consulta y observaciones necesarias para la cita. De médicos suscriptores: nombre, cédula profesional, especialidad, datos de contacto y del consultorio. Algunos de estos datos se consideran sensibles por referirse al estado de salud; se tratan con medidas de seguridad reforzadas.</p>
    <h3>Para qué los usamos</h3><p>Agendar, confirmar, reagendar y cancelar citas; emitir el ticket de la cita; comunicarnos con el paciente o el médico sobre la cita; administrar la suscripción del médico. No los usamos con fines publicitarios.</p>
    <h3>Con quién los compartimos</h3><p>Únicamente con el médico que atenderá la cita. No vendemos ni cedemos datos a terceros, salvo requerimiento de autoridad competente.</p>
    <h3>Derechos ARCO</h3><p>Puedes acceder, rectificar, cancelar u oponerte al uso de tus datos, o revocar tu consentimiento, escribiendo a <b>${esc(EMPRESA.privacidad)}</b> con tu nombre, el dato que deseas modificar y una copia de tu identificación. Respondemos en un máximo de 20 días hábiles.</p>
    <h3>Cambios a este aviso</h3><p>Cualquier cambio se publicará en esta misma pantalla. Última actualización: ${esc(fechaLarga(hoy()))}.</p>`],
  terminos:["Términos y condiciones", () => `
    <p>El servicio de recepción virtual se presta a médicos suscriptores mediante una mensualidad. La recepción agenda citas dentro del horario que el médico registra y emite un ticket por cada cita.</p>
    <h3>Mensualidad</h3><p>Se paga por adelantado. Si un pago vence, la suscripción puede pausarse y dejar de recibir citas nuevas hasta regularizarse. Las citas ya confirmadas se respetan.</p>
    <h3>Cuentas</h3><p>Cada cuenta es personal e intransferible. El titular es responsable de mantener su contraseña en secreto y de avisar de inmediato si sospecha un uso no autorizado.</p>
    <h3>Responsabilidad médica</h3><p>Assistant solo gestiona la agenda. El diagnóstico, tratamiento y cobro de la consulta son responsabilidad exclusiva del médico.</p>
    <h3>Cancelación</h3><p>El médico puede cancelar su suscripción en cualquier momento avisando a la recepción; el servicio termina al concluir el periodo pagado.</p>`],
  seguridad:["Seguridad de la cuenta", () => `
    <p>Las contraseñas se guardan cifradas con PBKDF2-SHA256 y nunca en texto legible. Nadie de la recepción puede ver tu contraseña; solo puede generarte una temporal que deberás cambiar al entrar.</p>
    <p>Después de 5 intentos fallidos la cuenta se bloquea 5 minutos. La sesión se cierra sola tras 20 minutos sin uso.</p>
    <p>Cada ticket lleva una firma digital: si alguien altera el nombre, la fecha o la hora, la verificación lo detecta.</p>`],
};
function abrirLegal(clave){
  const [titulo, cuerpo] = LEGAL[clave] || []; if(!titulo) return;
  capa(`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="lgT"><div class="modal-h"><h2 id="lgT">${esc(titulo)}</h2><button type="button" class="x" data-cerrar aria-label="Cerrar">${ICON.cerrar}</button></div><div class="modal-b legal">${cuerpo()}</div><div class="modal-f"><button type="button" class="btn btn-primary" data-cerrar>Entendido</button></div></div>`);
}
document.addEventListener("click", e=>{ const b=e.target.closest("[data-legal]"); if(b) abrirLegal(b.dataset.legal); });

function pintarLogin(aviso=""){
  $("#root").innerHTML = marcoAcceso(`
      <form class="acc-form" id="fLogin" novalidate autocomplete="on">
        <div class="acc-logo">${LOGO_COMPLETO}</div>
        <div class="acc-titulo"><h1>Iniciar sesión</h1><p>Entra con el usuario que te asignó tu recepción.</p></div>
        ${aviso?`<div class="err" role="alert">${esc(aviso)}</div>`:""}
        <div class="err" id="lErr" role="alert" hidden></div>
        <label class="field" for="lUser"><span>Usuario</span><input class="input" id="lUser" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="32" required></label>
        <label class="field" for="lPass"><span>Contraseña</span><span class="pw"><input class="input" id="lPass" name="password" type="password" autocomplete="current-password" maxlength="128" required><button type="button" id="lVer" aria-label="Mostrar contraseña">Mostrar</button></span></label>
        <button type="submit" class="btn btn-primary acc-entrar" id="lGo">Entrar</button>
        <p class="acc-nota">¿Olvidaste tu contraseña? Pide a tu recepción una contraseña temporal.</p>
      </form>`);
  ojitos($("#root"));
  $("#fLogin").addEventListener("submit", entrar);
  $("#lUser").focus();
}
async function entrar(ev){
  ev.preventDefault();
  const err=$("#lErr"), btn=$("#lGo"), usuario=limpiar($("#lUser").value,32).toLowerCase(), pass=$("#lPass").value;
  const fallo = m => { err.textContent=m; err.hidden=false; btn.disabled=false; btn.textContent="Entrar"; $("#lPass").value=""; $("#lPass").focus(); };
  if(!usuario || !pass) return fallo("Escribe tu usuario y contraseña.");
  btn.disabled=true; btn.textContent="Verificando…";
  try{
    const r = await Store.api("POST","/auth/login",{ usuario, password:pass },{texto:"Verificando tus datos…"});
    Store.ponerToken(r.token); S.usuario = r.usuario; guardarSesion();
    if(r.usuario.debeCambiar){ pintarCambio(true); return enlazarCambio(); }
    btn.textContent="Cargando tu agenda…";
    await Store.cargar({texto:"Cargando tu agenda…"}); arrancarApp();
  }catch(e){
    if(e.datos?.codigo==="pago"){ fallo(""); err.hidden=true; return ventanaPago(e.datos); }
    fallo(e.message);
  }
}
function pintarCambio(obligatorio){
  const html = `
    <form class="${obligatorio?"acc-form":"panel panel-b"}" id="fPw" novalidate style="display:flex;flex-direction:column;gap:14px;${obligatorio?"":"max-width:520px"}">
      ${obligatorio?`<div class="acc-titulo"><h1>Crea tu contraseña</h1><p>Entraste con una contraseña temporal. Elige una propia para continuar.</p></div>`:`<h2 style="font-size:17px">Cambiar contraseña</h2>`}
      <div class="err" id="pwErr" role="alert" hidden></div>
      ${obligatorio?"":`<label class="field" for="pwAct"><span>Contraseña actual</span><input class="input" id="pwAct" type="password" autocomplete="current-password" maxlength="128"></label>`}
      <label class="field" for="pwNew"><span>Nueva contraseña</span><input class="input" id="pwNew" type="password" autocomplete="new-password" maxlength="128"></label>
      <div class="strength" aria-hidden="true"><i id="pwBar"></i></div>
      <label class="field" for="pwRep"><span>Repite la nueva contraseña</span><input class="input" id="pwRep" type="password" autocomplete="new-password" maxlength="128"></label>
      <p class="note" style="margin:0">Mínimo 10 caracteres, con mayúsculas, minúsculas, un número y un símbolo.</p>
      <div style="display:flex;gap:8px;justify-content:flex-end">${obligatorio?`<button type="button" class="btn" id="pwSalir">Salir</button>`:""}<button type="submit" class="btn btn-primary">Guardar contraseña</button></div>
    </form>`;
  if(obligatorio){ $("#root").innerHTML = marcoAcceso(html); $("#pwSalir").addEventListener("click",()=>cerrarSesion()); ojitos($("#root")); }
  return html;
}
function enlazarCambio(){
  const f=$("#fPw"); if(!f) return;
  $("#pwNew").addEventListener("input",e=>{ const p=fuerza(e.target.value); const bar=$("#pwBar"); bar.style.transform=`scaleX(${p/5})`; bar.style.background=p>=5?"var(--ok)":p>=3?"var(--warn)":"var(--bad)"; });
  f.addEventListener("submit", async ev=>{
    ev.preventDefault(); const err=$("#pwErr"); const show=m=>{ err.textContent=m; err.hidden=false; };
    const nueva=$("#pwNew").value;
    const v=validarPassword(nueva); if(v) return show(v);
    if(nueva!==$("#pwRep").value) return show("Las contraseñas no coinciden.");
    try{
      const r = await Store.api("POST","/auth/password",{ actual:$("#pwAct")?.value||"", nueva },{texto:"Guardando tu contraseña…"});
      Store.ponerToken(r.token); S.usuario = r.usuario; toast("Contraseña actualizada");
      if(!$("#app")){ await Store.cargar(); arrancarApp(); } else render();
    }catch(e){ show(e.message); }
  });
}

/* ================= marco de la app ================= */
const NAV_ADMIN = [["panel","Panel"],["agendar","Agendar"],["citas","Citas"],["mensajes","Mensajes"],["medicos","Médicos"],["sala","Sala de espera"],["planes","Planes"],["verificar","Verificar"],["bitacora","Bitácora"]];
const NAV_DOC = [["agenda","Mis citas"],["mensajes","Mensajes"],["perfil","Mi perfil"],["planes","Mi plan"],["verificar","Verificar"],["cuenta","Mi cuenta"]];
function arrancarApp(){
  S.vista = esAdmin() ? "panel" : "agenda"; vistosMsg = sinLeer();
  if(Notif.estado()==="activo") Notif.suscribir(false).catch(()=>{});
  $("#root").innerHTML = `
  <div class="app" id="app">
    <aside class="side" aria-label="Navegación">
      ${MARCA(esAdmin()?"Administración":"Portal del médico")}
      <nav class="nav" id="nav"></nav>
      <div class="side-foot"><div id="notifBox"></div><div class="tema-fila"><span>Modo oscuro</span>${switchTema()}</div><div class="userbox" id="userbox"></div><button type="button" class="btn btn-sm" data-salir>${ICON.salir}Cerrar sesión</button></div>
    </aside>
    <div style="min-width:0">
      <header class="topbar">${MARCA()}<span class="topbar-der">${switchTema()}<button type="button" class="btn btn-sm" data-salir aria-label="Cerrar sesión">${ICON.salir}Salir</button></span></header>
      <main class="main"><div class="wrap" id="view"></div></main>
    </div>
    <nav class="tabbar" id="tabbar" aria-label="Navegación"></nav>
  </div>`;
  document.querySelectorAll("[data-salir]").forEach(b=>b.addEventListener("click",pedirSalida));
  render();
}
document.addEventListener("click", e=>{ const b = e.target.closest("[data-v]"); if(!b || !S.usuario) return; S.vista=b.dataset.v; render(); window.scrollTo({top:0}); });

function pintarNav(){
  const items = esAdmin() ? NAV_ADMIN : NAV_DOC;
  if(!items.some(i=>i[0]===S.vista) && !(esAdmin() && S.vista==="perfil")) S.vista = items[0][0];
  const prox = d().citas.filter(c=>c.estado==="confirmada" && c.fecha>=hoy()).length;
  $("#nav").innerHTML = items.map(([k,t])=>`<button type="button" data-v="${k}" ${S.vista===k?'aria-current="page"':""}>${ICON[k]}<span>${t}</span>${k==="mensajes"&&sinLeer()?`<span class="cnt num alerta">${sinLeer()}</span>`:k==="panel"&&esAdmin()&&d().citas.some(c=>c.avisoPendiente)?`<span class="cnt num alerta">${d().citas.filter(c=>c.avisoPendiente).length}</span>`:k==="citas"?`<span class="cnt num">${prox}</span>`:k==="medicos"?`<span class="cnt num">${d().doctores.length}</span>`:k==="planes"&&esAdmin()&&d().solicitudes.some(o=>o.estado==="pendiente")?`<span class="cnt num alerta">${d().solicitudes.filter(o=>o.estado==="pendiente").length}</span>`:""}</button>`).join("");
  // barra inferior del celular: 4 accesos principales + "Más" con el resto
  const principales = esAdmin() ? ["panel","agendar","citas","mensajes"] : ["agenda","mensajes","verificar","perfil"];
  const resto = items.filter(([k])=>!principales.includes(k));
  const enResto = resto.some(([k])=>k===S.vista);
  $("#tabbar").innerHTML = items.filter(([k])=>principales.includes(k)).map(([k,t])=>`<button type="button" data-v="${k}" ${S.vista===k?'aria-current="page"':""}>${ICON[k]}<span>${t}</span>${k==="mensajes"&&sinLeer()?`<i class="tab-badge num">${sinLeer()}</i>`:""}</button>`).join("")
    + `<button type="button" id="tabMas" ${enResto?'aria-current="page"':""} aria-haspopup="dialog">${ICON.mas_menu}<span>Más</span></button>`;
  $("#tabMas").onclick = () => {
    capa(`<div class="modal hoja-mas" role="dialog" aria-modal="true" aria-labelledby="masT"><div class="modal-h"><h2 id="masT">Más opciones</h2><button type="button" class="x" data-cerrar aria-label="Cerrar">${ICON.cerrar}</button></div>
      <div class="modal-b"><div class="mas-grid">${resto.map(([k,t])=>`<button type="button" class="mas-item" data-v="${k}" ${S.vista===k?'aria-current="page"':""}>${ICON[k]}<span>${t}</span></button>`).join("")}<button type="button" class="mas-item" data-notif>${ICON.campana}<span>Notificaciones</span></button><button type="button" class="mas-item salir" data-salir>${ICON.salir}<span>Cerrar sesión</span></button></div></div></div>`);
    document.querySelectorAll("#ov [data-v]").forEach(b=>b.addEventListener("click",()=>cerrarCapa()));
    document.querySelector("#ov [data-salir]").addEventListener("click",()=>{ cerrarCapa(); pedirSalida(); });
  };
  const nb = $("#notifBox"); if(nb) nb.innerHTML = botonNotif();
  const doc = miDoctor();
  $("#userbox").innerHTML = `${doc?avatarDe(doc):`<span class="avatar" style="--c:#10242A">${esc(iniciales(S.usuario.nombre||S.usuario.usuario))}</span>`}<div><b>${esc(doc?.nombre||S.usuario.nombre||"Recepción")}</b><small>@${esc(S.usuario.usuario)}</small></div>`;
}

function render(){
  if(!S.usuario || !$("#app")) return;
  const borrador = $("#chatTexto"), conFoco = borrador && document.activeElement===borrador;
  if(borrador) S.chatBorrador[S.chatCon||"_"] = borrador.value;
  Escaner.detener();
  pintarNav();
  const v = $("#view");
  if(esAdmin()){
    v.innerHTML = S.vista==="perfil" && docById(S.perfilDe) ? vistaPerfil(docById(S.perfilDe), false) : ({panel:vistaPanel,agendar:vistaAgendar,citas:vistaCitas,mensajes:vistaMensajes,medicos:vistaMedicos,sala:vistaSala,planes:vistaPlanesAdmin,verificar:vistaVerificar,bitacora:vistaBitacora}[S.vista]||vistaPanel)();
  } else {
    const me = miDoctor();
    if(!me){ v.innerHTML = `<div class="panel empty"><b>Tu cuenta no está ligada a un consultorio</b>Pide a tu recepción que revise tu perfil.</div>`; return; }
    v.innerHTML = S.vista==="mensajes" ? vistaMensajes() : S.vista==="cuenta" ? vistaCuenta(me) : S.vista==="perfil" ? vistaPerfil(me, true) : S.vista==="planes" ? vistaPlanesMedico(me) : S.vista==="verificar" ? vistaVerificar() : vistaMedico(me);
  }
  enlazar();
  const nuevo = $("#chatTexto"); if(nuevo){ nuevo.value = S.chatBorrador[S.chatCon||"_"]||""; autoAltura(nuevo); if(conFoco) nuevo.focus(); }
  document.title = sinLeer() ? `(${sinLeer()}) Enlace Clínico` : "Assistant";
}

/* ================= vistas ================= */
function filaCita(c, conDoctor=true){
  const x = docById(c.doctorId);
  return `<button type="button" class="row" data-ticket="${esc(c.id)}">
    <span class="when"><b class="num">${esc(h12(c.hora))}</b><small>${esc(fechaCorta(c.fecha))}</small></span>
    <span class="who"><b>${esc(c.paciente?.nombre)}</b><small>${conDoctor && x ? `<span class="dot" style="background:${esc(x.color)}"></span>${esc(x.nombre)} · ` : ""}${esc(c.paciente?.motivo || "Consulta")}</small></span>
    ${chipEstadoCita(c.estado)}
  </button>`;
}

function vistaPanel(){
  const t = hoy(), semana = addDays(t,7);
  const activos = d().doctores.filter(x=>x.estado!=="pausada");
  const ingreso = activos.reduce((s,x)=>s+Number(x.cuota||0),0);
  const deHoy = d().citas.filter(c=>c.fecha===t && c.estado!=="cancelada").sort((a,b)=>a.hora.localeCompare(b.hora));
  const prox = d().citas.filter(c=>c.fecha>=t && c.fecha<=semana && c.estado==="confirmada").sort((a,b)=>(a.fecha+a.hora).localeCompare(b.fecha+b.hora));
  const pagos = d().doctores.filter(x=>x.estado!=="pausada" && x.proximoPago && x.proximoPago<=addDays(t,7)).sort((a,b)=>a.proximoPago.localeCompare(b.proximoPago));
  const avisos = d().citas.filter(c=>c.avisoPendiente).sort((a,b)=>(a.fecha+a.hora).localeCompare(b.fecha+b.hora));
  const recetas = d().citas.filter(c=>c.recetaPendiente).sort((a,b)=>(b.consulta?.fecha||"").localeCompare(a.consulta?.fecha||""));
  return `
  <div class="head"><div><div class="eyebrow">${esc(fechaLarga(t))}</div><h1>Recepción del día</h1><p>Tus médicos suscritos, sus citas y los pagos por cobrar.</p></div>
    <button type="button" class="btn btn-primary" data-v="agendar">${ICON.mas}Agendar cita</button></div>
  <div class="kpis">
    <div class="panel kpi"><span>Suscriptores activos</span><b class="num">${activos.length}</b><small>de ${d().doctores.length} médicos</small></div>
    <div class="panel kpi"><span>Ingreso mensual</span><b class="num">${dinero(ingreso)}</b><small>mensualidades activas</small></div>
    <div class="panel kpi"><span>Citas de hoy</span><b class="num">${deHoy.length}</b><small>${deHoy.filter(c=>c.estado==="atendida").length} atendidas</small></div>
    <div class="panel kpi"><span>Próximos 7 días</span><b class="num">${prox.length}</b><small>citas confirmadas</small></div>
  </div>
  ${recetas.length?`<section class="panel recetas"><div class="panel-h"><h2>Recetas por enviar al paciente</h2><span class="chip ok">${recetas.length} consulta${recetas.length>1?"s":""} terminada${recetas.length>1?"s":""}</span></div>
    <div class="rows">${recetas.map(c=>{ const x=docById(c.doctorId); return `<div class="row" style="cursor:default;grid-template-columns:auto minmax(0,1fr) auto">${x?avatarDe(x):""}<span class="who"><b>${esc(c.paciente?.nombre)} · <span class="num">${esc(c.paciente?.telefono||"sin teléfono")}</span></b><small>${esc(x?.nombre||"")} · ${esc(fechaCorta(c.fecha))} ${esc(h12(c.hora))}</small></span><span style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end"><button type="button" class="btn btn-sm" data-ver-consulta="${esc(c.id)}">Ver</button><button type="button" class="btn btn-sm" data-receta-pdf="${esc(c.id)}">${ICON.pdf}PDF</button><button type="button" class="btn btn-sm btn-primary" data-receta-ok="${esc(c.id)}">Enviada</button></span></div>`; }).join("")}</div></section>`:""}
  ${avisos.length?`<section class="panel avisos"><div class="panel-h"><h2>Pacientes por avisar</h2><span class="chip bad">${avisos.length} cita${avisos.length>1?"s":""} cancelada${avisos.length>1?"s":""} por el médico</span></div>
    <div class="rows">${avisos.map(c=>{ const x=docById(c.doctorId); return `<div class="row" style="cursor:default;grid-template-columns:76px minmax(0,1fr) auto"><span class="when"><b class="num">${esc(h12(c.hora))}</b><small>${esc(fechaCorta(c.fecha))}</small></span><span class="who"><b>${esc(c.paciente?.nombre)} · <span class="num">${esc(c.paciente?.telefono||"sin teléfono")}</span></b><small>${esc(x?.nombre||"")} · ${esc(c.motivoCancelacion||"Cancelada por el médico")}</small></span><span style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end"><button type="button" class="btn btn-sm" data-aviso-ok="${esc(c.id)}">Ya le avisé</button><button type="button" class="btn btn-sm btn-primary" data-reubicar="${esc(c.id)}">Reagendar</button></span></div>`; }).join("")}</div></section>`:""}
  <div class="two">
    <section class="panel"><div class="panel-h"><h2>Próximas citas</h2><button type="button" class="btn btn-sm" data-v="citas">Ver todas</button></div>
      <div class="rows">${prox.length ? prox.slice(0,8).map(c=>filaCita(c)).join("") : `<div class="empty"><b>Sin citas en los próximos 7 días</b>Cuando un paciente te contacte, agenda su cita y aparecerá aquí.</div>`}</div></section>
    <section class="panel"><div class="panel-h"><h2>Pagos por cobrar</h2></div>
      <div class="rows">${pagos.length ? pagos.map(x=>`<div class="row" style="cursor:default;grid-template-columns:40px minmax(0,1fr) auto"><span class="avatar" style="--c:${esc(x.color)};width:36px;height:36px;font-size:13px">${esc(iniciales(x.nombre))}</span><span class="who"><b>${esc(x.nombre)}</b><small>${esc(x.plan)} · ${dinero(x.cuota)} · ${esc(estadoSuscripcion(x).txt.toLowerCase())}</small></span><button type="button" class="btn btn-sm" data-pago="${esc(x.id)}">Cobrar</button></div>`).join("") : `<div class="empty"><b>Todo al corriente</b>Ningún pago vence en los próximos 7 días.</div>`}</div></section>
  </div>`;
}

function vistaAgendar(){
  const activos = d().doctores.filter(x=>x.estado!=="pausada");
  if(!activos.length) return `<div class="head"><div><div class="eyebrow">Nueva cita</div><h1>Agendar cita</h1></div></div><div class="panel empty"><b>Primero registra un médico</b>Necesitas al menos un suscriptor activo para agendar.<div style="margin-top:12px"><button type="button" class="btn btn-primary" data-nuevo-doc>${ICON.mas}Nuevo suscriptor</button></div></div>`;
  if(!S.ag.doctorId || !activos.some(x=>x.id===S.ag.doctorId)) S.ag.doctorId = activos[0].id;
  const x = docById(S.ag.doctorId);
  const dias = Array.from({length:S.ag.alcance||60},(_,i)=>addDays(hoy(),i));
  if(!S.ag.fecha || !dias.includes(S.ag.fecha)) S.ag.fecha = dias.find(f=>horarios(x,f).some(h=>h.libre)) || dias[0];
  const slots = horarios(x,S.ag.fecha);
  const ausHoy = enAusencia(x, S.ag.fecha);
  if(S.ag.hora && conflicto(x, S.ag.fecha, S.ag.hora)) S.ag.hora = "";
  const horaExacta = S.ag.hora && !slots.some(o=>o.hora===S.ag.hora);
  const bloqueosDia = (x.bloqueos||[]).filter(bq=>bq.fecha===S.ag.fecha);
  return `
  <div class="head"><div><div class="eyebrow">Nueva cita</div><h1>Agendar cita</h1><p>Elige médico, día y hora; al guardar se genera el ticket con QR.</p></div></div>
  <div class="two">
    <form class="panel panel-b" id="fAgenda" style="display:flex;flex-direction:column;gap:22px" novalidate>
      <div class="step"><h3><i>1</i>Médico</h3><div class="docpick">${activos.map(o=>`<button type="button" data-agdoc="${esc(o.id)}" aria-pressed="${o.id===x.id}">${avatarDe(o)}<span><b>${esc(o.nombre)}</b><small>${esc(o.especialidad)}</small></span></button>`).join("")}</div></div>
      <div class="step"><h3><i>2</i>Día
          <span class="seg seg-sm" role="group" aria-label="Vista de días"><button type="button" data-agvista="semanas" aria-pressed="${S.ag.vista!=="mes"}">2 semanas</button><button type="button" data-agvista="mes" aria-pressed="${S.ag.vista==="mes"}">Mes</button></span></h3>
        <div class="leyenda"><span class="ley libre">Disponible</span><span class="ley sel">Seleccionado</span><span class="ley lleno">Lleno</span><span class="ley aus">Ausente</span><span class="ley no">No atiende</span></div>
        ${S.ag.vista==="mes" ? calendarioMes(x) : `<div class="days">${dias.slice(0,14).map(f=>celdaDia(x,f,"dia")).join("")}</div>`}</div>
      <div class="step"><h3><i>3</i>Hora · <span style="font-weight:500">${esc(fechaLarga(S.ag.fecha))}</span>${slots.length?`<span class="leyenda"><span class="ley libre">${slots.filter(o=>o.libre).length} libres</span><span class="ley lleno">${slots.filter(o=>o.estado==="ocupado").length} ocupados</span></span>`:""}</h3>
        ${ausHoy ? `<p class="note aviso-aus">${esc(x.nombre)} estará ausente${ausHoy.motivo?` (${esc(ausHoy.motivo)})`:""} del ${esc(fechaCorta(ausHoy.desde))} al ${esc(fechaCorta(ausHoy.hasta))}.</p>` : slots.length ? `<div class="slots">${slots.map(o=>`<button type="button" class="slot ${o.estado}" data-aghora="${o.hora}" aria-pressed="${o.hora===S.ag.hora}" ${o.libre?"":"disabled"}><b class="num">${h12(o.hora)}</b><small>${o.estado==="libre"?"Disponible":o.estado==="ocupado"?"Ocupado":o.estado==="bloqueado"?"No disponible":"Ya pasó"}</small></button>`).join("")}</div>
          ${bloqueosDia.length?`<p class="note bloq-nota">El médico no está disponible ${bloqueosDia.map(bq=>`de ${esc(h12(bq.desde))} a ${esc(h12(bq.hasta))}${bq.motivo?` (${esc(bq.motivo)})`:""}`).join(", ")}.</p>`:""}
          <div class="hora-exacta">
            <label class="field" for="agHoraExacta"><span>¿Otra hora? Escríbela</span><input class="input" id="agHoraExacta" type="time" step="300" value="${horaExacta?esc(S.ag.hora):""}"></label>
            <button type="button" class="btn" id="agUsarHora">Usar esta hora</button>
            <span class="hora-elegida" id="agHoraInfo" role="status">${S.ag.hora?`Hora elegida: <b class="num">${esc(h12(S.ag.hora))}</b> · termina ${esc(h12(hhmm(minutos(S.ag.hora)+Number(x.horario?.duracion||30))))}`:""}</span>
          </div>` : `<p class="note">${esc(x.nombre)} no atiende este día.</p>`}</div>
      <div class="step"><h3><i>4</i>Paciente</h3>
        <div class="grid2">
          <label class="field" for="pNombre"><span>Nombre completo</span><input class="input" id="pNombre" maxlength="90" autocomplete="off" placeholder="Nombre y apellidos"></label>
          <label class="field" for="pTel"><span>Teléfono</span><input class="input" id="pTel" maxlength="20" inputmode="tel" autocomplete="off" placeholder="10 dígitos"></label>
          <label class="field" for="pEdad"><span>Edad</span><input class="input" id="pEdad" type="number" min="0" max="120" placeholder="Años"></label>
          <label class="field" for="pMotivo"><span>Motivo de consulta</span><input class="input" id="pMotivo" maxlength="90" autocomplete="off" placeholder="Ej. revisión general"></label>
        </div>
        <label class="field" for="pNotas"><span>Notas y observaciones para el médico</span><textarea class="input" id="pNotas" maxlength="600" placeholder="Alergias, estudios que trae, indicaciones de llegada…"></textarea></label>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:10px;align-items:center;flex-wrap:wrap"><span class="note" id="agMsg" role="status"></span><button type="submit" class="btn btn-primary">Agendar y generar ticket</button></div>
    </form>
    <aside class="panel">
      <div class="panel-h"><h2>Ficha del médico</h2>${(()=>{const e=estadoSuscripcion(x);return `<span class="chip ${e.cls}">${esc(e.txt)}</span>`;})()}</div>
      <div class="panel-b" style="display:flex;flex-direction:column;gap:14px">
        <div class="doc-top">${avatarDe(x)}<div><b>${esc(x.nombre)}</b><small>${esc(x.especialidad)}</small></div><button type="button" class="btn btn-sm" data-ver-perfil="${esc(x.id)}" style="margin-left:auto">Perfil</button></div>
        ${x.descripcion?`<p class="note" style="margin:0;color:var(--ink-2)">${esc(x.descripcion.slice(0,180))}${x.descripcion.length>180?"…":""}</p>`:""}
        <dl class="kv"><dt>Consultorio</dt><dd>${esc(x.consultorio)}</dd><dt>Dirección</dt><dd>${esc(x.direccion||"—")}</dd><dt>Teléfono</dt><dd class="num">${esc(x.telefono||"—")}</dd><dt>Horario</dt><dd>${esc(textoHorario(x))}</dd><dt>Consulta</dt><dd>${x.costoConsulta?dinero(x.costoConsulta):"—"}</dd></dl>
        ${avisoPlan(x)}
        <div><div class="note" style="margin-bottom:6px">Ocupación del día seleccionado</div>${barraOcupacion(x,S.ag.fecha)}</div>
        <div><div class="note" style="margin-bottom:8px">Próximos días de consulta</div><div class="semana">${dias.filter(f=>horarios(x,f).length).slice(0,6).map(f=>{ const hs=horarios(x,f), lib=hs.filter(h=>h.libre).length; return `<button type="button" class="sem ${lib?"libre":"lleno"}" data-agfecha="${f}" ${lib?"":"disabled"}><span>${esc(fechaCorta(f))}</span><span class="num">${lib} / ${hs.length} libres</span></button>`; }).join("") || '<p class="note">Sin días de consulta registrados.</p>'}</div></div>
      </div>
    </aside>
  </div>`;
}
function celdaDia(x, f, clase){
  const fd=fromYmd(f), hs=horarios(x,f), libres=hs.filter(h=>h.libre).length, aus=enAusencia(x,f);
  const est = aus ? "aus" : !hs.length ? "no" : libres ? "libre" : "lleno";
  const sel = f===S.ag.fecha;
  const txt = aus ? "Ausente" : !hs.length ? "—" : libres ? `${libres} libres` : "Lleno";
  return `<button type="button" class="${clase} ${est}${sel?" sel":""}" data-agfecha="${f}" aria-pressed="${sel}" ${libres?"":"disabled"} aria-label="${esc(fechaLarga(f))}: ${esc(txt)}"><small>${DIAS[fd.getDay()]}</small><b class="num">${fd.getDate()}</b>${clase==="dia"?`<small>${esc(fd.toLocaleDateString("es-MX",{month:"short"}))}</small>`:""}<em class="num">${esc(txt)}</em></button>`;
}
function calendarioMes(x){
  const base = fromYmd(S.ag.mes || hoy().slice(0,7)+"-01"); base.setDate(1);
  const y=base.getFullYear(), m=base.getMonth();
  const ini = new Date(y,m,1), offset = (ini.getDay()+6)%7;          // semana inicia en lunes
  const total = new Date(y,m+1,0).getDate(), limite = addDays(hoy(), (S.ag.alcance||60)-1);
  const mesAct = ymd(new Date()).slice(0,7), esteMes = `${y}-${pad(m+1)}`;
  const celdas = [];
  for(let i=0;i<offset;i++) celdas.push(`<span class="mcel vacia"></span>`);
  for(let dd=1; dd<=total; dd++){
    const f = `${y}-${pad(m+1)}-${pad(dd)}`;
    if(f<hoy() || f>limite) celdas.push(`<span class="mcel fuera"><b class="num">${dd}</b></span>`);
    else celdas.push(celdaDia(x,f,"mcel"));
  }
  const ant = esteMes>mesAct, sig = `${y}-${pad(m+1)}-01` < limite.slice(0,7)+"-01";
  return `<div class="mes">
    <div class="mes-cab"><button type="button" class="x" data-agmes="-1" ${ant?"":"disabled"} aria-label="Mes anterior">‹</button><b>${esc(base.toLocaleDateString("es-MX",{month:"long",year:"numeric"}))}</b><button type="button" class="x" data-agmes="1" ${sig?"":"disabled"} aria-label="Mes siguiente">›</button></div>
    <div class="mes-sem">${["Lun","Mar","Mié","Jue","Vie","Sáb","Dom"].map(n=>`<span>${n}</span>`).join("")}</div>
    <div class="mes-grid">${celdas.join("")}</div></div>`;
}
function barraOcupacion(x,f){ const s=horarios(x,f), oc=s.filter(h=>!h.libre).length; const p=s.length?Math.round(oc/s.length*100):0; return `<div style="height:8px;border-radius:99px;background:var(--surface-2);border:1px solid var(--line);overflow:hidden"><div style="height:100%;width:${p}%;background:var(--accent)"></div></div><div class="note num" style="margin-top:4px">${oc} de ${s.length} espacios ocupados o pasados</div>`; }

function vistaCitas(){
  const f = S.filtro, t = hoy(), q = f.q.trim().toLowerCase();
  let l = d().citas.slice();
  if(f.estado==="proximas") l = l.filter(c=>c.estado==="confirmada" && c.fecha>=t);
  else if(f.estado==="pasadas") l = l.filter(c=>c.estado!=="cancelada" && (c.fecha<t || c.estado==="atendida"));
  else if(f.estado==="canceladas") l = l.filter(c=>c.estado==="cancelada");
  if(f.doctor) l = l.filter(c=>c.doctorId===f.doctor);
  if(q) l = l.filter(c=>[c.folio,c.paciente?.nombre,c.paciente?.telefono,docById(c.doctorId)?.nombre].join(" ").toLowerCase().includes(q));
  l.sort((a,b)=> f.estado==="proximas" ? (a.fecha+a.hora).localeCompare(b.fecha+b.hora) : (b.fecha+b.hora).localeCompare(a.fecha+a.hora));
  return `
  <div class="head"><div><div class="eyebrow">Tickets</div><h1>Citas y tickets</h1><p>Abre una cita para ver su ticket, descargarlo, reagendarla o cambiar su estado.</p></div>
    <button type="button" class="btn btn-primary" data-v="agendar">${ICON.mas}Agendar cita</button></div>
  <div class="bar">
    <input class="input" id="fq" type="search" maxlength="60" placeholder="Buscar paciente, folio, teléfono o médico" value="${esc(f.q)}" aria-label="Buscar">
    <select class="input" id="fdoc" style="flex:0 1 220px" aria-label="Médico"><option value="">Todos los médicos</option>${d().doctores.map(x=>`<option value="${esc(x.id)}" data-color="${esc(x.color)}" ${f.doctor===x.id?"selected":""}>${esc(x.nombre)}</option>`).join("")}</select>
    <div class="seg" role="group" aria-label="Estado">${[["proximas","Próximas"],["pasadas","Pasadas"],["canceladas","Canceladas"],["todas","Todas"]].map(([k,tt])=>`<button type="button" data-fest="${k}" aria-pressed="${f.estado===k}">${tt}</button>`).join("")}</div>
  </div>
  ${l.length ? `<div class="cita-cards">${l.map(tarjetaCita).join("")}</div>` : `<div class="panel empty"><b>No hay citas con estos filtros</b>Cambia el estado o la búsqueda.</div>`}`;
}

function vistaMedicos(){
  const ds = d().doctores;
  return `
  <div class="head"><div><div class="eyebrow">Suscriptores</div><h1>Médicos</h1><p>Cada médico con su mensualidad, contacto, horario y cuenta de acceso.</p></div>
    <button type="button" class="btn btn-primary" data-nuevo-doc>${ICON.mas}Nuevo suscriptor</button></div>
  ${ds.length ? `<div class="docs">${ds.map(x=>{ const e=estadoSuscripcion(x); const u=d().usuarios.find(o=>o.doctorId===x.id); const n=d().citas.filter(c=>c.doctorId===x.id && c.estado==="confirmada" && c.fecha>=hoy()).length; return `
    <article class="panel doc" style="--c:${esc(x.color)}">
      <div class="doc-top">${avatarDe(x)}<div style="min-width:0"><b>${esc(x.nombre)}</b><small>${esc(x.especialidad)}${x.cedula?` · Céd. ${esc(x.cedula)}`:""}</small></div></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap"><span class="chip ${e.cls}">${esc(e.txt)}</span>${u?`<span class="chip ${u.activo?"ok":"bad"}">@${esc(u.usuario)}${u.activo?"":" · desactivado"}</span>`:'<span class="chip neu">Sin cuenta</span>'}${x.ejemplo?'<span class="chip ex">Prueba</span>':""}</div>
      <div class="plan">${insigniaPlan(planDe(x).id)}<span>Plan ${esc(planDe(x).nombre)}</span><b class="num">${planDe(x).prueba?"Gratis":dinero(x.cuota)}${planDe(x).prueba?"":'<small style="font-size:12px;color:var(--ink-3)">/mes</small>'}</b></div>
      <dl class="kv"><dt>Teléfono</dt><dd class="num">${esc(x.telefono||"—")}</dd><dt>Consultorio</dt><dd>${esc(x.consultorio)}${x.direccion?`, ${esc(x.direccion)}`:""}</dd><dt>Horario</dt><dd>${esc(textoHorario(x))}</dd><dt>Próx. pago</dt><dd>${x.proximoPago?esc(fechaCorta(x.proximoPago)):"—"}</dd><dt>Citas próximas</dt><dd class="num">${n}</dd></dl>
      <div class="doc-foot"><button type="button" class="btn btn-sm btn-primary" data-ver-perfil="${esc(x.id)}">Ver perfil</button><button type="button" class="btn btn-sm" data-edit-doc="${esc(x.id)}">Editar</button><button type="button" class="btn btn-sm" data-pago="${esc(x.id)}">Registrar pago</button><button type="button" class="btn btn-sm" data-pausa="${esc(x.id)}">${x.estado==="pausada"?"Reactivar":"Pausar"}</button></div>
    </article>`; }).join("")}</div>` : `<div class="panel empty"><b>Aún no tienes suscriptores</b>Registra a tu primer médico para empezar a agendar sus citas.<div style="margin-top:12px"><button type="button" class="btn btn-primary" data-nuevo-doc>${ICON.mas}Nuevo suscriptor</button></div></div>`}`;
}

function vistaVerificar(){
  return `
  <div class="head"><div><h1>Verificar ticket</h1><p>Escanea el código QR con la cámara o escribe el folio para confirmar que el ticket es auténtico y no fue alterado.</p></div></div>
  <section class="panel panel-b verif" style="max-width:760px">
    <div class="scan" id="scan" hidden>
      <video id="scanVideo" playsinline muted aria-label="Vista de la cámara"></video>
      <div class="scan-marco" aria-hidden="true"></div>
      <p class="scan-txt" id="scanTxt" role="status">Apunta la cámara al código QR del ticket</p>
    </div>
    <div class="verif-acciones">
      <button type="button" class="btn btn-primary" id="scanGo">${ICON.camara}Escanear código QR</button>
      <button type="button" class="btn" id="scanStop" hidden>Detener cámara</button>
    </div>
    <div class="verif-o"><span>o escríbelo manualmente</span></div>
    <label class="field" for="vq"><span>Folio o texto del código</span><input class="input mono" id="vq" maxlength="600" autocomplete="off" autocapitalize="characters" placeholder="EC-2610-XXXXX"></label>
    <div><button type="button" class="btn" id="vgo">Verificar</button></div>
    <div id="vres" role="status"></div>
    <p class="note" style="margin:0">Cada ticket lleva una firma HMAC-SHA256 hecha con una clave secreta de la recepción: si alguien cambia el nombre, la fecha o la hora, la firma deja de coincidir.</p>
  </section>`;
}

/* ----- escáner de QR con la cámara (tablet o celular) ----- */
const Escaner = (() => {
  let stream = null, timer = null, detector = null, lienzo = null;
  async function iniciar(){
    const video=$("#scanVideo"), txt=$("#scanTxt");
    if(!navigator.mediaDevices?.getUserMedia){ toast("Este navegador no permite usar la cámara. Escribe el folio."); return; }
    try{
      stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:{ideal:"environment"}, width:{ideal:1280}, height:{ideal:720} }, audio:false });
    }catch(e){
      toast(e?.name==="NotAllowedError" ? "Permiso de cámara denegado. Actívalo en el navegador o escribe el folio." : "No se encontró una cámara disponible.");
      return;
    }
    $("#scan").hidden=false; $("#scanGo").hidden=true; $("#scanStop").hidden=false;
    video.srcObject = stream; await video.play().catch(()=>{});
    if("BarcodeDetector" in window){ try{ const f = await BarcodeDetector.getSupportedFormats(); if(f.includes("qr_code")) detector = new BarcodeDetector({formats:["qr_code"]}); }catch(e){ detector=null; } }
    lienzo = lienzo || document.createElement("canvas");
    const ctx = lienzo.getContext("2d", {willReadFrequently:true});
    const ciclo = async () => {
      if(!stream) return;
      if(video.readyState >= 2){
        let texto = null;
        try{
          if(detector){ const r = await detector.detect(video); texto = r[0]?.rawValue || null; }
          else if(window.jsQR){
            const w = Math.min(video.videoWidth, 720), h = Math.round(video.videoHeight * (w/video.videoWidth));
            lienzo.width=w; lienzo.height=h; ctx.drawImage(video,0,0,w,h);
            const img = ctx.getImageData(0,0,w,h); texto = jsQR(img.data, w, h, {inversionAttempts:"dontInvert"})?.data || null;
          }
        }catch(e){}
        if(texto){
          detener();
          if(navigator.vibrate) navigator.vibrate(60);
          $("#vq").value = limpiar(texto,600);
          txt.textContent = "Código leído";
          return verificar();
        }
      }
      timer = setTimeout(ciclo, 180);
    };
    ciclo();
  }
  function detener(){
    clearTimeout(timer); timer=null;
    if(stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
    const v=$("#scanVideo"); if(v) v.srcObject=null;
    if($("#scan")){ $("#scan").hidden=true; $("#scanGo").hidden=false; $("#scanStop").hidden=true; }
  }
  return { iniciar, detener };
})();
document.addEventListener("visibilitychange",()=>{ if(document.hidden) Escaner.detener(); });

/* ================= planes ================= */
function avisoPlan(doc){
  const p=planDe(doc), L=p.limites||{}, no=puede(doc,"agendar");
  const uso = p.prueba ? citasDePrueba(doc) : citasDelMes(doc.id, S.ag.fecha||hoy());
  const tope = L.citasMes||0;
  return `<div class="uso ${no?"agotado":""}"><div class="uso-top"><b>Plan ${esc(p.nombre)}</b><span class="num">${tope?`${uso} / ${tope} citas${p.prueba?"":" este mes"}`:`${uso} citas este mes · ilimitadas`}</span></div>
    ${tope?`<div class="uso-barra"><i style="transform:scaleX(${Math.min(1,uso/tope)})"></i></div>`:""}
    ${no?`<p>${esc(no)}</p>`:p.prueba?`<p>${esc(estadoSuscripcion(doc).txt)}. Sin descargas ni reagendar.</p>`:""}</div>`;
}
function tarjetaPlan(p, opciones={}){
  const { actual=false, accion="" } = opciones;
  return `<article class="plancard ${p.destacado?"destacado":""} ${actual?"actual":""} ${p.activo?"":"inactivo"}">
    <header>
      <div class="plancard-tit">${insigniaPlan(p.id)}<h3>${esc(p.nombre)}</h3>${p.destacado?'<span class="sello">Recomendado</span>':""}${actual?'<span class="sello actual">Tu plan actual</span>':""}${p.activo?"":'<span class="sello off">Oculto</span>'}</div>
      <p>${esc(p.lema||"")}</p>
      <div class="precio"><b class="num">${p.precio?dinero(p.precio):"Gratis"}</b><span>${p.prueba?`por ${p.dias||7} días`:"al mes"}</span></div>
    </header>
    <ul class="incluye">${(p.incluye||[]).map(t=>`<li>${esc(t)}</li>`).join("")}${(p.excluye||[]).map(t=>`<li class="no">${esc(t)}</li>`).join("")}</ul>
    ${accion}
  </article>`;
}
function vistaPlanesAdmin(){
  const pend = d().solicitudes.filter(o=>o.estado==="pendiente");
  const porPlan = id => d().doctores.filter(x=>x.plan===id).length;
  const ingreso = d().doctores.filter(x=>x.estado!=="pausada").reduce((s,x)=>s+Number(x.cuota||0),0);
  const pruebas = d().doctores.filter(x=>planDe(x).prueba);
  return `
  <div class="head"><div><h1>Planes</h1><p>Lo que ofreces a cada médico. Lo que cambies aquí es lo que ven los médicos en "Mi plan".</p></div>
    <button type="button" class="btn btn-primary" data-plan-nuevo>${ICON.mas}Nuevo plan</button></div>
  ${pend.length?`<section class="panel"><div class="panel-h"><h2>Solicitudes de cambio de plan</h2><span class="chip warn">${pend.length} pendiente${pend.length>1?"s":""}</span></div><div class="rows">${pend.map(o=>{ const x=docById(o.doctorId); return `<div class="row" style="cursor:default;grid-template-columns:40px minmax(0,1fr) auto"><span class="avatar" style="--c:${esc(x?.color||"#888")};width:36px;height:36px;font-size:13px">${esc(iniciales(x?.nombre))}</span><span class="who"><b>${esc(x?.nombre||"Médico eliminado")}</b><small>${esc(planPorId(o.de).nombre)} → <b style="display:inline">${esc(planPorId(o.a).nombre)}</b> · ${dinero(planPorId(o.a).precio)}/mes · ${esc(fechaHora(o.fecha))}${o.nota?" · “"+esc(o.nota)+"”":""}</small></span><span style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end"><button type="button" class="btn btn-sm" data-sol-no="${esc(o.id)}">Rechazar</button><button type="button" class="btn btn-sm btn-primary" data-sol-si="${esc(o.id)}">Aprobar</button></span></div>`; }).join("")}</div></section>`:""}
  <div class="kpis">
    <div class="panel kpi"><span>Ingreso mensual</span><b class="num">${dinero(ingreso)}</b><small>suscripciones activas</small></div>
    <div class="panel kpi"><span>En prueba gratis</span><b class="num">${pruebas.length}</b><small>${pruebas.filter(x=>(diasDePrueba(x)??1)<=2).length} terminan en 2 días o menos</small></div>
    <div class="panel kpi"><span>Plan más contratado</span><b style="font-size:22px">${esc((planes().filter(p=>!p.prueba).sort((a,b)=>porPlan(b.id)-porPlan(a.id))[0]||{}).nombre||"—")}</b><small>por número de médicos</small></div>
    <div class="panel kpi"><span>Solicitudes</span><b class="num">${pend.length}</b><small>cambios por aprobar</small></div>
  </div>
  ${seccionBanco(true)}
  <div class="planes">${planes().map(p=>tarjetaPlan(p,{accion:`<footer class="plancard-pie"><span class="note">${porPlan(p.id)} médico${porPlan(p.id)===1?"":"s"}</span><button type="button" class="btn btn-sm" data-plan-edit="${esc(p.id)}">Editar</button></footer>`})).join("")}</div>`;
}
function vistaPlanesMedico(me){
  const actual = planDe(me), pend = d().solicitudes.find(o=>o.doctorId===me.id && o.estado==="pendiente");
  const ultima = d().solicitudes.filter(o=>o.doctorId===me.id && o.estado!=="pendiente").sort((a,b)=>b.resuelta?.localeCompare(a.resuelta||"")||0)[0];
  const L = actual.limites||{}; const uso = actual.prueba ? citasDePrueba(me) : citasDelMes(me.id);
  return `
  <div class="head"><div><h1>Mi plan</h1><p>Tu plan actual, lo que incluye y los demás planes disponibles.</p></div></div>
  <section class="panel panel-b miplan">
    <div class="miplan-izq">
      <span class="chip ${estadoSuscripcion(me).cls}">${esc(estadoSuscripcion(me).txt)}</span>
      <div class="miplan-tit">${insigniaPlan(actual.id,"grande")}<h2>${esc(actual.nombre)}</h2></div>
      <p>${esc(actual.lema||"")}</p>
    </div>
    <div class="miplan-der">
      <div class="uso"><div class="uso-top"><b>Citas ${actual.prueba?"de la prueba":"de este mes"}</b><span class="num">${L.citasMes?`${uso} de ${L.citasMes}`:`${uso} · sin límite`}</span></div>${L.citasMes?`<div class="uso-barra"><i style="transform:scaleX(${Math.min(1,uso/L.citasMes)})"></i></div>`:""}</div>
      <dl class="kv">${actual.prueba?`<dt>Termina</dt><dd>${me.pruebaHasta?esc(fechaLarga(me.pruebaHasta)):"—"}</dd>`:`<dt>Mensualidad</dt><dd>${dinero(me.cuota)}</dd><dt>Próximo pago</dt><dd>${me.proximoPago?esc(fechaLarga(me.proximoPago)):"—"}</dd>`}</dl>
    </div>
  </section>
  ${pend?`<div class="banner">Solicitaste cambiar a <b>${esc(planPorId(pend.a).nombre)}</b> el ${esc(fechaHora(pend.fecha))}; tu recepción la revisará y te avisará. <button type="button" class="btn btn-sm" data-sol-cancelar="${esc(pend.id)}" style="margin-left:8px">Cancelar solicitud</button></div>`
        :ultima && ultima.estado==="rechazada" && (Date.now()-new Date(ultima.resuelta))<7*864e5?`<div class="banner">Tu solicitud de cambio a <b>${esc(planPorId(ultima.a).nombre)}</b> no se aprobó. Comunícate con tu recepción para más detalles.</div>`:""}
  ${seccionBanco(false, me)}
  <div class="planes">${planes().filter(p=>p.activo || p.id===actual.id).filter(p=>!p.prueba || p.id===actual.id).map(p=>{
    const esActual = p.id===actual.id;
    const accion = esActual ? `<footer class="plancard-pie"><span class="note">Es tu plan actual</span></footer>`
      : `<footer class="plancard-pie"><button type="button" class="btn ${p.destacado?"btn-primary":""}" data-sol-plan="${esc(p.id)}" ${pend?"disabled":""}>${p.precio>(actual.precio||0)?"Mejorar a ":"Cambiar a "}${esc(p.nombre)}</button></footer>`;
    return tarjetaPlan(p,{actual:esActual, accion});
  }).join("")}</div>
  <p class="note">Los cambios de plan los confirma tu recepción. Al mejorar tu plan, los beneficios se activan en cuanto se apruebe; al bajar de plan, el cambio aplica desde el siguiente periodo.</p>`;
}
function solicitarPlan(planId){
  const me=miDoctor(); const p=planPorId(planId); if(!me||!p) return;
  if(d().solicitudes.some(o=>o.doctorId===me.id && o.estado==="pendiente")) return toast("Ya tienes una solicitud pendiente.");
  capa(`<form class="modal" id="fSol" role="dialog" aria-modal="true" aria-labelledby="solT" style="width:min(520px,100%)"><div class="modal-h"><h2 id="solT">Cambiar a ${esc(p.nombre)}</h2><button type="button" class="x" data-cerrar aria-label="Cerrar">${ICON.cerrar}</button></div>
    <div class="modal-b"><div class="plan"><span>${esc(planDe(me).nombre)} → <b>${esc(p.nombre)}</b></span><b class="num">${dinero(p.precio)}<small style="font-size:12px;color:var(--ink-3)">/mes</small></b></div>
      <label class="field" for="solNota"><span>Mensaje para tu recepción (opcional)</span><textarea class="input" id="solNota" maxlength="240" placeholder="Por ejemplo: quiero empezar desde el próximo lunes"></textarea></label></div>
    <div class="modal-f"><button type="button" class="btn" data-cerrar>Cancelar</button><button type="submit" class="btn btn-primary">Enviar solicitud</button></div></form>`);
  $("#fSol").addEventListener("submit",ev=>{ ev.preventDefault(); intentar(()=>{
    exigir("medico", me.id);
    d().solicitudes.unshift({ id:"sol-"+randHex(6), doctorId:me.id, de:me.plan, a:p.id, nota:limpiarTexto($("#solNota").value,240), estado:"pendiente", fecha:new Date().toISOString() });
    bitacora("Solicitud de cambio de plan", `${me.nombre}: ${planDe(me).nombre} → ${p.nombre}`); Store.guardar(); cerrarCapa(); render(); toast("Solicitud enviada a tu recepción");
  }); });
}
function resolverSolicitud(id, aprobar){ intentar(()=>{
  exigir("admin"); const o=d().solicitudes.find(x=>x.id===id); if(!o) return; const doc=docById(o.doctorId); const p=planPorId(o.a);
  o.estado = aprobar ? "aprobada" : "rechazada"; o.resuelta = new Date().toISOString(); o.por = S.usuario.usuario;
  if(aprobar && doc){
    const venia = planDe(doc);
    doc.plan = p.id; doc.cuota = p.precio;
    if(p.prueba){ doc.pruebaInicio=new Date().toISOString(); doc.pruebaHasta=addDays(hoy(),p.dias||7); doc.proximoPago=null; }
    else { delete doc.pruebaHasta; if(venia.prueba || !doc.proximoPago) doc.proximoPago = addMonths(hoy(),1); }
    if(doc.estado==="pausada") doc.estado="activa";
  }
  bitacora(aprobar?"Cambio de plan aprobado":"Cambio de plan rechazado", `${doc?.nombre||""}: → ${p.nombre}`); Store.guardar(); render(); toast(aprobar?`${doc?.nombre} ahora tiene el plan ${p.nombre}`:"Solicitud rechazada");
}); }
function formPlan(p){
  try{ exigir("admin"); }catch(e){ return toast(e.message); }
  const e = p || { id:"", nombre:"", precio:0, orden:planes().length, activo:true, destacado:false, lema:"", limites:{citasMes:0,descargas:true,reagendar:true,recordatorios:false,reportes:false}, incluye:[], excluye:[] };
  const L = e.limites||{};
  const chk = (id, txt, on) => `<label class="opc"><input type="checkbox" id="${id}" ${on?"checked":""}><span>${txt}</span></label>`;
  capa(`<form class="modal" id="fPlan" role="dialog" aria-modal="true" aria-labelledby="plT" novalidate>
    <div class="modal-h"><h2 id="plT">${p?"Editar plan":"Nuevo plan"}</h2><button type="button" class="x" data-cerrar aria-label="Cerrar">${ICON.cerrar}</button></div>
    <div class="modal-b">
      <div class="grid2">
        <label class="field" for="plNom"><span>Nombre</span><input class="input" id="plNom" maxlength="40" value="${esc(e.nombre)}" placeholder="Profesional"></label>
        <label class="field" for="plPre"><span>${e.prueba?"Duración (días)":"Precio mensual (MXN)"}</span><input class="input" id="plPre" type="number" min="0" max="100000" value="${esc(e.prueba?(e.dias||7):e.precio)}"></label>
      </div>
      <label class="field" for="plLema"><span>Frase corta</span><input class="input" id="plLema" maxlength="110" value="${esc(e.lema||"")}" placeholder="Para quién es este plan, en una línea"></label>
      <label class="field" for="plCit"><span>Citas incluidas ${e.prueba?"durante la prueba":"al mes"} (0 = ilimitadas)</span><input class="input" id="plCit" type="number" min="0" max="10000" value="${esc(L.citasMes||0)}"></label>
      <div class="opciones">${chk("plDesc","Descargar tickets en PDF e imagen",L.descargas!==false)}${chk("plReag","Reagendar citas",L.reagendar!==false)}${chk("plRec","Recordatorios a pacientes",!!L.recordatorios)}${chk("plRep","Reporte mensual",!!L.reportes)}${chk("plDest","Marcar como recomendado",!!e.destacado)}${chk("plAct","Visible para los médicos",e.activo!==false)}</div>
      <div class="grid2">
        <label class="field" for="plInc"><span>Incluye (uno por renglón)</span><textarea class="input" id="plInc" maxlength="1200" style="min-height:130px">${esc((e.incluye||[]).join("\n"))}</textarea></label>
        <label class="field" for="plExc"><span>No incluye (uno por renglón)</span><textarea class="input" id="plExc" maxlength="1200" style="min-height:130px">${esc((e.excluye||[]).join("\n"))}</textarea></label>
      </div>
    </div>
    <div class="modal-f">${p && !p.prueba && !d().doctores.some(x=>x.plan===p.id)?`<button type="button" class="btn btn-danger" id="plDel" style="margin-right:auto">Eliminar plan</button>`:""}<span class="note" id="plMsg" role="status" style="align-self:center"></span><button type="button" class="btn" data-cerrar>Cancelar</button><button type="submit" class="btn btn-primary">${p?"Guardar plan":"Crear plan"}</button></div>
  </form>`);
  $("#plDel")?.addEventListener("click",()=>confirmar("Eliminar plan",`Se eliminará el plan ${p.nombre}. Ningún médico lo tiene contratado.`,()=>intentar(()=>{ exigir("admin"); d().planes=d().planes.filter(x=>x.id!==p.id); bitacora("Plan eliminado", p.nombre); Store.guardar(); render(); toast("Plan eliminado"); }),true));
  $("#fPlan").addEventListener("submit",ev=>{ ev.preventDefault(); const msg=$("#plMsg"); intentar(()=>{
    exigir("admin");
    const nombre=limpiar($("#plNom").value,40); if(nombre.length<2){ msg.textContent="Escribe el nombre del plan."; return; }
    const lineas = id => $(id).value.split("\n").map(t=>limpiar(t,90)).filter(Boolean).slice(0,12);
    const num = Math.max(0, Math.round(Number($("#plPre").value)||0));
    const datos = { nombre, lema:limpiar($("#plLema").value,110), destacado:$("#plDest").checked, activo:$("#plAct").checked,
      limites:{ citasMes:Math.max(0,Math.round(Number($("#plCit").value)||0)), descargas:$("#plDesc").checked, reagendar:$("#plReag").checked, recordatorios:$("#plRec").checked, reportes:$("#plRep").checked },
      incluye:lineas("#plInc"), excluye:lineas("#plExc") };
    if(e.prueba){ datos.dias = Math.min(60, Math.max(1, num)); datos.precio = 0; } else datos.precio = num;
    if(datos.destacado) d().planes.forEach(x=>{ if(x.id!==e.id) x.destacado=false; });
    if(p){ Object.assign(p, datos); bitacora("Plan actualizado", p.nombre); }
    else { const id = nombre.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"") || "plan"; d().planes.push({ id: d().planes.some(x=>x.id===id)? id+"-"+randHex(2) : id, orden:planes().length, ...datos }); bitacora("Plan creado", nombre); }
    Store.guardar(); cerrarCapa(); render(); toast(p?"Plan guardado":"Plan creado");
  }); });
}

function vistaBitacora(){
  const l = d().bitacora.slice(0,200);
  return `
  <div class="head"><div><div class="eyebrow">Seguridad</div><h1>Bitácora</h1><p>Accesos, intentos fallidos y cambios hechos en la recepción (últimos 200).</p></div>
</div>
  <section class="panel log"><div class="rows">${l.length ? l.map(r=>`<div class="row"><span class="note num">${esc(fechaHora(r.fecha))}</span><span class="who"><b>${esc(r.accion)}</b><small>@${esc(r.usuario)}${r.detalle?" · "+esc(r.detalle):""}</small></span>${/fallido|bloque/i.test(r.accion+r.detalle)?'<span class="chip bad">Alerta</span>':'<span></span>'}</div>`).join("") : `<div class="empty"><b>Sin movimientos</b></div>`}</div></section>`;
}

function vistaMedico(me){
  const t = hoy();
  const mias = d().citas.filter(c=>c.doctorId===me.id && c.estado!=="cancelada");
  const prox = mias.filter(c=>c.fecha>=t && c.estado==="confirmada").sort((a,b)=>(a.fecha+a.hora).localeCompare(b.fecha+b.hora));
  const grupos = {}; prox.forEach(c=>(grupos[c.fecha] ||= []).push(c));
  const deHoy = mias.filter(c=>c.fecha===t);
  return `
  <div class="head"><div><div class="eyebrow">${esc(fechaLarga(t))}</div><h1>Hola, ${esc(me.nombre)}</h1><p>Estas son las citas que tu recepción agendó para ti.</p></div><button type="button" class="btn" data-sala="${esc(me.id)}">${ICON.sala}Sala de espera</button></div>
  <div class="kpis">
    <div class="panel kpi"><span>Hoy</span><b class="num">${deHoy.length}</b><small>${deHoy.filter(c=>c.estado==="atendida").length} atendidas</small></div>
    <div class="panel kpi"><span>Esta semana</span><b class="num">${prox.filter(c=>c.fecha<=addDays(t,7)).length}</b><small>confirmadas</small></div>
    <div class="panel kpi"><span>Próxima cita</span><b class="num" style="font-size:22px">${prox[0]?esc(h12(prox[0].hora)):"—"}</b><small>${prox[0]?esc(fechaCorta(prox[0].fecha))+" · "+esc(prox[0].paciente?.nombre):"sin pendientes"}</small></div>
    <div class="panel kpi"><span>Consultorio</span><b style="font-size:16px;line-height:1.3">${esc(me.consultorio)}</b><small>${esc(me.direccion||"")}</small></div>
  </div>
  ${prox.length ? Object.entries(grupos).map(([f,l])=>`<section class="daygroup"><h3>${esc(fechaLarga(f))}</h3><div class="tix">${l.map(c=>`
    <button type="button" class="tick" data-ticket="${esc(c.id)}"><span class="tick-m"><b>${esc(c.paciente?.nombre)}</b><small>${esc(c.paciente?.motivo||"Consulta")}</small><small>${c.notas?"Nota: "+esc(c.notas):"Sin observaciones"}</small><span class="mono note">${esc(c.folio)}</span></span><span class="tick-s"><small>${esc(fechaCorta(f))}</small><b class="num">${esc(h12(c.hora))}</b></span></button>`).join("")}</div></section>`).join("") : `<div class="panel empty"><b>No tienes citas pendientes</b>Cuando tu recepción agende una cita, su ticket aparecerá aquí.</div>`}
  ${historialConsultas(me)}`;
}

/* ================= insignias ================= */
const PLAN_COLORES = {
  prueba:{ rgb:[150,150,150], txt:[255,255,255], css:"linear-gradient(135deg,#B8B8B8,#7D7D7D)", nombre:"Prueba" },
  esencial:{ rgb:[176,112,62], txt:[255,255,255], css:"linear-gradient(135deg,#D9A273,#9A5B2E)", nombre:"Bronce" },
  profesional:{ rgb:[158,166,176], txt:[20,20,20], css:"linear-gradient(135deg,#F1F3F6,#9AA3AE)", nombre:"Plata" },
  clinica:{ rgb:[212,170,60], txt:[30,20,0], css:"linear-gradient(135deg,#F7DB7A,#B8862B)", nombre:"Oro" },
};
function insigniaPlan(id, tam=""){
  const p = planPorId(id); const c = PLAN_COLORES[p?.id] || { css:"linear-gradient(135deg,#6B7280,#374151)", nombre:"Miembro" };
  return `<span class="insignia-plan ${tam}" style="--fondo:${c.css}" title="Plan ${esc(p?.nombre||"")}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 15.4 6.8 18.1l1-5.8L3.5 8.2l5.9-.9z" fill="currentColor"/></svg><span>${esc(p?.nombre||"")}</span></span>`;
}
const TONOS_CERT = ["#0B7A63","#2563EB","#9333EA","#C2410C","#0E7490","#B45309"];
/* Miniatura de la 1.ª página de los certificados en PDF (pdf.js local, se carga solo si hace falta) */
const MINIS_PDF = new Map();
let pdfjsListo = null;
function cargarPdfjs(){
  if(pdfjsListo) return pdfjsListo;
  pdfjsListo = new Promise((ok,mal)=>{ const sc=document.createElement("script"); sc.src="assets/vendor/pdf.min.js"; sc.onload=()=>{ window.pdfjsLib.GlobalWorkerOptions.workerSrc="assets/vendor/pdf.worker.min.js"; ok(window.pdfjsLib); }; sc.onerror=mal; document.head.appendChild(sc); });
  return pdfjsListo;
}
async function miniaturasPdf(x){
  const pend = [...document.querySelectorAll("[data-pdf-cert]")];
  if(!pend.length) return;
  try{
    const lib = await cargarPdfjs();
    for(const el of pend){
      const c = (x.certificados||[]).find(o=>o.id===el.dataset.pdfCert); if(!c?.data) continue;
      const bin = atob(c.data.split(",")[1]||""); const bytes = new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
      const doc = await lib.getDocument({data:bytes, isEvalSupported:false}).promise;
      const pag = await doc.getPage(1); const vp0 = pag.getViewport({scale:1}); const vp = pag.getViewport({scale:240/Math.min(vp0.width,vp0.height)});
      const cv = document.createElement("canvas"); cv.width=vp.width; cv.height=vp.height;
      await pag.render({canvasContext:cv.getContext("2d"), viewport:vp}).promise;
      const url = cv.toDataURL("image/jpeg",.85); MINIS_PDF.set(c.id, url); doc.destroy();
      if(el.isConnected){ const img=document.createElement("img"); img.src=url; img.alt=""; el.replaceWith(img); }
    }
  }catch(e){ console.warn("No se pudo generar la miniatura del PDF", e); }
}
/* Insignia del certificado: la imagen real dentro de una medalla; los PDF llevan el ícono */
function medallon(c){
  const mini = MINIS_PDF.get(c.id);
  const dentro = c.tipo==="img" && c.data ? `<img src="${esc(c.data)}" alt="" loading="lazy">`
    : mini ? `<img src="${mini}" alt="">`
    : `<span class="medallon-pdf" data-pdf-cert="${esc(c.id)}">${ICON.pdf}<small>PDF</small></span>`;
  return `<span class="medallon" aria-hidden="true"><span class="medallon-cintas"></span><span class="medallon-aro">${dentro}</span><span class="medallon-check">${ICON.verificar}</span></span>`;
}
const MEDALLA = `<span class="medalla" aria-hidden="true"><svg viewBox="0 0 48 48"><path d="M16 4h16l-3 14H19z" fill="currentColor" opacity=".55"/><circle cx="24" cy="29" r="13" fill="currentColor"/><circle cx="24" cy="29" r="9.5" fill="none" stroke="#fff" stroke-width="1.6" opacity=".7"/><path d="M19 29.5l3.4 3.4 6.6-7" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;

/* ================= citas en tarjetas (admin) ================= */
function tarjetaCita(c){
  const x = docById(c.doctorId);
  return `<button type="button" class="cita-card estado-${esc(c.estado)}" data-ticket="${esc(c.id)}">
    <span class="cc-top"><span class="cc-hora"><b class="num">${esc(h12(c.hora))}</b><small>${esc(fechaCorta(c.fecha))}</small></span>${chipEstadoCita(c.estado)}</span>
    <b class="cc-paciente">${esc(c.paciente?.nombre)}</b>
    <small class="cc-motivo">${esc(c.paciente?.motivo||"Consulta")}</small>
    <span class="cc-doc">${x?avatarDe(x):""}<span><b>${esc(x?.nombre||"—")}</b><small>${esc(x?.especialidad||"")}</small></span></span>
    <span class="cc-pie"><span class="mono">${esc(c.folio)}</span>${c.usado?'<span class="chip neu">Ticket usado</span>':""}${c.recetaPendiente?'<span class="chip ok">Receta por enviar</span>':""}</span>
  </button>`;
}

/* ================= consulta (médico) ================= */
async function abrirConsulta(id){
  const c = d().citas.find(o=>o.id===id); if(!c) return;
  try{
    if(!c.enConsulta){ const r = await Store.api("POST",`/citas/${encodeURIComponent(id)}/consulta`,{accion:"iniciar"},{texto:"Pasando a consulta…"}); Object.assign(c, r.data); await Store.cargar({silencioso:true}); }
  }catch(e){ return toast(e.message); }
  const x = docById(c.doctorId);
  capa(`<form class="modal consulta" id="fConsulta" role="dialog" aria-modal="true" aria-labelledby="csT" novalidate>
    <div class="modal-h"><div><h2 id="csT">Consulta en curso</h2><div class="note">Folio ${esc(c.folio)} · el ticket quedó marcado como usado</div></div><button type="button" class="x" data-cerrar aria-label="Cerrar">${ICON.cerrar}</button></div>
    <div class="modal-b">
      <div class="paciente-ficha">
        <div class="pf-av">${esc(iniciales(c.paciente?.nombre))}</div>
        <div><b>${esc(c.paciente?.nombre)}</b><small>${c.paciente?.edad?esc(c.paciente.edad)+" años · ":""}${esc(c.paciente?.telefono||"sin teléfono")}</small></div>
        <dl><div><dt>Fecha</dt><dd>${esc(fechaCorta(c.fecha))}</dd></div><div><dt>Hora</dt><dd>${esc(h12(c.hora))}</dd></div><div><dt>Motivo</dt><dd>${esc(c.paciente?.motivo||"Consulta")}</dd></div></dl>
      </div>
      ${c.notas?`<p class="nota-recep"><b>Nota de recepción:</b> ${esc(c.notas)}</p>`:""}
      <label class="field" for="csRes"><span>Resumen de la consulta</span><textarea class="input" id="csRes" maxlength="3000" style="min-height:150px" placeholder="Padecimiento actual, exploración, diagnóstico…">${esc(c.consulta?.resumen||"")}</textarea></label>
      <label class="field" for="csRec"><span>Receta</span><textarea class="input mono-suave" id="csRec" maxlength="3000" style="min-height:150px" placeholder="Medicamento — dosis — cada cuánto — por cuántos días">${esc(c.consulta?.receta||"")}</textarea></label>
      <p class="note" style="margin:0">Al terminar, la consulta queda en tu historial y la recepción recibe la receta para enviársela al paciente en PDF.</p>
    </div>
    <div class="modal-f"><span class="note" id="csMsg" role="status" style="margin-right:auto;align-self:center"></span><button type="button" class="btn" data-cerrar>Seguir después</button><button type="submit" class="btn btn-primary">Terminar consulta</button></div>
  </form>`);
  $("#fConsulta").addEventListener("submit", async ev=>{ ev.preventDefault();
    const resumen=$("#csRes").value.trim(), receta=$("#csRec").value.trim();
    if(resumen.length<5){ $("#csMsg").textContent="Escribe el resumen de la consulta."; return; }
    try{ await Store.api("POST",`/citas/${encodeURIComponent(id)}/consulta`,{accion:"finalizar", resumen, receta},{texto:"Guardando la consulta…"}); await Store.cargar({silencioso:true}); cerrarCapa(); render(); toast("Consulta guardada; la recepción enviará la receta"); }
    catch(e){ $("#csMsg").textContent=e.message; }
  });
}
function verConsulta(id){
  const c = d().citas.find(o=>o.id===id); if(!c?.consulta) return;
  const x = docById(c.doctorId);
  capa(`<div class="modal flotante" role="dialog" aria-modal="true" aria-labelledby="vcT"><div class="modal-h"><div><h2 id="vcT">Consulta de ${esc(c.paciente?.nombre)}</h2><div class="note">${esc(x?.nombre||"")} · ${esc(fechaHora(c.consulta.fecha))}</div></div><button type="button" class="x" data-cerrar aria-label="Cerrar">${ICON.cerrar}</button></div>
    <div class="modal-b"><h3 class="sub">Resumen</h3><p class="texto-largo">${esc(c.consulta.resumen)}</p><h3 class="sub">Receta</h3><p class="texto-largo receta">${esc(c.consulta.receta||"Sin receta")}</p></div>
    <div class="modal-f">${esAdmin()?`<button type="button" class="btn" id="vcPdf">${ICON.pdf}Receta en PDF</button>`:""}<button type="button" class="btn btn-primary" data-cerrar>Cerrar</button></div></div>`);
  $("#vcPdf")?.addEventListener("click",()=>pdfReceta(c));
}
function pdfReceta(c){
  const { jsPDF } = window.jspdf; const pdf = new jsPDF({unit:"mm", format:"letter"}); const x = docById(c.doctorId)||{};
  const W=215.9, M=20, negro=[12,12,12], gris=[105,105,105];
  pdf.setProperties({title:`Receta ${c.paciente?.nombre}`, creator:"Assistant"});
  if(MARCA_PNG) pdf.addImage(MARCA_PNG,"PNG",M,16,12,12.3);
  pdf.setTextColor(...negro); pdf.setFont("helvetica","bold"); pdf.setFontSize(16); pdf.text(x.nombre||"", M+16, 22);
  pdf.setFont("helvetica","normal"); pdf.setFontSize(9.5); pdf.setTextColor(...gris); pdf.text(`${x.especialidad||""}${x.cedula?` · Cédula profesional ${x.cedula}`:""}`, M+16, 27.5);
  pdf.text(`${x.consultorio||""}${x.direccion?` · ${x.direccion}`:""}`, M+16, 32);
  pdf.setDrawColor(12,12,12); pdf.setLineWidth(.6); pdf.line(M,38,W-M,38); pdf.setLineWidth(.2);
  pdf.setFontSize(9.5); pdf.setTextColor(...gris); pdf.text("PACIENTE", M, 47); pdf.text("FECHA", W-M-50, 47);
  pdf.setTextColor(...negro); pdf.setFont("helvetica","bold"); pdf.setFontSize(12); pdf.text(c.paciente?.nombre||"", M, 53); pdf.text(fechaCorta(c.fecha)+" "+fromYmd(c.fecha).getFullYear(), W-M-50, 53);
  pdf.setFont("helvetica","normal"); pdf.setFontSize(9.5); pdf.setTextColor(...gris); if(c.paciente?.edad) pdf.text(`${c.paciente.edad} años`, M, 58.5);
  let y=72; pdf.setFont("times","bolditalic"); pdf.setFontSize(26); pdf.setTextColor(...negro); pdf.text("Rx", M, y); y+=10;
  pdf.setFont("helvetica","normal"); pdf.setFontSize(11.5); const ls = pdf.splitTextToSize(c.consulta?.receta || "Sin receta", W-2*M); pdf.text(ls, M, y); y += ls.length*6 + 10;
  pdf.setDrawColor(200,200,200); pdf.line(W-M-70, 245, W-M, 245); pdf.setFontSize(9); pdf.setTextColor(...gris); pdf.text("Firma del médico", W-M-35, 250, {align:"center"});
  pdf.setFontSize(7.5); pdf.text(`Folio ${c.folio} · Enviado por Assistant · ${EMPRESA.telefono}`, M, 268);
  descargar(`Receta ${c.paciente?.nombre} ${c.fecha}.pdf`, pdf.output("blob"));
}
function cancelarConMotivo(c){
  capa(`<form class="modal flotante" id="fCanc" role="dialog" aria-modal="true" aria-labelledby="ccT" style="width:min(500px,100%)" novalidate><div class="modal-h"><h2 id="ccT">Cancelar cita</h2><button type="button" class="x" data-cerrar aria-label="Cerrar">${ICON.cerrar}</button></div>
    <div class="modal-b"><p style="margin:0">${esc(c.paciente?.nombre)} · ${esc(fechaCorta(c.fecha))} ${esc(h12(c.hora))}. La recepción recibirá el aviso para contactar al paciente.</p>
      <label class="field" for="ccMot"><span>Motivo de la cancelación (obligatorio)</span><textarea class="input" id="ccMot" maxlength="200" placeholder="Ejemplo: urgencia en hospital"></textarea></label></div>
    <div class="modal-f"><span class="note" id="ccMsg" role="status" style="margin-right:auto;align-self:center"></span><button type="button" class="btn" data-cerrar>Volver</button><button type="submit" class="btn btn-danger">Cancelar cita</button></div></form>`);
  $("#fCanc").addEventListener("submit", async ev=>{ ev.preventDefault(); const m=$("#ccMot").value.trim();
    if(m.length<5){ $("#ccMsg").textContent="Escribe el motivo (mínimo 5 letras)."; return; }
    c.estado="cancelada"; c.motivoCancelacion=m;
    if(await Store.guardar()){ cerrarCapa(); render(); toast("Cita cancelada; tu recepción fue avisada"); }
  });
}
function historialConsultas(me){
  const l = d().citas.filter(c=>c.doctorId===me.id && c.consulta).sort((a,b)=>(b.consulta.fecha||"").localeCompare(a.consulta.fecha||"")).slice(0,30);
  const canc = d().citas.filter(c=>c.doctorId===me.id && c.estado==="cancelada").sort((a,b)=>(b.fecha+b.hora).localeCompare(a.fecha+a.hora)).slice(0,20);
  return `<section class="panel"><div class="panel-h"><h2>Historial de consultas</h2><span class="chip neu">${l.length}</span></div>
    <div class="rows">${l.length ? l.map(c=>`<button type="button" class="row" data-ver-consulta="${esc(c.id)}"><span class="when"><b class="num">${esc(h12(c.hora))}</b><small>${esc(fechaCorta(c.fecha))}</small></span><span class="who"><b>${esc(c.paciente?.nombre)}</b><small>${esc((c.consulta.resumen||"").slice(0,90))}</small></span>${c.recetaPendiente?'<span class="chip warn">Receta por enviar</span>':'<span class="chip ok">Receta enviada</span>'}</button>`).join("") : `<div class="empty"><b>Aún no hay consultas</b>Escanea el ticket del paciente y elige "Pasar a consulta".</div>`}</div></section>
  ${canc.length?`<section class="panel"><div class="panel-h"><h2>Citas canceladas</h2><span class="chip bad">${canc.length}</span></div><div class="rows">${canc.map(c=>`<div class="row" style="cursor:default"><span class="when"><b class="num">${esc(h12(c.hora))}</b><small>${esc(fechaCorta(c.fecha))}</small></span><span class="who"><b>${esc(c.paciente?.nombre)}</b><small>${esc(c.motivoCancelacion||"Sin motivo")}</small></span><span></span></div>`).join("")}</div></section>`:""}`;
}

/* ================= datos bancarios ================= */
const cfgGeneral = () => (d().config||[]).find(o=>o.id==="general") || { id:"general", banco:{} };
function tarjetaBanco(b){
  const clabe = String(b?.clabe||"").replace(/(\d{3})(\d{3})(\d{11})(\d)/,"$1 $2 $3 $4");
  return `<div class="tarjeta-banco">
    <div class="tb-top"><b>${esc(b?.banco||"Banco")}</b><span class="tb-chip" aria-hidden="true"></span></div>
    <div class="tb-clabe"><small>CLABE interbancaria</small><b class="mono">${esc(clabe||"—")}</b></div>
    <div class="tb-fila"><div><small>Titular</small><b>${esc(b?.titular||"—")}</b></div></div>
    <div class="tb-fila"><div><small>Cuenta</small><b class="mono">${esc(b?.cuenta||"—")}</b></div><div><small>Tarjeta</small><b class="mono">${esc(b?.tarjeta||"—")}</b></div></div>
    <div class="tb-concepto">Concepto: ${esc(b?.concepto||"Mensualidad")}</div>
    <img class="tb-logo" src="assets/logo-a-blanco.png" alt="">
  </div>`;
}
function seccionBanco(editable, me){
  const b = cfgGeneral().banco||{};
  return `<section class="panel panel-b banco">
    <div class="banco-txt"><h2>${editable?"Datos bancarios para tus médicos":"Paga tu mensualidad por transferencia"}</h2>
      <p>${editable?"Los médicos ven esta tarjeta en «Mi plan» y en la ventana de acceso suspendido.":`Transfiere ${me?dinero(me.cuota||planDe(me).precio):"tu mensualidad"} y envía tu comprobante por el chat de Mensajes.`}</p>
      <div class="banco-acc"><button type="button" class="btn btn-sm" data-copiar="${esc(b.clabe||"")}">Copiar CLABE</button>${editable?`<button type="button" class="btn btn-sm" id="bancoEditar">Editar datos</button>`:`<button type="button" class="btn btn-sm" data-v="mensajes">Enviar comprobante</button>`}</div></div>
    ${tarjetaBanco(b)}
  </section>`;
}
function editarBanco(){
  const b = cfgGeneral().banco||{};
  capa(`<form class="modal flotante" id="fBanco" role="dialog" aria-modal="true" aria-labelledby="bkT" style="width:min(560px,100%)" novalidate><div class="modal-h"><h2 id="bkT">Datos bancarios</h2><button type="button" class="x" data-cerrar aria-label="Cerrar">${ICON.cerrar}</button></div>
    <div class="modal-b"><div class="grid2">
      <label class="field" for="bkBanco"><span>Banco</span><input class="input" id="bkBanco" maxlength="40" value="${esc(b.banco||"")}"></label>
      <label class="field" for="bkTit"><span>Titular</span><input class="input" id="bkTit" maxlength="80" value="${esc(b.titular||"")}"></label>
      <label class="field" for="bkClabe"><span>CLABE (18 dígitos)</span><input class="input mono" id="bkClabe" maxlength="18" inputmode="numeric" value="${esc(b.clabe||"")}"></label>
      <label class="field" for="bkCta"><span>Número de cuenta</span><input class="input mono" id="bkCta" maxlength="20" value="${esc(b.cuenta||"")}"></label>
      <label class="field" for="bkTarj"><span>Tarjeta (opcional)</span><input class="input mono" id="bkTarj" maxlength="19" value="${esc(b.tarjeta||"")}"></label>
      <label class="field" for="bkConc"><span>Concepto</span><input class="input" id="bkConc" maxlength="80" value="${esc(b.concepto||"")}"></label></div></div>
    <div class="modal-f"><span class="note" id="bkMsg" role="status" style="margin-right:auto;align-self:center"></span><button type="button" class="btn" data-cerrar>Cancelar</button><button type="submit" class="btn btn-primary">Guardar</button></div></form>`);
  $("#fBanco").addEventListener("submit", async ev=>{ ev.preventDefault();
    const clabe=$("#bkClabe").value.replace(/\D/g,""); if(clabe && clabe.length!==18){ $("#bkMsg").textContent="La CLABE debe tener 18 dígitos."; return; }
    const cfg = cfgGeneral(); if(!(d().config||[]).includes(cfg)){ d().config = [...(d().config||[]), cfg]; }
    cfg.banco = { banco:$("#bkBanco").value, titular:$("#bkTit").value, clabe, cuenta:$("#bkCta").value, tarjeta:$("#bkTarj").value, concepto:$("#bkConc").value };
    if(await Store.guardar()){ cerrarCapa(); render(); toast("Datos bancarios guardados"); }
  });
}

/* ================= ventanas especiales ================= */
function citaCreada(c){
  const x = docById(c.doctorId);
  capa(`<div class="modal flotante exito" role="dialog" aria-modal="true" aria-labelledby="okCita" style="width:min(460px,100%)">
    <div class="modal-b exito-b"><span class="exito-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>
      <h2 id="okCita">Cita agendada</h2><p>${esc(c.paciente?.nombre)} con ${esc(x?.nombre||"")}<br><b>${esc(fechaLarga(c.fecha))} · ${esc(h12(c.hora))}</b></p><span class="mono folio-grande">${esc(c.folio)}</span></div>
    <div class="modal-f" style="justify-content:center"><button type="button" class="btn" id="okVer">Ver ticket</button><button type="button" class="btn btn-primary" id="okIr">Aceptar</button></div></div>`);
  $("#okIr").addEventListener("click",()=>{ cerrarCapa(); S.vista="citas"; S.filtro.estado="proximas"; render(); window.scrollTo({top:0}); });
  $("#okVer").addEventListener("click",()=>{ cerrarCapa(); S.vista="citas"; render(); abrirTicket(c.id); });
  setTimeout(()=>$("#okIr")?.focus(),60);
}
function pedirSalida(){
  confirmar("Cerrar sesión", "¿Seguro que quieres salir? Tendrás que volver a escribir tu usuario y contraseña.", ()=>cerrarSesion(), false);
}
function ventanaPago(dt){
  capa(`<div class="modal flotante pago" role="alertdialog" aria-modal="true" aria-labelledby="pgT" style="width:min(520px,100%)">
    <div class="modal-b pago-b"><span class="pago-ico" aria-hidden="true">${ICON.candado}</span>
      <h2 id="pgT">${esc(dt.titulo||"Acceso suspendido")}</h2>
      <p>${esc(dt.error||"Tu acceso no está disponible por falta de pago.")}</p>
      ${dt.banco?`${tarjetaBanco(dt.banco)}<p class="note" style="margin:0">Realiza tu transferencia y comunícate con tu recepción al <b>${esc(EMPRESA.telefono)}</b> para reactivar tu cuenta.</p>`:""}
    </div>
    <div class="modal-f" style="justify-content:center"><button type="button" class="btn btn-primary" data-cerrar>Entendido</button></div></div>`);
}

/* ================= sala de espera ================= */
const urlSala = id => `${location.origin}/sala.html?m=${encodeURIComponent(id)}`;
function vistaSala(){
  const t = hoy();
  return `<div class="head"><div><h1>Sala de espera</h1><p>Pantalla pública por médico: los pacientes ven su turno (número e iniciales) sin iniciar sesión. Ábrela en una TV o compártela por WhatsApp.</p></div></div>
  <div class="docs">${d().doctores.map(x=>{ const hoyC=d().citas.filter(c=>c.doctorId===x.id && c.fecha===t && c.estado!=="cancelada"); const enC=hoyC.find(c=>c.enConsulta); return `
    <article class="panel doc">
      <div class="doc-top">${avatarDe(x)}<div style="min-width:0"><b>${esc(x.nombre)}</b><small>${esc(x.especialidad)}</small></div></div>
      <dl class="kv"><dt>Turnos de hoy</dt><dd class="num">${hoyC.length}</dd><dt>En consulta</dt><dd>${enC?esc(enC.paciente?.nombre):"—"}</dd><dt>Atendidos</dt><dd class="num">${hoyC.filter(c=>c.estado==="atendida").length}</dd></dl>
      <div class="doc-foot"><a class="btn btn-sm btn-primary" href="${esc(urlSala(x.id))}" target="_blank" rel="noopener">${ICON.sala}Abrir sala</a><button type="button" class="btn btn-sm" data-copiar="${esc(urlSala(x.id))}">Copiar enlace</button></div>
    </article>`; }).join("") || `<div class="panel empty"><b>Sin médicos</b>Da de alta un suscriptor para tener su sala de espera.</div>`}</div>`;
}

/* ================= notificaciones (escritorio y celular) ================= */
const Notif = (() => {
  const soportado = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const b64 = s => { const p="=".repeat((4-s.length%4)%4); const r=atob((s+p).replace(/-/g,"+").replace(/_/g,"/")); return Uint8Array.from(r, c=>c.charCodeAt(0)); };
  async function registrar(){ if(!("serviceWorker" in navigator)) return null; try{ return await navigator.serviceWorker.register("sw.js", {scope:"./"}); }catch(e){ return null; } }
  async function suscribir(pedir){
    if(!soportado()) return "no";
    if(Notification.permission==="denied") return "denegado";
    if(Notification.permission!=="granted"){ if(!pedir) return "pendiente"; const r = await Notification.requestPermission(); if(r!=="granted") return "denegado"; }
    const reg = await registrar(); if(!reg) return "no";
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if(!sub){ const { clave } = await Store.api("GET","/push/clave",undefined,{silencioso:true}); sub = await reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:b64(clave) }); }
    await Store.api("POST","/push/suscribir",{ suscripcion: sub.toJSON() },{silencioso:true});
    return "activo";
  }
  async function baja(){ try{ const reg = await navigator.serviceWorker.getRegistration(); const sub = await reg?.pushManager.getSubscription(); if(sub){ await Store.api("POST","/push/baja",{endpoint:sub.endpoint},{silencioso:true}); await sub.unsubscribe(); } }catch(e){} }
  const estado = () => !soportado() ? "no" : Notification.permission==="granted" ? "activo" : Notification.permission==="denied" ? "denegado" : "pendiente";
  return { suscribir, baja, estado, soportado, registrar };
})();
function botonNotif(){
  const e = Notif.estado();
  const txt = e==="activo" ? "Notificaciones activas" : e==="denegado" ? "Notificaciones bloqueadas" : e==="no" ? (/iPhone|iPad/.test(navigator.userAgent) ? "Añade a inicio para avisos" : "Sin notificaciones") : "Activar notificaciones";
  return `<button type="button" class="btn btn-sm notif-btn ${e}" data-notif ${e==="activo"||e==="no"?"":""}>${ICON.campana}<span>${txt}</span></button>`;
}
document.addEventListener("click", async e=>{
  if(e.target.closest("[data-notif]")){
    const est = Notif.estado();
    if(est==="no"){ return toast(/iPhone|iPad/.test(navigator.userAgent) ? "En iPhone: abre el sitio en Safari, toca Compartir → Agregar a inicio y entra desde ese ícono." : "Este navegador no admite notificaciones."); }
    if(est==="denegado") return toast("Las bloqueaste en el navegador. Actívalas en la configuración del sitio (candado junto a la dirección).");
    const r = await Notif.suscribir(true).catch(()=>"error");
    if(r==="activo"){ toast("Notificaciones activadas"); Store.api("POST","/push/prueba",{},{silencioso:true}).catch(()=>{}); } else if(r==="denegado") toast("No se dieron los permisos."); else toast("No se pudieron activar las notificaciones.");
    if(S.usuario && $("#app")) pintarNav();
  }
  const cp = e.target.closest("[data-copiar]"); if(cp){ try{ await navigator.clipboard.writeText(cp.dataset.copiar); toast("Copiado"); }catch(_){ toast("No se pudo copiar"); } }
  const sl = e.target.closest("[data-sala]"); if(sl) window.open(urlSala(sl.dataset.sala), "_blank", "noopener");
});

/* ================= mensajes internos =================
   Una conversación por médico (la recepción habla con cada uno). Cada mensaje
   guarda quién lo envió y si ya lo leyó la otra parte. Los avisos generales
   se copian a todas las conversaciones. */
function mensajesDeBienvenida(x){
  const ahora = Date.now();
  return (x.doctores||[]).map((doc,i)=>({ id:"msg-"+randHex(6), conv:doc.id, de:"admin", texto:`Hola, ${doc.nombre}. Este es tu canal directo con la recepción: escríbenos cambios de horario, pacientes que quieras atender o cualquier duda.`, fecha:new Date(ahora-(i+1)*3600e3).toISOString(), leidoAdmin:true, leidoMedico:i!==0 }))
    .concat((x.doctores||[]).slice(0,1).map(doc=>({ id:"msg-"+randHex(6), conv:doc.id, de:"medico", texto:"Gracias. ¿Me pueden confirmar mis citas del lunes?", fecha:new Date(ahora-20*60e3).toISOString(), leidoAdmin:false, leidoMedico:true })));
}
const miConv = () => esAdmin() ? S.chatCon : S.usuario?.doctorId;
const mensajesDe = conv => d().mensajes.filter(m=>m.conv===conv).sort((a,b)=>a.fecha.localeCompare(b.fecha));
function sinLeer(conv){
  if(!S.usuario || !d()?.mensajes) return 0;
  if(esAdmin()) return d().mensajes.filter(m=>m.de==="medico" && !m.leidoAdmin && (!conv || m.conv===conv)).length;
  return d().mensajes.filter(m=>m.conv===S.usuario.doctorId && m.de==="admin" && !m.leidoMedico).length;
}
let vistosMsg = null;
function avisarMensajeNuevo(){
  const n = sinLeer(); if(vistosMsg!==null && n>vistosMsg && S.vista!=="mensajes"){ const ult = d().mensajes.filter(m=>esAdmin()?m.de==="medico":m.de==="admin" && m.conv===S.usuario.doctorId).sort((a,b)=>b.fecha.localeCompare(a.fecha))[0];
    toast(esAdmin() ? `Mensaje nuevo de ${docById(ult?.conv)?.nombre||"un médico"}` : "Tienes un mensaje nuevo de la recepción"); }
  vistosMsg = n;
}
function marcarLeidos(conv){
  let cambio=false;
  d().mensajes.forEach(m=>{ if(m.conv!==conv) return;
    if(esAdmin() && m.de==="medico" && !m.leidoAdmin){ m.leidoAdmin=true; m.leidoAdminEn=new Date().toISOString(); cambio=true; }
    if(!esAdmin() && m.de==="admin" && !m.leidoMedico){ m.leidoMedico=true; m.leidoMedicoEn=new Date().toISOString(); cambio=true; } });
  if(cambio){ Store.guardar(); vistosMsg = sinLeer(); }
}
const horaMsg = iso => { const d = new Date(iso); return h12(`${pad(d.getHours())}:${pad(d.getMinutes())}`); };
function etiquetaDia(iso){ const f = ymd(new Date(iso)); return f===hoy() ? "Hoy" : f===addDays(hoy(),-1) ? "Ayer" : fechaLarga(f); }
function burbuja(m){
  const mio = esAdmin() ? m.de==="admin" : m.de==="medico";
  const leido = esAdmin() ? m.leidoMedico : m.leidoAdmin;
  const c = m.citaId ? d().citas.find(o=>o.id===m.citaId) : null;
  return `<div class="msg ${mio?"mio":"suyo"} ${m.aviso?"aviso":""}">
    ${m.aviso?`<span class="msg-aviso">${ICON.megafono}Aviso para todos los médicos</span>`:""}
    ${m.texto?`<p>${esc(m.texto)}</p>`:""}
    ${c?`<button type="button" class="msg-cita" data-ticket="${esc(c.id)}"><span class="num"><b>${esc(h12(c.hora))}</b><small>${esc(fechaCorta(c.fecha))}</small></span><span><b>${esc(c.paciente?.nombre)}</b><small>${esc(c.folio)} · ${c.estado==="confirmada"?"Confirmada":c.estado==="atendida"?"Atendida":"Cancelada"}</small></span></button>`:""}
    <span class="msg-meta">${horaMsg(m.fecha)}${mio?`<i class="leido ${leido?"si":""}" title="${leido?"Leído":"Enviado"}">${leido?'<svg width="16" height="11" viewBox="0 0 16 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 6l3 3 6-7"/><path d="M6 9l1 1 6-8"/></svg>':'<svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 6l3 3 5-7"/></svg>'}</i>`:""}</span>
  </div>`;
}
function hiloHTML(conv){
  const lista = mensajesDe(conv); let dia = "";
  if(!lista.length) return `<div class="chat-vacio">${ICON.mensajes}<b>Aún no hay mensajes</b><span>Escribe el primero; ${esAdmin()?"el médico":"tu recepción"} lo verá al entrar.</span></div>`;
  return lista.map(m=>{ const et = etiquetaDia(m.fecha); const sep = et!==dia ? `<div class="chat-dia"><span>${esc(et)}</span></div>` : ""; dia = et; return sep + burbuja(m); }).join("");
}
function vistaMensajes(){
  if(esAdmin()){
    const q = S.chatBusca.trim().toLowerCase();
    const convs = d().doctores.map(doc=>{ const l=mensajesDe(doc.id); return { doc, ult:l[l.length-1], n:sinLeer(doc.id) }; })
      .filter(o=>!q || o.doc.nombre.toLowerCase().includes(q))
      .sort((a,b)=>(b.ult?.fecha||"").localeCompare(a.ult?.fecha||""));
    if(S.chatCon && !docById(S.chatCon)) S.chatCon="";
    const doc = docById(S.chatCon);
    if(doc) marcarLeidos(doc.id);
    return `
    <div class="head"><div><h1>Mensajes</h1><p>Habla con cada médico sin salir del sistema.</p></div><button type="button" class="btn" id="chatAviso">${ICON.megafono}Aviso a todos</button></div>
    <section class="chat panel ${doc?"con-hilo":""}">
      <aside class="chat-lista">
        <label class="chat-buscar"><input class="input" id="chatBusca" type="search" placeholder="Buscar médico" value="${esc(S.chatBusca)}" aria-label="Buscar conversación"></label>
        <div class="chat-convs">${convs.map(o=>`<button type="button" class="conv ${o.doc.id===S.chatCon?"activa":""}" data-conv="${esc(o.doc.id)}">${avatarDe(o.doc)}<span class="conv-txt"><b>${esc(o.doc.nombre)}</b><small>${o.ult?`${o.ult.de==="admin"?"Tú: ":""}${esc((o.ult.texto||"Cita compartida").slice(0,60))}`:"Sin mensajes"}</small></span><span class="conv-der">${o.ult?`<small class="num">${esc(ymd(new Date(o.ult.fecha))===hoy()?horaMsg(o.ult.fecha):fechaCorta(ymd(new Date(o.ult.fecha))))}</small>`:""}${o.n?`<i class="num">${o.n}</i>`:""}</span></button>`).join("") || `<p class="note" style="padding:14px">Sin resultados.</p>`}</div>
      </aside>
      ${doc ? panelHilo(doc.id, doc) : `<div class="chat-hilo chat-elige">${ICON.mensajes}<b>Elige una conversación</b><span>Selecciona a un médico de la lista para ver sus mensajes.</span></div>`}
    </section>`;
  }
  const me = miDoctor(); marcarLeidos(me.id);
  return `
  <div class="head"><div><h1>Mensajes</h1><p>Tu canal directo con la recepción.</p></div></div>
  <section class="chat panel solo con-hilo">${panelHilo(me.id, null)}</section>`;
}
function panelHilo(conv, doc){
  const proximas = d().citas.filter(c=>c.doctorId===conv && c.fecha>=hoy() && c.estado!=="cancelada").sort((a,b)=>(a.fecha+a.hora).localeCompare(b.fecha+b.hora)).slice(0,12);
  return `<div class="chat-hilo">
    <header class="chat-cab">
      ${doc?`<button type="button" class="x chat-atras" data-chat-atras aria-label="Volver a conversaciones"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>${avatarDe(doc)}<span><b>${esc(doc.nombre)}</b><small>${esc(doc.especialidad)} · ${esc(doc.telefono||"")}</small></span><button type="button" class="btn btn-sm" data-ver-perfil="${esc(doc.id)}" style="margin-left:auto">Perfil</button>`
           :`<span class="chat-logo">${LOGO_A}</span><span><b>Recepción</b><small>Assistant · ${esc(EMPRESA.horario.split("·")[0].trim())}</small></span>`}
    </header>
    <div class="chat-msgs" id="chatMsgs" aria-live="polite">${hiloHTML(conv)}</div>
    <form class="chat-escribir" id="chatForm" novalidate>
      <div class="chat-adjunto" id="chatAdjunto" hidden></div>
      <div class="chat-fila">
        ${proximas.length?`<div class="chat-clip"><button type="button" class="x" id="chatClipBtn" aria-label="Adjuntar una cita" aria-expanded="false">${ICON.clip}</button><div class="chat-citas" id="chatCitas" hidden>${proximas.map(c=>`<button type="button" data-adj-cita="${esc(c.id)}"><b class="num">${esc(fechaCorta(c.fecha))} · ${esc(h12(c.hora))}</b><small>${esc(c.paciente?.nombre)}</small></button>`).join("")}</div></div>`:""}
        <textarea class="input" id="chatTexto" rows="1" maxlength="1000" placeholder="Escribe un mensaje…" aria-label="Mensaje"></textarea>
        <button type="submit" class="chat-enviar" aria-label="Enviar">${ICON.enviar}</button>
      </div>
    </form>
  </div>`;
}
function autoAltura(t){ t.style.height="auto"; t.style.height=Math.min(140, t.scrollHeight)+"px"; }
function enlazarMensajes(){
  const v=$("#view"); if(!$("#chatForm") && !v.querySelector("[data-conv]")) return;
  v.querySelectorAll("[data-conv]").forEach(b=>b.addEventListener("click",()=>{ S.chatCon=b.dataset.conv; render(); setTimeout(()=>$("#chatTexto")?.focus(),30); }));
  v.querySelector("[data-chat-atras]")?.addEventListener("click",()=>{ S.chatCon=""; render(); });
  const busca=$("#chatBusca"); if(busca) busca.addEventListener("input",()=>{ S.chatBusca=busca.value; const p=busca.selectionStart; render(); const n=$("#chatBusca"); n.focus(); n.setSelectionRange(p,p); });
  $("#chatAviso")?.addEventListener("click", avisoATodos);
  const msgs=$("#chatMsgs"); if(msgs) msgs.scrollTop = msgs.scrollHeight;
  const t=$("#chatTexto"); if(!t) return;
  let adjunto = null;
  t.addEventListener("input",()=>autoAltura(t));
  t.addEventListener("keydown",e=>{ if(e.key==="Enter" && !e.shiftKey && !e.isComposing){ e.preventDefault(); $("#chatForm").requestSubmit(); } });
  const clip=$("#chatClipBtn"), lista=$("#chatCitas");
  clip?.addEventListener("click",()=>{ lista.hidden=!lista.hidden; clip.setAttribute("aria-expanded",String(!lista.hidden)); });
  lista?.querySelectorAll("[data-adj-cita]").forEach(b=>b.addEventListener("click",()=>{ adjunto=b.dataset.adjCita; const c=d().citas.find(o=>o.id===adjunto); const box=$("#chatAdjunto"); box.hidden=false; box.innerHTML=`<span>${ICON.clip}<b>${esc(c.paciente?.nombre)}</b> · ${esc(fechaCorta(c.fecha))} ${esc(h12(c.hora))}</span><button type="button" class="x" aria-label="Quitar cita adjunta">${ICON.cerrar}</button>`; box.querySelector("button").addEventListener("click",()=>{ adjunto=null; box.hidden=true; }); lista.hidden=true; clip.setAttribute("aria-expanded","false"); t.focus(); }));
  $("#chatForm").addEventListener("submit",ev=>{ ev.preventDefault(); intentar(()=>{
    const texto = limpiarTexto(t.value, 1000); const conv = miConv();
    if(!texto && !adjunto) return;
    if(!conv) throw new Error("Elige una conversación.");
    if(!esAdmin()) exigir("medico", conv);
    if(adjunto){ const c=d().citas.find(o=>o.id===adjunto); if(!c || c.doctorId!==conv) throw new Error("Esa cita no pertenece a esta conversación."); }
    const ahora=new Date().toISOString();
    d().mensajes.push({ id:"msg-"+randHex(6), conv, de:esAdmin()?"admin":"medico", autor:S.usuario.usuario, texto, citaId:adjunto||null, fecha:ahora, leidoAdmin:esAdmin(), leidoMedico:!esAdmin() });
    S.chatBorrador[S.chatCon||"_"]=""; t.value="";
    if(Store.guardar()) render();
  }); });
}
function avisoATodos(){
  capa(`<form class="modal" id="fAviso" role="dialog" aria-modal="true" aria-labelledby="avT" style="width:min(560px,100%)"><div class="modal-h"><h2 id="avT">Aviso para todos los médicos</h2><button type="button" class="x" data-cerrar aria-label="Cerrar">${ICON.cerrar}</button></div>
    <div class="modal-b"><p class="note" style="margin:0">Llegará a la conversación de cada uno de tus ${d().doctores.length} médicos, marcado como aviso.</p><label class="field" for="avTexto"><span>Mensaje</span><textarea class="input" id="avTexto" maxlength="1000" style="min-height:130px" placeholder="Ejemplo: el lunes 2 de noviembre la recepción atenderá de 9:00 a 14:00."></textarea></label></div>
    <div class="modal-f"><span class="note" id="avMsg" role="status" style="margin-right:auto;align-self:center"></span><button type="button" class="btn" data-cerrar>Cancelar</button><button type="submit" class="btn btn-primary">${ICON.megafono}Enviar a todos</button></div></form>`);
  $("#fAviso").addEventListener("submit",ev=>{ ev.preventDefault(); intentar(()=>{ exigir("admin");
    const texto=limpiarTexto($("#avTexto").value,1000); if(texto.length<3){ $("#avMsg").textContent="Escribe el aviso."; return; }
    const ahora=new Date().toISOString();
    d().doctores.forEach(doc=>d().mensajes.push({ id:"msg-"+randHex(6), conv:doc.id, de:"admin", autor:S.usuario.usuario, texto, aviso:true, fecha:ahora, leidoAdmin:true, leidoMedico:false }));
    bitacora("Aviso enviado a todos los médicos", texto.slice(0,80)); if(Store.guardar()){ cerrarCapa(); render(); toast(`Aviso enviado a ${d().doctores.length} médicos`); }
  }); });
}

/* ================= perfil profesional del médico =================
   Foto, banner, descripción, servicios y certificados. El médico lo edita
   desde "Mi perfil"; la recepción lo ve completo y descarga una ficha para
   compartir con el paciente. Las imágenes se reducen antes de guardarse
   (en esta versión de pruebas todo vive en el navegador). */
function avatarDe(x, clase="avatar"){
  return x?.foto ? `<img class="${clase} foto" src="${esc(x.foto)}" alt="">` : `<span class="${clase}" style="--c:${esc(x?.color||"#0B7A63")}">${esc(iniciales(x?.nombre))}</span>`;
}
function leerArchivo(file){ return new Promise((ok,mal)=>{ const r=new FileReader(); r.onload=()=>ok(r.result); r.onerror=()=>mal(r.error); r.readAsDataURL(file); }); }
async function reducirImagen(file, maxW, maxH, calidad=.82){
  if(!/^image\/(png|jpe?g|webp)$/.test(file.type)) throw new Error("Usa una imagen JPG, PNG o WEBP.");
  if(file.size > 12*1024*1024) throw new Error("La imagen pesa más de 12 MB.");
  const url = URL.createObjectURL(file);
  try{
    const img = new Image(); img.src = url; await img.decode();
    const k = Math.min(1, maxW/img.width, maxH/img.height);
    const cv = document.createElement("canvas"); cv.width = Math.round(img.width*k); cv.height = Math.round(img.height*k);
    const g = cv.getContext("2d"); g.fillStyle="#fff"; g.fillRect(0,0,cv.width,cv.height); g.drawImage(img,0,0,cv.width,cv.height);
    return cv.toDataURL("image/jpeg", calidad);
  } finally { URL.revokeObjectURL(url); }
}
async function recortarCuadrado(file, lado){
  if(!/^image\/(png|jpe?g|webp)$/.test(file.type)) throw new Error("Usa una imagen JPG, PNG o WEBP.");
  const url = URL.createObjectURL(file);
  try{
    const img = new Image(); img.src=url; await img.decode();
    const m = Math.min(img.width, img.height); const cv=document.createElement("canvas"); cv.width=cv.height=lado;
    cv.getContext("2d").drawImage(img,(img.width-m)/2,(img.height-m)/2,m,m,0,0,lado,lado);
    return cv.toDataURL("image/jpeg",.86);
  } finally { URL.revokeObjectURL(url); }
}
function vistaPerfil(x, propio){
  const certs = x.certificados||[];
  const pr = planDe(x);
  return `
  <div class="head"><div><h1>${propio?"Mi perfil profesional":"Perfil del médico"}</h1><p>${propio?"Así te ve tu recepción y la ficha que se comparte con tus pacientes.":"Vista completa para compartir con el paciente."}</p></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">${!propio?`<button type="button" class="btn" data-v="medicos">Volver a médicos</button>`:""}<button type="button" class="btn" data-ficha="png" data-doc="${esc(x.id)}">${ICON.png}Ficha en imagen</button><button type="button" class="btn btn-primary" data-ficha="pdf" data-doc="${esc(x.id)}">${ICON.pdf}Ficha en PDF</button></div></div>
  <article class="perfil panel" id="fichaPerfil">
    <div class="perfil-banner" ${x.banner?`style="background-image:url('${esc(x.banner)}')"`:`style="--c:${esc(x.color)}"`}>
      ${propio?`<label class="perfil-cambiar" for="pfBanner">${ICON.png}<span>${x.banner?"Cambiar banner":"Agregar banner"}</span><input type="file" id="pfBanner" accept="image/jpeg,image/png,image/webp" hidden></label>`:""}
    </div>
    <div class="perfil-cuerpo">
      <div class="perfil-id">
        <div class="perfil-foto">${avatarDe(x,"perfil-av")}${propio?`<label class="perfil-foto-btn" for="pfFoto" aria-label="Cambiar foto de perfil">${ICON.camara}<input type="file" id="pfFoto" accept="image/jpeg,image/png,image/webp" hidden></label>`:""}</div>
        <div class="perfil-nombre"><h2>${esc(x.nombre)}</h2>
          <p class="perfil-esp">${esc(x.especialidad)}</p>
          <div class="perfil-sellos">${insigniaPlan(pr.id)}${x.cedula?`<span class="sello-cedula">${ICON.verificar}<span><small>Cédula profesional</small><b class="num">${esc(x.cedula)}</b></span></span>`:""}${certs.length?`<span class="sello-certs">${certs.length} ${certs.length===1?"certificado":"certificados"}</span>`:""}</div></div>
      </div>
      ${(x.servicios||[]).length?`<div class="perfil-chips">${x.servicios.map(t=>`<span class="tag">${esc(t)}</span>`).join("")}</div>`:""}
      <div class="perfil-grid">
        <section class="perfil-sobre">
          <h3>Sobre ${propio?"mí":esc(x.nombre.split(" ").slice(0,2).join(" "))}</h3>
          ${x.descripcion?`<p class="perfil-desc">${esc(x.descripcion)}</p>`:`<p class="note">${propio?"Aún no escribes tu descripción. Cuéntale a tus pacientes tu experiencia y cómo atiendes.":"El médico aún no agrega su descripción."}</p>`}
          <h3>Certificados y cédulas</h3>
          ${certs.length?`<ul class="insignias">${certs.map((c,i)=>`<li><button type="button" class="insignia-cert" data-cert="${esc(c.id)}" data-doc="${esc(x.id)}" style="--tono:${TONOS_CERT[i%TONOS_CERT.length]}">${medallon(c)}<b>${esc(c.nombre)}</b><small>${esc([c.institucion,c.anio].filter(Boolean).join(" · ")||" ")}</small><em>${c.tipo==="pdf"?"Ver PDF":"Ver documento"}</em></button>${propio?`<button type="button" class="x quitar-cert" data-cert-quitar="${esc(c.id)}" aria-label="Quitar ${esc(c.nombre)}">${ICON.cerrar}</button>`:""}</li>`).join("")}</ul>`:`<p class="note">${propio?"Agrega tus títulos, cédulas o diplomados para dar más confianza.":"Sin certificados adjuntos."}</p>`}
        </section>
        <aside class="perfil-datos">
          <div class="perfil-costo"><small>Consulta</small><b class="num">${x.costoConsulta?dinero(x.costoConsulta):"—"}</b></div>
          <dl class="perfil-info">
            <div><dt>${ICON.sala}Consultorio</dt><dd>${esc(x.consultorio||"—")}${x.direccion?`<small>${esc(x.direccion)}</small>`:""}</dd></div>
            <div><dt>${ICON.reloj}Horario</dt><dd>${esc(textoHorario(x))}</dd></div>
            <div><dt>${ICON.mensajes}Teléfono</dt><dd class="num">${esc(x.telefono||"—")}</dd></div>
            ${!propio?`<div><dt>${ICON.planes}Plan</dt><dd>${esc(pr.nombre)}</dd></div>`:""}
          </dl>
        </aside>
      </div>
    </div>
  </article>
  ${propio?`<section class="panel panel-b" style="display:flex;flex-direction:column;gap:16px">
    <h2 style="font-size:17px">Editar mi perfil</h2>
    <form id="fPerfil" novalidate style="display:flex;flex-direction:column;gap:14px">
      <label class="field" for="pfDesc"><span>Descripción profesional</span><textarea class="input" id="pfDesc" maxlength="900" style="min-height:120px" placeholder="Tu experiencia, enfoque de atención, hospitales donde has trabajado…">${esc(x.descripcion||"")}</textarea></label>
      <label class="field" for="pfServ"><span>Servicios o áreas de atención (separados por coma)</span><input class="input" id="pfServ" maxlength="300" value="${esc((x.servicios||[]).join(", "))}" placeholder="Control de diabetes, chequeo general, certificados médicos"></label>
      <div style="display:flex;justify-content:flex-end;gap:10px;align-items:center"><span class="note" id="pfMsg" role="status"></span><button type="submit" class="btn btn-primary">Guardar perfil</button></div>
    </form>
    <form id="fCert" class="disp-bloque" novalidate>
      <b>Agregar certificado</b>
      <div class="grid-bloq">
        <label class="field" for="ctNom"><span>Nombre</span><input class="input" id="ctNom" maxlength="90" placeholder="Especialidad en Cardiología"></label>
        <label class="field" for="ctInst"><span>Institución</span><input class="input" id="ctInst" maxlength="90" placeholder="UNAM"></label>
        <label class="field" for="ctAnio"><span>Año</span><input class="input" id="ctAnio" type="number" min="1950" max="${new Date().getFullYear()}"></label>
        <label class="field" for="ctArch"><span>Archivo (imagen o PDF)</span><input class="input" id="ctArch" type="file" accept="image/jpeg,image/png,image/webp,application/pdf"></label>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:10px;align-items:center;flex-wrap:wrap"><span class="note" id="ctMsg" role="status"></span><button type="submit" class="btn">Adjuntar certificado</button></div>
    </form>
  </section>`:""}`;
}
function enlazarPerfil(){
  const v=$("#view");
  v.querySelectorAll("[data-ver-perfil]").forEach(b=>b.addEventListener("click",()=>{ S.perfilDe=b.dataset.verPerfil; S.vista="perfil"; render(); window.scrollTo({top:0}); }));
  v.querySelectorAll("[data-ficha]").forEach(b=>b.addEventListener("click",()=>descargarFicha(docById(b.dataset.doc), b.dataset.ficha)));
  v.querySelectorAll("[data-cert]").forEach(b=>b.addEventListener("click",()=>verCertificado(docById(b.dataset.doc), b.dataset.cert)));
  const fich = v.querySelector("[data-cert]"); if(fich) miniaturasPdf(docById(fich.dataset.doc));
  const me = miDoctor(); if(!me || !$("#fPerfil")) return;
  const guardarImg = async (input, campo, fn) => { const f=input.files?.[0]; if(!f) return; try{ exigir("medico", me.id); const data = await fn(f); me[campo]=data; bitacora(campo==="foto"?"Foto de perfil actualizada":"Banner actualizado", me.nombre); if(Store.guardar()){ render(); toast("Imagen actualizada"); } }catch(e){ toast(e.message||"No se pudo cargar la imagen."); } };
  $("#pfFoto")?.addEventListener("change",e=>guardarImg(e.target,"foto",f=>recortarCuadrado(f,360)));
  $("#pfBanner")?.addEventListener("change",e=>guardarImg(e.target,"banner",f=>reducirImagen(f,1500,520,.8)));
  $("#fPerfil").addEventListener("submit",ev=>{ ev.preventDefault(); intentar(()=>{ exigir("medico", me.id);
    me.descripcion = limpiarTexto($("#pfDesc").value,900);
    me.servicios = $("#pfServ").value.split(",").map(t=>limpiar(t,40)).filter(Boolean).slice(0,10);
    bitacora("Perfil actualizado", me.nombre); if(Store.guardar()){ render(); toast("Perfil guardado"); } }); });
  $("#fCert").addEventListener("submit", async ev=>{ ev.preventDefault(); const msg=$("#ctMsg");
    const nombre=limpiar($("#ctNom").value,90), f=$("#ctArch").files?.[0];
    if(nombre.length<3) return msg.textContent="Escribe el nombre del certificado.";
    if(!f) return msg.textContent="Elige el archivo.";
    try{
      exigir("medico", me.id);
      let tipo, data;
      if(f.type==="application/pdf"){ if(f.size>1.5*1024*1024) return msg.textContent="En esta versión de prueba el PDF debe pesar menos de 1.5 MB."; tipo="pdf"; data=await leerArchivo(f); }
      else { tipo="img"; data=await reducirImagen(f,1600,1600,.78); }
      me.certificados=[...(me.certificados||[]), {id:"crt-"+randHex(4), nombre, institucion:limpiar($("#ctInst").value,90), anio:limpiar($("#ctAnio").value,4), tipo, data, subido:new Date().toISOString()}];
      bitacora("Certificado agregado", `${me.nombre} · ${nombre}`);
      if(!Store.guardar()){ me.certificados.pop(); return; }
      render(); toast("Certificado agregado");
    }catch(e){ msg.textContent = e.message || "No se pudo cargar el archivo."; }
  });
  v.querySelectorAll("[data-cert-quitar]").forEach(b=>b.addEventListener("click",()=>confirmar("Quitar certificado","Se quitará este certificado de tu perfil.",()=>intentar(()=>{ exigir("medico", me.id); me.certificados=(me.certificados||[]).filter(c=>c.id!==b.dataset.certQuitar); bitacora("Certificado quitado", me.nombre); Store.guardar(); render(); toast("Certificado quitado"); }),true)));
}
function verCertificado(x, id){
  const c=(x?.certificados||[]).find(o=>o.id===id); if(!c) return;
  if(c.tipo==="pdf"){
    fetch(c.data).then(r=>r.blob()).then(b=>{ const u=URL.createObjectURL(b); const w=window.open(u,"_blank"); if(w) w.opener=null; else descargar(`${c.nombre}.pdf`, b); setTimeout(()=>URL.revokeObjectURL(u),60000); });
    return;
  }
  capa(`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="crT" style="width:min(900px,100%)"><div class="modal-h"><div><h2 id="crT">${esc(c.nombre)}</h2><div class="note">${esc([c.institucion,c.anio].filter(Boolean).join(" · "))}</div></div><button type="button" class="x" data-cerrar aria-label="Cerrar">${ICON.cerrar}</button></div><div class="modal-b"><img src="${esc(c.data)}" alt="${esc(c.nombre)}" style="width:100%;border-radius:10px;border:1px solid var(--line)"></div></div>`);
}
async function descargarFicha(x, formato){
  if(!x) return;
  if(formato==="png"){
    const el=$("#fichaPerfil"); if(!el) return; el.classList.add("exportando");
    try{ const cv = await html2canvas(el,{scale:2,backgroundColor:temaActual()==="dark"?"#0A0A0A":"#ffffff",logging:false}); cv.toBlob(b=>descargar(`Perfil ${x.nombre}.png`, b), "image/png"); }
    catch(e){ toast("No se pudo generar la imagen."); } finally{ el.classList.remove("exportando"); }
    return;
  }
  try{ pdfPerfil(x); bitacora("Ficha de perfil descargada", x.nombre); }catch(e){ console.error(e); toast("No se pudo generar el PDF."); }
}
/* Ficha profesional en PDF, dibujada con texto real (se puede seleccionar y se ve nítida al imprimir) */
function pdfPerfil(x){
  const { jsPDF } = window.jspdf; const pdf = new jsPDF({unit:"mm", format:"letter"});
  const W=215.9, H=279.4, M=18, negro=[12,12,12], gris=[100,100,100], suave=[240,240,240], acento=[11,122,99];
  const pl = planDe(x), certs = x.certificados||[];
  pdf.setProperties({title:`Perfil ${x.nombre}`, creator:"Assistant"});
  // banner
  if(x.banner){ try{ pdf.addImage(x.banner,"JPEG",0,0,W,62,undefined,"FAST"); }catch(e){ pdf.setFillColor(...negro); pdf.rect(0,0,W,62,"F"); } }
  else { pdf.setFillColor(...negro); pdf.rect(0,0,W,62,"F"); }
  pdf.setFillColor(0,0,0); pdf.setGState && pdf.setGState(new pdf.GState({opacity:.35})); pdf.rect(0,0,W,62,"F"); pdf.setGState && pdf.setGState(new pdf.GState({opacity:1}));
  if(MARCA_PNG_B) pdf.addImage(MARCA_PNG_B,"PNG",W-M-11,10,11,11.3);
  pdf.setTextColor(255,255,255); pdf.setFont("helvetica","bold"); pdf.setFontSize(8); pdf.text("ASSISTANT · ASISTENTES EN LÍNEA", W-M-14, 17, {align:"right"});
  // foto
  pdf.setFillColor(255,255,255); pdf.roundedRect(M-1.5,44.5,43,43,6,6,"F");
  if(x.foto){ try{ pdf.addImage(x.foto,"JPEG",M,46,40,40,undefined,"FAST"); }catch(e){} }
  else { pdf.setFillColor(...acento); pdf.roundedRect(M,46,40,40,5,5,"F"); pdf.setTextColor(255,255,255); pdf.setFontSize(22); pdf.text(iniciales(x.nombre),M+20,70,{align:"center"}); }
  // nombre y datos
  let y = 72; const cx = M+48;
  pdf.setTextColor(...negro); pdf.setFont("helvetica","bold"); pdf.setFontSize(20); pdf.text(x.nombre, cx, y);
  pdf.setFont("helvetica","normal"); pdf.setFontSize(11); pdf.setTextColor(...gris);
  pdf.text(`${x.especialidad||""}${x.cedula?`  ·  Cédula profesional ${x.cedula}`:""}`, cx, y+7);
  // insignia del plan
  const col = PLAN_COLORES[pl.id] || PLAN_COLORES.esencial;
  pdf.setFillColor(...col.rgb); pdf.roundedRect(cx, y+11, 44, 7, 3.5, 3.5, "F"); pdf.setTextColor(...col.txt); pdf.setFont("helvetica","bold"); pdf.setFontSize(7.5); pdf.text(`MIEMBRO ${pl.nombre.toUpperCase()}`, cx+22, y+15.6, {align:"center"});
  y = 102;
  // servicios
  if((x.servicios||[]).length){ let sx=M; pdf.setFont("helvetica","bold"); pdf.setFontSize(8.5);
    x.servicios.forEach(t=>{ const w=pdf.getTextWidth(t)+8; if(sx+w>W-M){ sx=M; y+=9; } pdf.setFillColor(...suave); pdf.roundedRect(sx,y-5,w,7,3.5,3.5,"F"); pdf.setTextColor(...negro); pdf.text(t,sx+4,y); sx+=w+3; }); y+=12; }
  const titulo = t => { pdf.setDrawColor(220,220,220); pdf.line(M,y,W-M,y); y+=8; pdf.setFont("helvetica","bold"); pdf.setFontSize(12); pdf.setTextColor(...negro); pdf.text(t, M, y); y+=7; };
  // sobre el médico
  if(x.descripcion){ titulo("Sobre el médico"); pdf.setFont("helvetica","normal"); pdf.setFontSize(10.5); pdf.setTextColor(40,40,40); const ls=pdf.splitTextToSize(x.descripcion, W-2*M); pdf.text(ls, M, y); y += ls.length*5.2 + 4; }
  // consulta
  titulo("Datos de consulta");
  const filas = [["Consultorio",x.consultorio||"—"],["Dirección",x.direccion||"—"],["Teléfono",x.telefono||"—"],["Horario",textoHorario(x)],["Costo de consulta",x.costoConsulta?dinero(x.costoConsulta):"—"]];
  filas.forEach(([k,v])=>{ pdf.setFont("helvetica","bold"); pdf.setFontSize(9.5); pdf.setTextColor(...gris); pdf.text(k, M, y); pdf.setFont("helvetica","normal"); pdf.setTextColor(...negro); const ls=pdf.splitTextToSize(String(v), W-2*M-42); pdf.text(ls, M+42, y); y += Math.max(6, ls.length*4.8+1.5); });
  // certificados como insignias
  if(certs.length){ y+=2; titulo("Certificaciones");
    const bw=(W-2*M-8)/3; certs.forEach((c,i)=>{ const col=i%3, fila=Math.floor(i/3); const bx=M+col*(bw+4), by=y+fila*26;
      if(by>H-30) return;
      pdf.setFillColor(...suave); pdf.roundedRect(bx,by,bw,22,3,3,"F");
      pdf.setFillColor(...acento); pdf.circle(bx+8,by+11,5,"F"); pdf.setDrawColor(255,255,255); pdf.setLineWidth(.7); pdf.lines([[1.6,1.6],[3,-3.4]], bx+5.6, by+11); pdf.setLineWidth(.2);
      pdf.setTextColor(...negro); pdf.setFont("helvetica","bold"); pdf.setFontSize(8.5); pdf.text(pdf.splitTextToSize(c.nombre, bw-18).slice(0,2), bx+16, by+9);
      pdf.setFont("helvetica","normal"); pdf.setFontSize(7.5); pdf.setTextColor(...gris); pdf.text([c.institucion,c.anio].filter(Boolean).join(" · "), bx+16, by+17.5); });
    y += Math.ceil(certs.length/3)*26; }
  // pie
  pdf.setFillColor(...negro); pdf.rect(0,H-14,W,14,"F"); pdf.setTextColor(255,255,255); pdf.setFont("helvetica","normal"); pdf.setFontSize(8);
  pdf.text(`Agenda tu cita con Assistant · Tel. ${EMPRESA.telefono} · ${EMPRESA.correo}`, M, H-6); pdf.text(`Ficha generada el ${fechaLarga(hoy())}`, W-M, H-6, {align:"right"});
  descargar(`Perfil ${x.nombre}.pdf`, pdf.output("blob"));
}

/* ================= disponibilidad del médico =================
   El médico define sus días y horas de consulta y sus ausencias. Las citas
   ya confirmadas que queden fuera se cancelan solas y la recepción recibe
   un aviso para contactar a cada paciente. */
function citasAfectadas(doc, cambios){
  const prueba = { ...doc, ...cambios };
  const ahora = hoy();
  return d().citas.filter(c=>{
    if(c.doctorId!==doc.id || c.estado!=="confirmada" || c.fecha<ahora) return false;
    if(enAusencia(prueba, c.fecha)) return true;
    const r = rangoDelDia(prueba, c.fecha); if(!r) return true;
    const m = minutos(c.hora), fin = m + durCita(c, prueba);
    if(m < r.inicio || fin > r.fin) return true;
    return (prueba.bloqueos||[]).some(bq=>bq.fecha===c.fecha && traslapa(m, fin, minutos(bq.desde), minutos(bq.hasta)));
  });
}
function aplicarDisponibilidad(doc, cambios, descripcion){
  exigir("medico", doc.id);
  const afect = citasAfectadas(doc, cambios);
  const ejecutar = () => intentar(()=>{
    exigir("medico", doc.id);
    Object.assign(doc, cambios);
    const ahora = new Date().toISOString();
    afect.forEach(c=>{ c.estado="cancelada"; c.motivoCancelacion=`${doc.nombre} cambió su disponibilidad (${descripcion.toLowerCase()})`; c.canceladaPor=S.usuario.usuario; c.cancelada=ahora; c.avisoPendiente=true; });
    bitacora(descripcion, `${doc.nombre}${afect.length?` · ${afect.length} cita(s) canceladas`:""}`);
    Store.guardar(); cerrarCapa(); render();
    toast(afect.length ? `Guardado. Se cancelaron ${afect.length} cita(s) y tu recepción fue avisada.` : "Disponibilidad guardada");
  });
  if(!afect.length) return ejecutar();
  confirmar("Hay citas en esas fechas",
    `${afect.length} cita(s) confirmada(s) quedan fuera de tu disponibilidad: ${afect.slice(0,4).map(c=>`${fechaCorta(c.fecha)} ${h12(c.hora)} (${c.paciente?.nombre})`).join(", ")}${afect.length>4?"…":""}. Se cancelarán y tu recepción avisará a cada paciente.`,
    ejecutar, true);
}
function seccionDisponibilidad(me){
  const h = me.horario||{dias:[],inicio:"09:00",fin:"17:00",duracion:30};
  const aus = (me.ausencias||[]).filter(a=>a.hasta>=hoy()).sort((a,b)=>a.desde.localeCompare(b.desde));
  const bloq = (me.bloqueos||[]).filter(bq=>bq.fecha>=hoy()).sort((a,b)=>(a.fecha+a.desde).localeCompare(b.fecha+b.desde));
  return `
  <section class="panel panel-b disp" style="display:flex;flex-direction:column;gap:18px">
    <div><h2 style="font-size:17px">Mi disponibilidad</h2><p class="note" style="margin:4px 0 0">Tu recepción solo agenda en los días y horas que marques aquí. Los cambios se aplican al momento.</p></div>
    <form id="fHor" class="disp-bloque" novalidate>
      <b>Mi horario de la semana</b>
      <p class="note" style="margin:-6px 0 0">Activa los días que consultas y pon de qué hora a qué hora atiendes cada uno.</p>
      <div class="semana-hor">${[1,2,3,4,5,6,0].map(n=>{ const on=(h.dias||[]).includes(n); const r=h.horas?.[n]||{inicio:h.inicio||"09:00",fin:h.fin||"17:00"}; return `
        <div class="dia-hor ${on?"on":""}" data-fila="${n}">
          <label class="interruptor"><input type="checkbox" data-hdia="${n}" ${on?"checked":""}><span class="sw" aria-hidden="true"></span><b>${["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"][n]}</b></label>
          <span class="rango"><input class="input" type="time" step="300" data-hini="${n}" value="${esc(r.inicio)}" aria-label="Hora de inicio"><span>a</span><input class="input" type="time" step="300" data-hfin="${n}" value="${esc(r.fin)}" aria-label="Hora de fin"></span>
          <span class="no-atiende">No consulto</span>
        </div>`; }).join("")}</div>
      <div class="grid3"><label class="field" for="hDur"><span>Duración de cada cita</span><select class="input" id="hDur">${[15,20,30,40,45,60,90].map(m=>`<option value="${m}" ${Number(h.duracion)===m?"selected":""}>${m} min</option>`).join("")}</select></label></div>
      <div style="display:flex;justify-content:flex-end;gap:10px;align-items:center;flex-wrap:wrap"><span class="note" id="hMsg" role="status"></span><button type="submit" class="btn btn-primary">Guardar horario</button></div>
    </form>
    <form id="fBloq" class="disp-bloque" novalidate>
      <b>Horas que ya tengo ocupadas</b>
      <p class="note" style="margin:-6px 0 0">¿Agendaste a alguien por tu cuenta? Marca esa hora y tu recepción no podrá usarla.</p>
      <div class="grid-bloq">
        <label class="field" for="bFecha"><span>Día</span><input class="input" id="bFecha" type="date" min="${hoy()}" value="${hoy()}"></label>
        <label class="field" for="bDesde"><span>De</span><input class="input" id="bDesde" type="time" step="300"></label>
        <label class="field" for="bHasta"><span>A</span><input class="input" id="bHasta" type="time" step="300"></label>
        <label class="field" for="bMotivo"><span>Nota (opcional)</span><input class="input" id="bMotivo" maxlength="60" placeholder="Paciente particular, cirugía…"></label>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:10px;align-items:center;flex-wrap:wrap"><span class="note" id="bMsg" role="status"></span><button type="submit" class="btn">Bloquear esta hora</button></div>
      ${bloq.length?`<ul class="aus-lista bloq-lista">${bloq.map(bq=>`<li><span><b>${esc(fechaLarga(bq.fecha))} · <span class="num">${esc(h12(bq.desde))} a ${esc(h12(bq.hasta))}</span></b>${bq.motivo?`<small>${esc(bq.motivo)}</small>`:""}</span><button type="button" class="btn btn-sm" data-bloq-quitar="${esc(bq.id)}">Liberar</button></li>`).join("")}</ul>`:`<p class="note" style="margin:0">No tienes horas bloqueadas.</p>`}
    </form>
    <form id="fAus" class="disp-bloque" novalidate>
      <b>Días completos que no voy a atender</b>
      <div class="grid3"><label class="field" for="aDesde"><span>Desde</span><input class="input" id="aDesde" type="date" min="${hoy()}" value="${hoy()}"></label><label class="field" for="aHasta"><span>Hasta</span><input class="input" id="aHasta" type="date" min="${hoy()}" value="${hoy()}"></label><label class="field" for="aMotivo"><span>Motivo (opcional)</span><input class="input" id="aMotivo" maxlength="60" placeholder="Vacaciones, congreso…"></label></div>
      <div style="display:flex;justify-content:flex-end;gap:10px;align-items:center"><span class="note" id="aMsg" role="status"></span><button type="submit" class="btn">Agregar ausencia</button></div>
      ${aus.length?`<ul class="aus-lista">${aus.map(a=>`<li><span><b>${a.desde===a.hasta?esc(fechaLarga(a.desde)):`${esc(fechaCorta(a.desde))} al ${esc(fechaCorta(a.hasta))}`}</b>${a.motivo?`<small>${esc(a.motivo)}</small>`:""}</span><button type="button" class="btn btn-sm" data-aus-quitar="${esc(a.id)}">Quitar</button></li>`).join("")}</ul>`:`<p class="note" style="margin:0">No tienes ausencias programadas.</p>`}
    </form>
  </section>`;
}
function enlazarDisponibilidad(){
  const me = miDoctor(); if(!me || !$("#fHor")) return;
  document.querySelectorAll("[data-hdia]").forEach(ch=>ch.addEventListener("change",()=>ch.closest(".dia-hor").classList.toggle("on", ch.checked)));
  $("#fHor").addEventListener("submit",ev=>{ ev.preventDefault(); const msg=$("#hMsg");
    const dias=[], horas={};
    for(const ch of document.querySelectorAll("[data-hdia]")){
      if(!ch.checked) continue; const n=Number(ch.dataset.hdia);
      const ini=document.querySelector(`[data-hini="${n}"]`).value, fin=document.querySelector(`[data-hfin="${n}"]`).value;
      if(!ini || !fin || minutos(fin)<=minutos(ini)) return msg.textContent=`Revisa el horario del ${DIAS[n]}: la hora final debe ser después de la inicial.`;
      if(minutos(fin)-minutos(ini) < Number($("#hDur").value)) return msg.textContent=`El ${DIAS[n]} no alcanza para una cita de ${$("#hDur").value} min.`;
      dias.push(n); horas[n]={inicio:ini, fin};
    }
    if(!dias.length) return msg.textContent="Activa al menos un día.";
    const prim = horas[dias[0]];
    try{ aplicarDisponibilidad(me, { horario:{dias, horas, inicio:prim.inicio, fin:prim.fin, duracion:Number($("#hDur").value)} }, "Horario actualizado por el médico"); }catch(e){ toast(e.message); }
  });
  $("#fBloq").addEventListener("submit",ev=>{ ev.preventDefault(); const msg=$("#bMsg");
    const fecha=$("#bFecha").value, desde=$("#bDesde").value, hasta=$("#bHasta").value;
    if(!fecha || !desde || !hasta) return msg.textContent="Escribe el día y el rango de horas.";
    if(fecha<hoy()) return msg.textContent="No puedes bloquear días pasados.";
    if(minutos(hasta)<=minutos(desde)) return msg.textContent="La hora final debe ser después de la inicial.";
    const nuevos=[...(me.bloqueos||[]).filter(bq=>bq.fecha>=hoy()), {id:"blq-"+randHex(4), fecha, desde, hasta, motivo:limpiar($("#bMotivo").value,60), creado:new Date().toISOString()}];
    try{ aplicarDisponibilidad(me, { bloqueos:nuevos }, "Horas bloqueadas por el médico"); }catch(e){ toast(e.message); }
  });
  document.querySelectorAll("[data-bloq-quitar]").forEach(b=>b.addEventListener("click",()=>intentar(()=>{
    exigir("medico", me.id); me.bloqueos=(me.bloqueos||[]).filter(x=>x.id!==b.dataset.bloqQuitar); bitacora("Horas liberadas por el médico", me.nombre); Store.guardar(); render(); toast("Horas liberadas");
  })));
  $("#fAus").addEventListener("submit",ev=>{ ev.preventDefault(); const msg=$("#aMsg");
    const desde=$("#aDesde").value, hasta=$("#aHasta").value;
    if(!desde || !hasta) return msg.textContent="Elige las fechas.";
    if(desde<hoy()) return msg.textContent="No puedes registrar ausencias en días pasados.";
    if(hasta<desde) return msg.textContent="La fecha final debe ser igual o posterior a la inicial.";
    if(fromYmd(hasta)-fromYmd(desde) > 120*864e5) return msg.textContent="Registra periodos de máximo 120 días.";
    const nuevas=[...(me.ausencias||[]), {id:"aus-"+randHex(4), desde, hasta, motivo:limpiar($("#aMotivo").value,60), creada:new Date().toISOString()}];
    try{ aplicarDisponibilidad(me, { ausencias:nuevas }, "Ausencia registrada por el médico"); }catch(e){ toast(e.message); }
  });
  document.querySelectorAll("[data-aus-quitar]").forEach(b=>b.addEventListener("click",()=>intentar(()=>{
    exigir("medico", me.id); me.ausencias=(me.ausencias||[]).filter(a=>a.id!==b.dataset.ausQuitar); bitacora("Ausencia quitada por el médico", me.nombre); Store.guardar(); render(); toast("Ausencia quitada; esos días vuelven a estar disponibles");
  })));
}

function vistaCuenta(me){
  const e = estadoSuscripcion(me);
  return `
  <div class="head"><div><h1>Mi cuenta</h1><p>Tu disponibilidad, tus datos de consultorio, tu plan y tu contraseña.</p></div></div>
  ${seccionDisponibilidad(me)}
  <div class="two">
    <section class="panel panel-b" style="display:flex;flex-direction:column;gap:14px">
      <div class="doc-top"><span class="avatar" style="--c:${esc(me.color)}">${esc(iniciales(me.nombre))}</span><div><b>${esc(me.nombre)}</b><small>${esc(me.especialidad)}${me.cedula?` · Céd. ${esc(me.cedula)}`:""}</small></div></div>
      <dl class="kv"><dt>Teléfono</dt><dd class="num">${esc(me.telefono||"—")}</dd><dt>Correo</dt><dd>${esc(me.email||"—")}</dd><dt>Consultorio</dt><dd>${esc(me.consultorio)}</dd><dt>Dirección</dt><dd>${esc(me.direccion||"—")}</dd><dt>Horario</dt><dd>${esc(textoHorario(me))}</dd><dt>Consulta</dt><dd>${me.costoConsulta?dinero(me.costoConsulta):"—"}</dd></dl>
      <p class="note" style="margin:0">Para cambiar tus datos de contacto o consultorio, pídeselo a tu recepción.</p>
      <div style="border-top:1px solid var(--line);padding-top:14px;display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><h2 style="font-size:17px">Plan ${esc(planDe(me).nombre)}</h2><span class="chip ${e.cls}">${esc(e.txt)}</span></div>
        <div class="plan"><span>${esc(planDe(me).lema||"")}</span><b class="num">${planDe(me).prueba?"Gratis":dinero(me.cuota)}</b></div>
        <button type="button" class="btn" data-v="planes">Ver planes y cambiar</button>
        <dl class="kv"><dt>Alta</dt><dd>${me.inicio?esc(fechaLarga(me.inicio)):"—"}</dd><dt>Próximo pago</dt><dd>${me.proximoPago?esc(fechaLarga(me.proximoPago)):"—"}</dd></dl>
      </div>
    </section>
    ${pintarCambio(false)}
  </div>`;
}


/* ================= selector desplegable propio =================
   Reemplaza visualmente cada <select class="input">; el select real sigue
   en el DOM (oculto) y es quien guarda el valor y dispara "change". */
let selAbierto = null;
function cerrarSel(){ if(!selAbierto) return; selAbierto.classList.remove("abierto"); selAbierto.querySelector(".sel-btn").setAttribute("aria-expanded","false"); selAbierto=null; }
document.addEventListener("click", e=>{ if(selAbierto && !e.composedPath().includes(selAbierto)) cerrarSel(); });
function mejorarSelects(raiz=document){
  raiz.querySelectorAll("select.input:not([data-mejorado])").forEach(sel=>{
    sel.dataset.mejorado="1";
    const caja=document.createElement("div"); caja.className="sel"; if(sel.style.flex) caja.style.flex=sel.style.flex;
    const lid="lst-"+(sel.id||randHex(3));
    caja.innerHTML=`<button type="button" class="sel-btn" aria-haspopup="listbox" aria-expanded="false" aria-controls="${lid}"><span class="sel-val"></span><svg class="sel-flecha" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button><div class="sel-list" role="listbox" id="${lid}" tabindex="-1"></div>`;
    sel.after(caja); caja.prepend(sel); sel.hidden=true; sel.tabIndex=-1;
    if(sel.getAttribute("aria-label")) caja.querySelector(".sel-btn").setAttribute("aria-label", sel.getAttribute("aria-label"));
    else if(sel.id){ const lab=document.querySelector(`label[for="${sel.id}"] > span`); if(lab) caja.querySelector(".sel-btn").setAttribute("aria-label", lab.textContent); }
    const btn=caja.querySelector(".sel-btn"), lista=caja.querySelector(".sel-list"), val=caja.querySelector(".sel-val");
    const marca = o => o.dataset.color ? `<i class="sel-dot" style="background:${esc(o.dataset.color)}"></i>` : "";
    const pintar = () => {
      const o = sel.options[sel.selectedIndex];
      val.innerHTML = o ? marca(o)+`<span>${esc(o.textContent)}</span>` : "";
      lista.innerHTML = [...sel.options].map((op,i)=>`<div class="sel-op" role="option" id="${lid}-${i}" data-i="${i}" aria-selected="${i===sel.selectedIndex}">${marca(op)}<span>${esc(op.textContent)}</span><svg class="sel-ok" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>`).join("");
    };
    let activo = -1;
    const resaltar = i => { activo=Math.max(0,Math.min(sel.options.length-1,i)); lista.querySelectorAll(".sel-op").forEach((el,k)=>el.classList.toggle("activa",k===activo)); const el=lista.children[activo]; el?.scrollIntoView({block:"nearest"}); lista.setAttribute("aria-activedescendant", el?.id||""); };
    const abrir = () => { cerrarSel(); pintar(); caja.classList.add("abierto"); btn.setAttribute("aria-expanded","true"); selAbierto=caja; lista.focus(); resaltar(sel.selectedIndex); };
    const elegir = i => { if(i!==sel.selectedIndex){ sel.selectedIndex=i; sel.dispatchEvent(new Event("change",{bubbles:true})); } pintar(); cerrarSel(); btn.focus(); };
    btn.addEventListener("click",()=> caja.classList.contains("abierto") ? cerrarSel() : abrir());
    btn.addEventListener("keydown",e=>{ if(["ArrowDown","ArrowUp","Enter"," "].includes(e.key)){ e.preventDefault(); abrir(); } });
    lista.addEventListener("click",e=>{ const op=e.target.closest(".sel-op"); if(op) elegir(Number(op.dataset.i)); });
    lista.addEventListener("keydown",e=>{
      if(e.key==="ArrowDown"){ e.preventDefault(); resaltar(activo+1); }
      else if(e.key==="ArrowUp"){ e.preventDefault(); resaltar(activo-1); }
      else if(e.key==="Home"){ e.preventDefault(); resaltar(0); }
      else if(e.key==="End"){ e.preventDefault(); resaltar(sel.options.length-1); }
      else if(e.key==="Enter"||e.key===" "){ e.preventDefault(); elegir(activo); }
      else if(e.key==="Escape"||e.key==="Tab"){ e.stopPropagation(); cerrarSel(); btn.focus(); }
    });
    sel.addEventListener("change", pintar);
    pintar();
  });
}

/* ================= selector de archivo con diseño =================
   Envuelve cada <input type="file" class="input"> en una zona para soltar
   o elegir el archivo; muestra nombre, tipo y peso del archivo elegido. */
function pesoLegible(b){ return b<1024*1024 ? `${Math.max(1,Math.round(b/1024))} KB` : `${(b/1048576).toFixed(1)} MB`; }
function mejorarArchivos(raiz=document){
  raiz.querySelectorAll('input[type="file"].input:not([data-mejorado])').forEach(inp=>{
    inp.dataset.mejorado="1";
    const acepta = (inp.accept||"").includes("pdf") ? "Imagen o PDF" : "Imagen";
    const zona=document.createElement("div"); zona.className="subir";
    zona.innerHTML=`<span class="subir-ico" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg></span>
      <span class="subir-txt"><b>Elige o arrastra un archivo</b><small>${acepta} · máximo ${acepta==="Imagen"?"12 MB":"1.5 MB en PDF"}</small></span>
      <span class="subir-elegido" hidden><span class="subir-tipo"></span><span class="subir-nom"></span><button type="button" class="subir-quitar" aria-label="Quitar archivo">${ICON.cerrar}</button></span>`;
    inp.after(zona); zona.prepend(inp); inp.classList.add("subir-input");
    const pintar=()=>{ const f=inp.files?.[0]; zona.classList.toggle("lleno",!!f);
      zona.querySelector(".subir-txt").hidden=!!f; const el=zona.querySelector(".subir-elegido"); el.hidden=!f;
      if(f){ zona.querySelector(".subir-tipo").textContent = f.type==="application/pdf"?"PDF":"IMG"; zona.querySelector(".subir-nom").textContent=`${f.name} · ${pesoLegible(f.size)}`; } };
    inp.addEventListener("change",pintar);
    zona.querySelector(".subir-quitar").addEventListener("click",e=>{ e.preventDefault(); e.stopPropagation(); inp.value=""; pintar(); });
    ["dragenter","dragover"].forEach(ev=>zona.addEventListener(ev,e=>{ e.preventDefault(); zona.classList.add("arrastrando"); }));
    ["dragleave","drop"].forEach(ev=>zona.addEventListener(ev,()=>zona.classList.remove("arrastrando")));
    zona.addEventListener("drop",e=>{ e.preventDefault(); const f=e.dataTransfer?.files; if(f?.length){ inp.files=f; pintar(); } });
  });
}

/* ================= mostrar / ocultar contraseña =================
   Todo campo de contraseña lleva un botón para ver lo que se escribe. */
const OJO = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const OJO_NO = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A9.6 9.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.5 9.5 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
function ojitos(raiz=document){
  raiz.querySelectorAll('input[type="password"]:not([data-ojo])').forEach(inp=>{
    inp.dataset.ojo="1";
    let caja = inp.closest(".pw");
    if(!caja){ caja=document.createElement("span"); caja.className="pw"; inp.after(caja); caja.appendChild(inp); }
    let btn = caja.querySelector("button");
    if(!btn){ btn=document.createElement("button"); btn.type="button"; caja.appendChild(btn); }
    btn.className="pw-ojo";
    const pintar = () => { const v = inp.type==="text"; btn.innerHTML = (v?OJO_NO:OJO) + `<span>${v?"Ocultar":"Mostrar"}</span>`; btn.setAttribute("aria-label", v?"Ocultar contraseña":"Mostrar contraseña"); btn.setAttribute("aria-pressed", String(v)); };
    btn.onclick = () => { inp.type = inp.type==="password" ? "text" : "password"; pintar(); inp.focus(); };
    pintar();
  });
}

/* ================= eventos por vista ================= */
function enlazar(){
  const v = $("#view");
  v.querySelectorAll("[data-ticket]").forEach(b=>b.addEventListener("click",()=>abrirTicket(b.dataset.ticket)));
  v.querySelectorAll("[data-nuevo-doc]").forEach(b=>b.addEventListener("click",()=>formDoctor()));
  v.querySelectorAll("[data-edit-doc]").forEach(b=>b.addEventListener("click",()=>formDoctor(docById(b.dataset.editDoc))));
  v.querySelectorAll("[data-pago]").forEach(b=>b.addEventListener("click",()=>registrarPago(b.dataset.pago)));
  v.querySelectorAll("[data-pausa]").forEach(b=>b.addEventListener("click",()=>pausar(b.dataset.pausa)));
  v.querySelectorAll("[data-agdoc]").forEach(b=>b.addEventListener("click",()=>{ guardarBorrador(); S.ag={...S.ag, doctorId:b.dataset.agdoc,fecha:"",hora:"",scroll:0}; render(); }));
  { const tira=v.querySelector(".days"); if(tira && S.ag.scroll!=null){ tira.scrollLeft=S.ag.scroll; } }
  v.querySelectorAll("[data-agfecha]").forEach(b=>b.addEventListener("click",()=>{ guardarBorrador(); const tira=b.closest(".days"); S.ag.scroll = tira ? tira.scrollLeft : null; const y=window.scrollY; S.ag.fecha=b.dataset.agfecha; requestAnimationFrame(()=>window.scrollTo({top:y})); S.ag.mes=S.ag.fecha.slice(0,7)+"-01"; S.ag.hora=""; render(); }));
  v.querySelectorAll("[data-agvista]").forEach(b=>b.addEventListener("click",()=>{ guardarBorrador(); S.ag.vista=b.dataset.agvista; S.ag.mes=(S.ag.fecha||hoy()).slice(0,7)+"-01"; render(); }));
  v.querySelectorAll("[data-agmes]").forEach(b=>b.addEventListener("click",()=>{ guardarBorrador(); const f=fromYmd(S.ag.mes||hoy().slice(0,7)+"-01"); f.setDate(1); f.setMonth(f.getMonth()+Number(b.dataset.agmes)); S.ag.mes=ymd(f); render(); }));
  v.querySelectorAll("[data-aghora]").forEach(b=>b.addEventListener("click",()=>{ S.ag.hora=b.dataset.aghora; v.querySelectorAll("[data-aghora]").forEach(o=>o.setAttribute("aria-pressed",String(o===b))); $("#agMsg").textContent=""; const he=$("#agHoraExacta"); if(he) he.value=""; pintarHoraElegida(); }));
  $("#agUsarHora")?.addEventListener("click",()=>{
    const x=docById(S.ag.doctorId), h=$("#agHoraExacta").value, info=$("#agHoraInfo");
    const no = conflicto(x, S.ag.fecha, h);
    if(no){ info.innerHTML=""; info.textContent=no; info.className="hora-elegida error"; return; }
    S.ag.hora=h; v.querySelectorAll("[data-aghora]").forEach(o=>o.setAttribute("aria-pressed",String(o.dataset.aghora===h))); info.className="hora-elegida"; pintarHoraElegida(); $("#agMsg").textContent="";
  });
  $("#agHoraExacta")?.addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); $("#agUsarHora").click(); } });
  v.querySelectorAll("[data-aviso-ok]").forEach(b=>b.addEventListener("click",()=>intentar(()=>{ exigir("admin"); const c=d().citas.find(o=>o.id===b.dataset.avisoOk); if(!c) return; c.avisoPendiente=false; c.avisado=new Date().toISOString(); bitacora("Paciente avisado de cancelación", `${c.folio} · ${c.paciente?.nombre}`); Store.guardar(); render(); toast("Marcado como avisado"); })));
  v.querySelectorAll("[data-reubicar]").forEach(b=>b.addEventListener("click",()=>{ const c=d().citas.find(o=>o.id===b.dataset.reubicar); if(!c) return; const no=puede(docById(c.doctorId),"reagendar"); if(no) return toast(no); reagendar(c, true); }));
  v.querySelectorAll("[data-ver-consulta]").forEach(b=>b.addEventListener("click",()=>verConsulta(b.dataset.verConsulta)));
  v.querySelectorAll("[data-receta-pdf]").forEach(b=>b.addEventListener("click",()=>{ const c=d().citas.find(o=>o.id===b.dataset.recetaPdf); if(c) pdfReceta(c); }));
  v.querySelectorAll("[data-receta-ok]").forEach(b=>b.addEventListener("click",()=>intentar(async()=>{ exigir("admin"); const c=d().citas.find(o=>o.id===b.dataset.recetaOk); if(!c) return; c.recetaPendiente=false; c.recetaEnviada=new Date().toISOString(); if(await Store.guardar()){ bitacora("Receta enviada al paciente", `${c.folio} · ${c.paciente?.nombre}`); render(); toast("Marcada como enviada"); } })));
  $("#bancoEditar")?.addEventListener("click", editarBanco);
  v.querySelectorAll("[data-plan-edit]").forEach(b=>b.addEventListener("click",()=>formPlan(planPorId(b.dataset.planEdit))));
  v.querySelectorAll("[data-plan-nuevo]").forEach(b=>b.addEventListener("click",()=>formPlan()));
  v.querySelectorAll("[data-sol-si]").forEach(b=>b.addEventListener("click",()=>resolverSolicitud(b.dataset.solSi,true)));
  v.querySelectorAll("[data-sol-no]").forEach(b=>b.addEventListener("click",()=>confirmar("Rechazar solicitud","El médico verá que su solicitud no se aprobó.",()=>resolverSolicitud(b.dataset.solNo,false),true)));
  v.querySelectorAll("[data-sol-plan]").forEach(b=>b.addEventListener("click",()=>solicitarPlan(b.dataset.solPlan)));
  v.querySelectorAll("[data-sol-cancelar]").forEach(b=>b.addEventListener("click",()=>intentar(()=>{ const o=d().solicitudes.find(x=>x.id===b.dataset.solCancelar); const me=miDoctor(); if(!o||!me||o.doctorId!==me.id) return; d().solicitudes=d().solicitudes.filter(x=>x!==o); bitacora("Solicitud de plan cancelada", me.nombre); Store.guardar(); render(); toast("Solicitud cancelada"); })));
  v.querySelectorAll("[data-fest]").forEach(b=>b.addEventListener("click",()=>{ S.filtro.estado=b.dataset.fest; render(); }));
  const fq=$("#fq"); if(fq) fq.addEventListener("input",()=>{ S.filtro.q=fq.value; const p=fq.selectionStart; render(); const n=$("#fq"); n.focus(); n.setSelectionRange(p,p); });
  const fd=$("#fdoc"); if(fd) fd.addEventListener("change",()=>{ S.filtro.doctor=fd.value; render(); });
  const fa=$("#fAgenda"); if(fa){ restaurarBorrador(); fa.addEventListener("submit",agendar); fa.addEventListener("input",guardarBorrador); }
  const vg=$("#vgo"); if(vg){ vg.addEventListener("click",verificar); $("#vq").addEventListener("keydown",e=>{ if(e.key==="Enter") verificar(); }); }
  $("#scanGo")?.addEventListener("click",()=>Escaner.iniciar());
  $("#scanStop")?.addEventListener("click",()=>Escaner.detener());
  enlazarCambio();
  enlazarDisponibilidad();
  enlazarPerfil();
  enlazarMensajes();
  mejorarSelects($("#view"));
  mejorarArchivos($("#view"));
  ojitos($("#view"));
}
function pintarHoraElegida(){
  const info=$("#agHoraInfo"); if(!info) return; const x=docById(S.ag.doctorId);
  info.innerHTML = S.ag.hora ? `Hora elegida: <b class="num">${esc(h12(S.ag.hora))}</b> · termina ${esc(h12(hhmm(minutos(S.ag.hora)+Number(x?.horario?.duracion||30))))}` : "";
}
const CAMPOS_P = ["pNombre","pTel","pEdad","pMotivo","pNotas"];
const BORRADOR = "enlace-clinico:borrador";
function guardarBorrador(){ try{ const o={}; CAMPOS_P.forEach(k=>{ const el=document.getElementById(k); if(el) o[k]=el.value; }); sessionStorage.setItem(BORRADOR,JSON.stringify(o)); }catch(e){} }
function restaurarBorrador(){ try{ const o=JSON.parse(sessionStorage.getItem(BORRADOR)||"{}"); CAMPOS_P.forEach(k=>{ const el=document.getElementById(k); if(el && o[k]) el.value=o[k]; }); }catch(e){} }

/* ================= acciones ================= */
function intentar(fn){ try{ return fn(); }catch(e){ toast(e.message || "No se pudo completar la acción."); return null; } }

async function agendar(ev){
  ev.preventDefault();
  const msg=$("#agMsg");
  try{ exigir("admin"); }catch(e){ return toast(e.message); }
  const nombre=limpiar($("#pNombre").value,90), tel=limpiar($("#pTel").value,20), edad=$("#pEdad").value.trim();
  if(!S.ag.hora){ msg.textContent="Elige una hora disponible."; return; }
  if(nombre.length<3){ msg.textContent="Escribe el nombre completo del paciente."; $("#pNombre").focus(); return; }
  if(tel && !/^[\d\s()+-]{7,20}$/.test(tel)){ msg.textContent="El teléfono solo puede llevar números, espacios y ( ) + -."; $("#pTel").focus(); return; }
  if(edad && (Number(edad)<0 || Number(edad)>120)){ msg.textContent="Revisa la edad."; return; }
  Store.cargar();   // por si otra pestaña agendó mientras tanto
  { const no = puede(docById(S.ag.doctorId), "agendar"); if(no){ msg.textContent = no; return; } }
  { const no = conflicto(docById(S.ag.doctorId), S.ag.fecha, S.ag.hora); if(no){ msg.textContent = no; return; } }
  const c = { id:"cit-"+randHex(6), folio:nuevoFolio(), token:randHex(8), doctorId:S.ag.doctorId, fecha:S.ag.fecha, hora:S.ag.hora, duracion:Number(docById(S.ag.doctorId)?.horario?.duracion||30), estado:"confirmada",
    paciente:{ nombre, telefono:tel, edad, motivo:limpiar($("#pMotivo").value,90) }, notas:limpiarTexto($("#pNotas").value,600), creado:new Date().toISOString(), creadoPor:S.usuario.usuario };
  d().citas.push(c);
  const btn = ev.submitter || $("#fAgenda button[type=submit]"); if(btn){ btn.disabled=true; btn.textContent="Agendando…"; }
  const ok = await Store.guardar();
  if(btn){ btn.disabled=false; btn.textContent="Agendar y generar ticket"; }
  if(!ok) return;
  const guardada = d().citas.find(o=>o.id===c.id);
  bitacora("Cita agendada", `${guardada.folio} · ${docById(c.doctorId)?.nombre} · ${c.fecha} ${c.hora}`);
  try{ sessionStorage.removeItem(BORRADOR); }catch(e){}
  S.ag.hora=""; render(); citaCreada(guardada);
}

function registrarPago(id){ intentar(()=>{
  exigir("admin"); const x=docById(id); if(!x) return;
  const base = x.proximoPago && x.proximoPago>hoy() ? x.proximoPago : hoy();
  x.proximoPago=addMonths(base,1); x.estado="activa"; x.ultimoPago=hoy();
  bitacora("Pago registrado", `${x.nombre} · ${dinero(x.cuota)} · siguiente ${x.proximoPago}`); Store.guardar(); render(); toast(`Pago registrado: ${x.nombre}`);
}); }
function pausar(id){ intentar(()=>{
  exigir("admin"); const x=docById(id); if(!x) return;
  x.estado = x.estado==="pausada" ? "activa" : "pausada";
  bitacora(x.estado==="pausada"?"Suscripción pausada":"Suscripción reactivada", x.nombre); Store.guardar(); render(); toast(x.estado==="pausada"?"Suscripción pausada":"Suscripción reactivada");
}); }
function cambiarEstadoCita(id, estado){ intentar(()=>{
  const c=d().citas.find(o=>o.id===id); if(!c) return;
  if(estado==="atendida") exigir("medico", c.doctorId); else exigir("admin");
  if(estado==="confirmada"){ const no=conflicto(docById(c.doctorId),c.fecha,c.hora,c.id,durCita(c,docById(c.doctorId))); if(no) throw new Error(no); }
  c.estado=estado; c.actualizado=new Date().toISOString();
  bitacora(`Cita ${estado}`, `${c.folio} · ${c.paciente?.nombre}`); Store.guardar(); cerrarCapa(); render();
  toast(estado==="atendida"?"Cita marcada como atendida":estado==="cancelada"?"Cita cancelada":"Cita confirmada");
}); }

/* ================= capas ================= */
let focoPrevio=null;
function capa(html){
  focoPrevio=document.activeElement;
  $("#layer").innerHTML = `<div class="overlay" id="ov">${html}</div>`; const ov=$("#ov");
  ov.addEventListener("click",e=>{ if(e.target===ov) cerrarCapa(); }); ov.querySelectorAll("[data-cerrar]").forEach(b=>b.addEventListener("click",cerrarCapa));
  document.body.style.overflow="hidden";
  mejorarSelects(ov);
  mejorarArchivos(ov);
  setTimeout(()=>ov.querySelector("input,select,textarea,button:not(.x)")?.focus(),40);
}
function cerrarCapa(){ $("#layer").innerHTML=""; document.body.style.overflow=""; focoPrevio?.focus?.(); }
document.addEventListener("keydown",e=>{ if(e.key!=="Escape") return; if(selAbierto){ cerrarSel(); return; } if($("#ov")) cerrarCapa(); });
function confirmar(titulo, texto, accion, peligro){
  capa(`<div class="modal flotante" role="dialog" aria-modal="true" aria-labelledby="cfT" style="width:min(460px,100%)"><div class="modal-h"><h2 id="cfT">${esc(titulo)}</h2><button type="button" class="x" data-cerrar aria-label="Cerrar">${ICON.cerrar}</button></div><div class="modal-b"><p style="margin:0">${esc(texto)}</p></div><div class="modal-f"><button type="button" class="btn" data-cerrar>Volver</button><button type="button" class="btn ${peligro?"btn-danger":"btn-primary"}" id="cfOk">Confirmar</button></div></div>`);
  $("#cfOk").addEventListener("click",()=>{ cerrarCapa(); accion(); });
}

/* ----- ticket ----- */
function htmlPase(c){
  const x = docById(c.doctorId) || {nombre:"Médico", especialidad:"", consultorio:""};
  const marcaBlanca = ICON.marca.replace('stroke="currentColor"','stroke="#fff"').replace('width="18" height="18"','width="13" height="13"');
  return `<div class="pass" id="pase">
    <div class="pass-main">
      <div class="pass-top"><div class="pass-brand"><img src="assets/logo-a-negro.png" alt="" class="pass-logo">ASSISTANT</div><span class="pass-status ${esc(c.estado)}">${c.estado==="confirmada"?"Cita confirmada":c.estado==="atendida"?"Atendida":"Cancelada"}</span></div>
      <div><div class="pass-kind">Paciente</div><div class="pass-patient">${esc(c.paciente?.nombre)}</div></div>
      <div class="pass-grid">
        <div class="pass-big"><span>Fecha</span><b>${esc(fromYmd(c.fecha).toLocaleDateString("es-MX",{day:"2-digit",month:"short",year:"numeric"}))}</b></div>
        <div class="pass-big"><span>Hora</span><b>${esc(h12(c.hora))} h</b></div>
        <div><span>Médico</span><b>${esc(x.nombre)}</b></div>
        <div><span>Especialidad</span><b>${esc(x.especialidad||"—")}</b></div>
        <div><span>Consultorio</span><b>${esc(x.consultorio||"—")}</b></div>
        <div><span>Dirección</span><b>${esc(x.direccion||"—")}</b></div>
        <div><span>Motivo</span><b>${esc(c.paciente?.motivo||"Consulta")}</b></div>
        <div><span>Teléfono del consultorio</span><b>${esc(x.telefono||"—")}</b></div>
      </div>
      ${c.notas?`<div class="pass-notes"><span>Notas de recepción</span>${esc(c.notas)}</div>`:""}
    </div>
    <div class="pass-stub">
      <div class="pass-qr"><img alt="Código QR del ticket ${esc(c.folio)}" src="${qrPng(qrTexto(c),480)}"></div>
      <div><div class="pass-folio">${esc(c.folio)}</div><small>Presenta este código en recepción.<br>Ticket único y verificable.</small></div>
      <div class="pass-hash">HMAC ${esc((c.firma||"").slice(0,16))}</div>
    </div>
  </div>`;
}
function abrirTicket(id){
  const c = d().citas.find(o=>o.id===id); if(!c) return;
  if(!esAdmin() && c.doctorId!==S.usuario.doctorId) return toast("Esta cita no pertenece a tu consultorio.");
  const adm = esAdmin();
  capa(`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="tkT">
    <div class="modal-h"><div><h2 id="tkT">Ticket ${esc(c.folio)}</h2><div class="note">Agendado ${esc(fechaHora(c.creado))}${c.creadoPor?` por @${esc(c.creadoPor)}`:""}</div></div><button type="button" class="x" data-cerrar aria-label="Cerrar">${ICON.cerrar}</button></div>
    <div class="modal-b"><div class="ticket-stage">${htmlPase(c)}</div>
      ${c.folioTemporal && new Date(c.folioTemporal.expira) > new Date() ? `<div class="folio-temp">${ICON.reloj}<span>Folio temporal <b class="mono">${esc(c.folioTemporal.codigo)}</b> · válido hasta las ${esc(h12(`${pad(new Date(c.folioTemporal.expira).getHours())}:${pad(new Date(c.folioTemporal.expira).getMinutes())}`))}</span><button type="button" class="btn btn-sm" data-copiar-temp="${esc(c.folioTemporal.codigo)}">Copiar</button></div>` : ""}
      ${adm?`<dl class="kv"><dt>Tel. paciente</dt><dd class="num">${esc(c.paciente?.telefono||"—")}</dd><dt>Edad</dt><dd>${esc(c.paciente?.edad||"—")}</dd></dl>`:`<dl class="kv"><dt>Tel. paciente</dt><dd class="num">${esc(c.paciente?.telefono||"—")}</dd><dt>Edad</dt><dd>${esc(c.paciente?.edad||"—")}</dd></dl>`}
    </div>
    <div class="modal-f">
      ${adm && c.estado!=="cancelada" ? `<button type="button" class="btn btn-danger" id="tkCancel">Cancelar</button>` : ""}
      ${adm && c.estado==="confirmada" ? `<button type="button" class="btn" id="tkMover">Reagendar</button>` : ""}
      ${adm && c.estado==="confirmada" ? `<button type="button" class="btn" id="tkDone">Marcar atendida</button>` : ""}
      ${adm && c.estado!=="confirmada" ? `<button type="button" class="btn" id="tkRe">Volver a confirmar</button>` : ""}
      ${adm && c.estado==="confirmada" && !c.usado ? `<button type="button" class="btn" id="tkTemp">${ICON.reloj}Folio temporal</button>` : ""}
      ${!adm && c.estado==="confirmada" ? `<button type="button" class="btn btn-danger" id="tkCancelMed">Cancelar</button><button type="button" class="btn" id="tkHoraMed">Cambiar hora</button><button type="button" class="btn btn-primary" id="tkConsulta">${c.enConsulta?"Continuar consulta":"Pasar a consulta"}</button>` : ""}
      ${c.consulta ? `<button type="button" class="btn" id="tkVerConsulta">Ver consulta</button>` : ""}
      <button type="button" class="btn" id="tkPng">${ICON.png}Imagen</button>
      <button type="button" class="btn btn-primary" id="tkPdf">${ICON.pdf}PDF</button>
    </div></div>`);
  const noDesc = puede(docById(c.doctorId),"descargas");
  $("#tkPng").addEventListener("click",()=> noDesc ? toast(noDesc) : descargarPng(c));
  $("#tkPdf").addEventListener("click",()=> noDesc ? toast(noDesc) : descargarPdf(c));
  $("#tkCancel")?.addEventListener("click",()=>confirmar("Cancelar cita",`Se cancelará la cita de ${c.paciente?.nombre} y se liberará el horario.`,()=>cambiarEstadoCita(c.id,"cancelada"),true));
  $("#tkDone")?.addEventListener("click",()=>cambiarEstadoCita(c.id,"atendida"));
  $("#tkRe")?.addEventListener("click",()=>cambiarEstadoCita(c.id,"confirmada"));
  $("#tkMover")?.addEventListener("click",()=>{ const no=puede(docById(c.doctorId),"reagendar"); no ? toast(no) : reagendar(c); });
  $("#tkTemp")?.addEventListener("click", async()=>{ try{ const r = await Store.api("POST",`/citas/${encodeURIComponent(c.id)}/folio-temporal`,undefined,{texto:"Generando folio temporal…"}); const i=d().citas.findIndex(o=>o.id===c.id); if(i>=0) d().citas[i]=r.data; await Store.cargar({silencioso:true}); abrirTicket(c.id); toast(`Folio temporal ${r.data.folioTemporal.codigo} (1 hora)`); }catch(e){ toast(e.message); } });
  document.querySelector("[data-copiar-temp]")?.addEventListener("click",async e=>{ try{ await navigator.clipboard.writeText(e.currentTarget.dataset.copiarTemp); toast("Folio copiado"); }catch(_){ toast("Selecciona el folio y cópialo"); } });
  $("#tkConsulta")?.addEventListener("click",()=>abrirConsulta(c.id));
  $("#tkHoraMed")?.addEventListener("click",()=>reagendar(c));
  $("#tkCancelMed")?.addEventListener("click",()=>cancelarConMotivo(c));
  $("#tkVerConsulta")?.addEventListener("click",()=>verConsulta(c.id));
}
function reagendar(c, desdeAviso){
  const x = docById(c.doctorId); let fecha=c.fecha, hora="";
  const dias = Array.from({length:60},(_,i)=>addDays(hoy(),i));
  const pintar = () => {
    $("#rgDias").innerHTML = dias.map(f=>{ const fd=fromYmd(f); const ok=horarios(x,f,c.id).some(h=>h.libre); return `<button type="button" data-f="${f}" aria-pressed="${f===fecha}" ${ok?"":"disabled"}><small>${DIAS[fd.getDay()]}</small><b class="num">${fd.getDate()}</b><small>${esc(fd.toLocaleDateString("es-MX",{month:"short"}))}</small></button>`; }).join("");
    const s=horarios(x,fecha,c.id); $("#rgHoras").innerHTML = s.length ? s.map(h=>`<button type="button" data-h="${h.hora}" aria-pressed="${h.hora===hora}" ${h.libre?"":"disabled"}>${h12(h.hora)}</button>`).join("") : `<p class="note">No atiende este día.</p>`;
  };
  capa(`<div class="modal flotante" role="dialog" aria-modal="true" aria-labelledby="rgT"><div class="modal-h"><h2 id="rgT">${esAdmin()?"Reagendar":"Cambiar hora de"} ${esc(c.folio)}</h2><button type="button" class="x" data-cerrar aria-label="Cerrar">${ICON.cerrar}</button></div>
    <div class="modal-b"><p class="note" style="margin:0">${esc(c.paciente?.nombre)} con ${esc(x?.nombre)}. Al reagendar se genera un nuevo folio y QR; el ticket anterior deja de ser válido.</p><div class="days" id="rgDias"></div><div class="pick" id="rgHoras"></div></div>
    <div class="modal-f"><span class="note" id="rgMsg" role="status" style="margin-right:auto;align-self:center"></span><button type="button" class="btn" data-cerrar>Cancelar</button><button type="button" class="btn btn-primary" id="rgOk">Guardar nuevo horario</button></div></div>`);
  pintar();
  $("#rgDias").addEventListener("click",e=>{ const b=e.target.closest("[data-f]"); if(b){ fecha=b.dataset.f; hora=""; pintar(); } });
  $("#rgHoras").addEventListener("click",e=>{ const b=e.target.closest("[data-h]"); if(b){ hora=b.dataset.h; pintar(); } });
  $("#rgOk").addEventListener("click", async()=>{
    try{ esAdmin() ? exigir("admin") : exigir("medico", c.doctorId); }catch(e){ return toast(e.message); }
    if(!hora){ $("#rgMsg").textContent="Elige la nueva hora."; return; }
    { const no=conflicto(docById(c.doctorId),fecha,hora,c.id,durCita(c,docById(c.doctorId))); if(no){ $("#rgMsg").textContent=no; return; } }
    const antes=`${c.fecha} ${c.hora}`; c.fecha=fecha; c.hora=hora; if(desdeAviso){ c.estado="confirmada"; c.avisoPendiente=false; delete c.motivoCancelacion; } if(esAdmin()) c.folio=nuevoFolio(); c.actualizado=new Date().toISOString();
    if(!(await Store.guardar())) return;
    bitacora("Cita reagendada", `${c.folio} · de ${antes} a ${fecha} ${hora}`); render(); toast("Cita reagendada; se generó un ticket nuevo"); abrirTicket(c.id);
  });
}

function descargar(nombre, blob){
  const url = URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download=nombre; a.rel="noopener"; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),4000); toast("Descarga lista");
}
async function descargarPng(c){
  const el = $("#pase"); if(!el) return;
  try{ const cv = await html2canvas(el,{scale:3,backgroundColor:"#ffffff",logging:false}); cv.toBlob(b=>descargar(`Ticket ${c.folio}.png`, b), "image/png"); }
  catch(e){ toast("No se pudo generar la imagen."); }
}
function descargarPdf(c){
  const { jsPDF } = window.jspdf; const x = docById(c.doctorId) || {};
  const pdf = new jsPDF({unit:"mm", format:[210,99], orientation:"landscape"});
  pdf.setProperties({title:`Ticket ${c.folio}`, subject:"Cita médica", creator:"Assistant"});
  const W=210, H=99, stub=62, verde=[11,122,99], tinta=[16,36,42], gris=[126,146,152], crema=[247,231,198], cafe=[90,62,12];
  pdf.setFillColor(255,255,255); pdf.rect(0,0,W,H,"F");
  pdf.setFillColor(...verde); pdf.rect(0,0,W-stub,4,"F");
  pdf.setFillColor(...crema); pdf.rect(W-stub,0,stub,H,"F");
  pdf.setDrawColor(...cafe); pdf.setLineDashPattern([1.2,1.4],0); pdf.setLineWidth(.4); pdf.line(W-stub,6,W-stub,H-6); pdf.setLineDashPattern([],0);
  pdf.setFillColor(...verde); pdf.roundedRect(10,10,7,7,1.6,1.6,"F"); if(MARCA_PNG) pdf.addImage(MARCA_PNG,"PNG",10.6,10.6,5.8,5.8);
  pdf.setTextColor(...verde); pdf.setFont("helvetica","bold"); pdf.setFontSize(12); pdf.text("Assistant",19.5,15.3);
  const est = c.estado==="confirmada"?"CITA CONFIRMADA":c.estado==="atendida"?"ATENDIDA":"CANCELADA";
  pdf.setFontSize(7); pdf.setTextColor(...(c.estado==="cancelada"?[180,52,45]:verde)); pdf.text(est,W-stub-10,14.6,{align:"right"});
  pdf.setTextColor(...gris); pdf.setFontSize(6.5); pdf.text("PACIENTE",10,26);
  pdf.setTextColor(...tinta); pdf.setFontSize(17); pdf.text(pdf.splitTextToSize(c.paciente?.nombre||"",W-stub-20)[0],10,33);
  const celdas = [["FECHA",fromYmd(c.fecha).toLocaleDateString("es-MX",{day:"2-digit",month:"short",year:"numeric"}),true],["HORA",h12(c.hora),true],
    ["MÉDICO",x.nombre||"—"],["ESPECIALIDAD",x.especialidad||"—"],["CONSULTORIO",x.consultorio||"—"],["DIRECCIÓN",x.direccion||"—"],["MOTIVO",c.paciente?.motivo||"Consulta"],["TELÉFONO DEL CONSULTORIO",x.telefono||"—"]];
  const colW=(W-stub-20)/2; let y=42;
  celdas.forEach(([k,v,big],i)=>{ const cx=10+(i%2)*colW; if(i%2===0 && i) y+= i<=2?11:8.5;
    pdf.setFont("helvetica","bold"); pdf.setFontSize(6); pdf.setTextColor(...gris); pdf.text(k,cx,y);
    pdf.setFont(big?"courier":"helvetica","bold"); pdf.setFontSize(big?13:8.5); pdf.setTextColor(...tinta); pdf.text(pdf.splitTextToSize(String(v),colW-4)[0],cx,y+(big?5.2:4)); });
  if(c.notas){ pdf.setDrawColor(220,229,226); pdf.setLineDashPattern([1,1],0); pdf.line(10,y+8,W-stub-10,y+8); pdf.setLineDashPattern([],0);
    pdf.setFont("helvetica","bold"); pdf.setFontSize(6); pdf.setTextColor(...gris); pdf.text("NOTAS DE RECEPCIÓN",10,y+12.5);
    pdf.setFont("helvetica","normal"); pdf.setFontSize(7.5); pdf.setTextColor(75,97,104); pdf.text(pdf.splitTextToSize(c.notas,W-stub-20).slice(0,2),10,y+16.5); }
  const qx=W-stub+(stub-40)/2; pdf.setFillColor(255,255,255); pdf.roundedRect(qx-2,9,44,44,2,2,"F"); pdf.addImage(qrPng(qrTexto(c),700),"PNG",qx,11,40,40);
  pdf.setTextColor(...cafe); pdf.setFont("courier","bold"); pdf.setFontSize(11.5); pdf.text(c.folio,W-stub/2,61,{align:"center"});
  pdf.setFont("helvetica","normal"); pdf.setFontSize(6.6); pdf.text(["Presenta este código en recepción.","Ticket único y verificable."],W-stub/2,67,{align:"center"});
  pdf.setFont("courier","normal"); pdf.setFontSize(5.4); pdf.text(pdf.splitTextToSize("HMAC-SHA256 "+(c.firma||""),stub-12),W-stub/2,77,{align:"center"});
  pdf.setTextColor(...gris); pdf.setFont("helvetica","normal"); pdf.setFontSize(5.8); pdf.text(`Emitido ${fechaHora(new Date().toISOString())} · Si se altera algún dato, el código deja de ser válido.`,10,H-6);
  descargar(`Ticket ${c.folio}.pdf`, pdf.output("blob"));
}

/* ----- verificar ----- */
function tarjetaVerificacion(tipo, titulo, texto, filas){
  const ico = { ok:'<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>', bad:'<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9.5 9.5l5 5M14.5 9.5l-5 5"/>', info:'<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M12 8v4.5M12 15.5h.01"/>' }[tipo];
  return `<article class="vcard ${tipo}">
    <header><span class="vcard-ico"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ico}</svg></span><div><b>${esc(titulo)}</b><p>${esc(texto)}</p></div></header>
    ${filas?.length?`<dl class="vcard-datos">${filas.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>`:""}
  </article>`;
}
async function verificar(){
  const entrada = $("#vq"), out=$("#vres"); const t = limpiar(entrada.value, 800); if(!t){ out.innerHTML=""; return; }
  const q = /^T-/i.test(t) ? { folio:t.toUpperCase() } : leerCodigo(t); if(q.folio) entrada.value = q.folio;
  out.innerHTML = `<p class="note" style="margin:0">Verificando…</p>`;
  try{
    const r = await Store.api("POST","/verificar",{ codigo:t },{texto:"Verificando el ticket…"});
    const c = r.cita;
    const filas = c ? [["Folio",c.folio],["Paciente",c.paciente||"—"],["Médico",c.medico||"—"],["Fecha",fechaLarga(c.fecha)],["Hora",h12(c.hora)],["Estado",c.estado==="confirmada"?"Confirmada":c.estado==="atendida"?"Atendida":"Cancelada"]] : null;
    out.innerHTML = tarjetaVerificacion(r.tipo==="ok"?"ok":"bad", r.titulo, r.texto, filas);
    if(r.tipo==="ok" && c?.id && !esAdmin()){
      await Store.cargar({silencioso:true});
      out.insertAdjacentHTML("beforeend", `<div class="verif-opciones"><button type="button" class="btn btn-primary" data-op="consulta">${ICON.estetoscopio}${c.enConsulta?"Continuar consulta":"Pasar a consulta"}</button><button type="button" class="btn" data-op="hora">${ICON.reloj}Cambiar de hora</button><button type="button" class="btn btn-danger" data-op="cancelar">Cancelar cita</button></div>`);
      out.querySelectorAll("[data-op]").forEach(b=>b.addEventListener("click",()=>{ const cita=d().citas.find(o=>o.id===c.id); if(!cita) return toast("Recarga la página e intenta de nuevo.");
        if(b.dataset.op==="consulta") abrirConsulta(cita.id); else if(b.dataset.op==="hora") reagendar(cita); else cancelarConMotivo(cita); }));
    }
  }catch(e){
    out.innerHTML = tarjetaVerificacion("bad", "No se pudo verificar", e.message);
  }
  out.scrollIntoView({behavior:"smooth", block:"nearest"});
}

/* ----- alta / edición de médico y su cuenta ----- */
function formDoctor(x){
  try{ exigir("admin"); }catch(e){ return toast(e.message); }
  const e = x || { nombre:"", especialidad:"", cedula:"", telefono:"", email:"", consultorio:"", direccion:"", costoConsulta:"", plan:"prueba", cuota:0, proximoPago:null, color:COLORES[d().doctores.length%COLORES.length], horario:{dias:[1,2,3,4,5], inicio:"09:00", fin:"17:00", duracion:30} };
  const u = x ? d().usuarios.find(o=>o.doctorId===x.id) : null;
  const sugerido = x ? "" : "";
  capa(`<form class="modal" id="fDoc" role="dialog" aria-modal="true" aria-labelledby="dT" novalidate>
    <div class="modal-h"><h2 id="dT">${x?"Editar médico":"Nuevo suscriptor"}</h2><button type="button" class="x" data-cerrar aria-label="Cerrar">${ICON.cerrar}</button></div>
    <div class="modal-b">
      <div class="grid2">
        <label class="field" for="dNombre"><span>Nombre</span><input class="input" id="dNombre" maxlength="80" value="${esc(e.nombre)}" placeholder="Dra. Ana López"></label>
        <label class="field" for="dEsp"><span>Especialidad</span><input class="input" id="dEsp" maxlength="60" value="${esc(e.especialidad)}" placeholder="Medicina general"></label>
        <label class="field" for="dCed"><span>Cédula profesional</span><input class="input" id="dCed" maxlength="12" inputmode="numeric" value="${esc(e.cedula||"")}"></label>
        <label class="field" for="dTel"><span>Teléfono de contacto</span><input class="input" id="dTel" maxlength="20" value="${esc(e.telefono||"")}" inputmode="tel"></label>
        <label class="field" for="dMail"><span>Correo</span><input class="input" id="dMail" maxlength="80" value="${esc(e.email||"")}" type="email"></label>
        <label class="field" for="dCosto"><span>Costo de consulta (MXN)</span><input class="input" id="dCosto" value="${esc(e.costoConsulta||"")}" type="number" min="0" max="100000"></label>
        <label class="field" for="dCons"><span>Consultorio</span><input class="input" id="dCons" maxlength="90" value="${esc(e.consultorio)}" placeholder="Torre Médica, consultorio 304"></label>
        <label class="field" for="dDir"><span>Dirección</span><input class="input" id="dDir" maxlength="120" value="${esc(e.direccion||"")}" placeholder="Calle, número, colonia, ciudad"></label>
      </div>
      <fieldset style="border:1px solid var(--line);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:12px;margin:0;min-width:0"><legend style="padding:0 6px;font-weight:700">Horario de atención</legend>
        <div class="pick" id="dDias">${[1,2,3,4,5,6,0].map(n=>`<button type="button" data-dia="${n}" aria-pressed="${(e.horario.dias||[]).includes(n)}" style="font-family:var(--f-body)">${DIAS[n]}</button>`).join("")}</div>
        <div class="grid3"><label class="field" for="dIni"><span>Desde</span><input class="input" id="dIni" type="time" value="${esc(e.horario.inicio)}"></label><label class="field" for="dFin"><span>Hasta</span><input class="input" id="dFin" type="time" value="${esc(e.horario.fin)}"></label><label class="field" for="dDur"><span>Duración</span><select class="input" id="dDur">${[15,20,30,45,60].map(m=>`<option value="${m}" ${Number(e.horario.duracion)===m?"selected":""}>${m} min</option>`).join("")}</select></label></div>
      </fieldset>
      <fieldset style="border:1px solid var(--line);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:12px;margin:0;min-width:0"><legend style="padding:0 6px;font-weight:700">Mensualidad</legend>
        <div class="grid3">
          <label class="field" for="dPlan"><span>Plan</span><select class="input" id="dPlan">${planes().filter(p=>p.activo||p.id===e.plan).map(p=>`<option value="${esc(p.id)}" ${e.plan===p.id?"selected":""}>${esc(p.nombre)}${p.prueba?` · ${p.dias||7} días`:` · ${dinero(p.precio)}`}</option>`).join("")}</select></label>
          <label class="field" for="dCuota"><span>Cuota mensual</span><input class="input" id="dCuota" type="number" min="0" max="100000" value="${esc(e.cuota)}"></label>
          <label class="field" for="dPago"><span>Próximo pago</span><input class="input" id="dPago" type="date" value="${esc(e.proximoPago||"")}"></label>
        </div>
      </fieldset>
      <fieldset style="border:1px solid var(--line);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:12px;margin:0;min-width:0"><legend style="padding:0 6px;font-weight:700">Cuenta de acceso del médico</legend>
        ${u ? `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="chip ${u.activo?"ok":"bad"}">@${esc(u.usuario)} · ${u.activo?"activa":"desactivada"}</span><span class="note">Último acceso: ${u.ultimoAcceso?esc(fechaHora(u.ultimoAcceso)):"nunca"}</span></div>
              <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn btn-sm" id="dReset">Generar contraseña temporal</button><button type="button" class="btn btn-sm" id="dToggle">${u.activo?"Desactivar acceso":"Reactivar acceso"}</button></div>
              <div id="dCred"></div>`
            : `<div class="grid2"><label class="field" for="dUser"><span>Usuario</span><input class="input mono" id="dUser" maxlength="32" autocapitalize="none" spellcheck="false" placeholder="dra.lopez"></label>
               <label class="field" for="dPass"><span>Contraseña temporal</span><input class="input mono" id="dPass" maxlength="64" value="${esc(passwordTemporal())}"></label></div>
               <p class="note" style="margin:0">El médico deberá cambiarla en su primer acceso. Usuario: 4 a 32 letras minúsculas, números, punto, guion.</p>`}
      </fieldset>
    </div>
    <div class="modal-f">${x?`<button type="button" class="btn btn-danger" id="dDel" style="margin-right:auto">Eliminar</button>`:""}<span class="note" id="dMsg" role="status" style="align-self:center"></span><button type="button" class="btn" data-cerrar>Cancelar</button><button type="submit" class="btn btn-primary">${x?"Guardar cambios":"Crear perfil y cuenta"}</button></div>
  </form>`);
  $("#dDias").addEventListener("click",ev=>{ const b=ev.target.closest("[data-dia]"); if(b) b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed")!=="true")); });
  $("#dPlan").addEventListener("change",ev=>{ const p=planPorId(ev.target.value); $("#dCuota").value = p.precio; $("#dPago").value = p.prueba ? "" : ($("#dPago").value || addMonths(hoy(),1)); });
  $("#dUser")?.addEventListener("input",ev=>{ ev.target.value = ev.target.value.toLowerCase().replace(/[^a-z0-9._-]/g,""); });
  $("#dReset")?.addEventListener("click", async()=>{
    try{ const r = await Store.api("POST",`/usuarios/${encodeURIComponent(u.id)}/reset`); mostrarCredenciales($("#dCred"), r.usuario, r.password); }catch(e){ toast(e.message); }
  });
  $("#dToggle")?.addEventListener("click", async()=>{ try{ await Store.api("PUT",`/usuarios/${encodeURIComponent(u.id)}`,{activo:!u.activo}); await Store.cargar(); cerrarCapa(); render(); toast(!u.activo?"Acceso reactivado":"Acceso desactivado"); }catch(e){ toast(e.message); } });
  $("#dDel")?.addEventListener("click",()=>{ const n=d().citas.filter(c=>c.doctorId===x.id && c.estado==="confirmada" && c.fecha>=hoy()).length;
    if(n) return confirmar("No se puede eliminar", `${x.nombre} tiene ${n} citas próximas. Cancélalas o reagéndalas primero.`, ()=>{}, false);
    confirmar("Eliminar médico", `Se eliminará el perfil de ${x.nombre} y su cuenta de acceso. Sus tickets anteriores se conservan.`, ()=>intentar(()=>{ exigir("admin"); d().doctores=d().doctores.filter(o=>o.id!==x.id); d().usuarios=d().usuarios.filter(o=>o.doctorId!==x.id); bitacora("Médico eliminado", x.nombre); Store.guardar(); render(); toast("Médico eliminado"); }), true); });
  $("#fDoc").addEventListener("submit", async ev=>{
    ev.preventDefault();
    const msg=$("#dMsg"); const err=m=>{ msg.textContent=m; msg.style.color="var(--bad)"; };
    try{ exigir("admin"); }catch(e2){ return err(e2.message); }
    const nombre=limpiar($("#dNombre").value,80), dias=[...document.querySelectorAll("#dDias [aria-pressed='true']")].map(b=>Number(b.dataset.dia));
    const mail=limpiar($("#dMail").value,80), tel=limpiar($("#dTel").value,20);
    if(nombre.length<3) return err("Escribe el nombre del médico.");
    if(mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return err("El correo no es válido.");
    if(tel && !/^[\d\s()+-]{7,20}$/.test(tel)) return err("El teléfono no es válido.");
    if(!dias.length) return err("Elige al menos un día de atención.");
    if(minutos($("#dFin").value)<=minutos($("#dIni").value)) return err("La hora final debe ser después de la inicial.");
    const datos = { nombre, especialidad:limpiar($("#dEsp").value,60)||"Medicina general", cedula:limpiar($("#dCed").value,12), telefono:tel, email:mail,
      costoConsulta:Math.max(0,Number($("#dCosto").value)||0), consultorio:limpiar($("#dCons").value,90)||"Por definir", direccion:limpiar($("#dDir").value,120),
      plan:planPorId($("#dPlan").value).id, cuota:Math.max(0,Number($("#dCuota").value)||0), proximoPago:$("#dPago").value||null,
      horario:{dias, inicio:$("#dIni").value, fin:$("#dFin").value, duracion:Number($("#dDur").value), horas:(x?.horario?.horas && x.horario.inicio===$("#dIni").value && x.horario.fin===$("#dFin").value) ? x.horario.horas : undefined} };
    if(!datos.horario.horas) delete datos.horario.horas;
    const pl = planPorId(datos.plan);
    if(pl.prueba){ datos.cuota=0; datos.proximoPago=null; if(!x || x.plan!==pl.id){ datos.pruebaInicio=new Date().toISOString(); datos.pruebaHasta=addDays(hoy(), pl.dias||7); } }
    else if(!datos.proximoPago) datos.proximoPago = addMonths(hoy(),1);
    if(x){ if(x.plan!==datos.plan) bitacora("Cambio de plan", `${x.nombre}: ${planDe(x).nombre} → ${pl.nombre}`); Object.assign(x, datos); if(!(await Store.guardar())) return; bitacora("Médico actualizado", x.nombre); cerrarCapa(); render(); return toast("Cambios guardados"); }
    const usuario=($("#dUser").value||"").trim(), pass=$("#dPass").value;
    if(!USUARIO_RE.test(usuario)) return err("Usuario inválido: 4 a 32 caracteres (a-z, 0-9, . _ -).");
    if(d().usuarios.some(o=>o.usuario===usuario)) return err("Ese usuario ya existe.");
    const v=validarPassword(pass); if(v) return err("Contraseña temporal: "+v);
    if(d().usuarios.some(o=>o.usuario===usuario)) return err("Ese usuario ya existe.");
    const id="doc-"+randHex(6);
    d().doctores.push({ id, ...datos, estado:"activa", inicio:hoy(), color:e.color, creado:new Date().toISOString() });
    if(!(await Store.guardar())) return;
    try{ await Store.api("POST","/usuarios",{ usuario, password:pass, doctorId:id }); }
    catch(e3){ d().doctores = d().doctores.filter(o=>o.id!==id); await Store.guardar(); return err(e3.message); }
    await Store.cargar();
    bitacora("Suscriptor creado", `${nombre} · @${usuario}`); render();
    capa(`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="okT" style="width:min(480px,100%)"><div class="modal-h"><h2 id="okT">Suscriptor creado</h2><button type="button" class="x" data-cerrar aria-label="Cerrar">${ICON.cerrar}</button></div><div class="modal-b"><p style="margin:0">Entrega estos datos a ${esc(nombre)}. La contraseña no se volverá a mostrar; el médico la cambiará en su primer acceso.</p><div id="okCred"></div></div><div class="modal-f"><button type="button" class="btn btn-primary" data-cerrar>Listo</button></div></div>`);
    mostrarCredenciales($("#okCred"), usuario, pass);
  });
}
function mostrarCredenciales(box, usuario, pass){
  box.innerHTML = `<div class="cred"><span>Usuario</span><code></code><button type="button" class="btn btn-sm" data-copiar="u">Copiar</button><span>Contraseña</span><code></code><button type="button" class="btn btn-sm" data-copiar="p">Copiar</button></div>`;
  const codes = box.querySelectorAll("code"); codes[0].textContent=usuario; codes[1].textContent=pass;
  box.querySelectorAll("[data-copiar]").forEach(b=>b.addEventListener("click",async()=>{ const t=b.dataset.copiar==="u"?usuario:pass; try{ await navigator.clipboard.writeText(t); toast("Copiado"); }catch(e){ const r=document.createRange(); r.selectNodeContents(codes[b.dataset.copiar==="u"?0:1]); getSelection().removeAllRanges(); getSelection().addRange(r); toast("Selecciónalo y cópialo"); } }));
}

/* ================= arranque ================= */
(async()=>{
  if(!window.crypto?.subtle){ $("#root").innerHTML = `<div class="empty" style="padding-top:20vh"><b>Navegador no compatible</b>Abre Assistant en un navegador actualizado y con conexión segura (https).</div>`; return; }
  if(Store.token && leerSesion()){
    try{
      $("#root").innerHTML = `<div class="empty" style="padding-top:20vh"><b>Cargando tu agenda…</b></div>`;
      const r = await Store.api("GET","/auth/yo"); S.usuario = r.usuario; guardarSesion();
      if(r.usuario.debeCambiar){ pintarCambio(true); enlazarCambio(); }
      else { await Store.cargar(); arrancarApp(); }
    }catch(e){ Store.ponerToken(null); pintarLogin(e.red ? e.message : ""); }
  } else { Store.ponerToken(null); pintarLogin(); }
  setTimeout(sondear, 8000);
})();
