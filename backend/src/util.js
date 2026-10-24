import crypto from "node:crypto";

export const pad = n => String(n).padStart(2, "0");
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fromYmd = s => { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, m - 1, d); };
/* Fecha "de hoy" en horario de México centro, sin depender de la zona del servidor */
export function hoy() {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return f; // YYYY-MM-DD
}
export function minutoActualMx() {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Mexico_City", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  const [h, m] = p.split(":").map(Number); return h * 60 + m;
}
export const addDays = (s, n) => { const d = fromYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
export const addMonths = (s, n) => { const d = fromYmd(s); d.setMonth(d.getMonth() + n); return ymd(d); };
export const minutos = h => { const [a, b] = String(h).split(":").map(Number); return a * 60 + b; };
export const hhmm = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
export const esFecha = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
export const esHora = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || "");
export const randHex = n => crypto.randomBytes(n).toString("hex");
export function aleatorio(n, abc = "ABCDEFGHJKMNPQRSTUVWXYZ23456789") {
  const b = crypto.randomBytes(n); return [...b].map(x => abc[x % abc.length]).join("");
}
export const limpiar = (v, max = 120) => String(v ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, max);
export const limpiarTexto = (v, max = 600) => String(v ?? "").replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, " ").trim().slice(0, max);

export function validarPassword(pw) {
  pw = String(pw || "");
  if (pw.length < 10) return "Usa al menos 10 caracteres.";
  if (pw.length > 128) return "La contraseña es demasiado larga.";
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw)) return "Combina mayúsculas y minúsculas.";
  if (!/\d/.test(pw)) return "Incluye al menos un número.";
  if (!/[^A-Za-z0-9]/.test(pw)) return "Incluye al menos un símbolo (#, $, !…).";
  return "";
}
export const passwordTemporal = () => aleatorio(4, "ABCDEFGHJKMNPQRSTUVWXYZ") + aleatorio(4, "abcdefghjkmnpqrstuvwxyz") + aleatorio(3, "23456789") + "#";

/* Firma de tickets: HMAC-SHA256 con la clave del servidor (TICKET_SECRET) */
export const firmaTexto = c => [c.folio, c.doctorId, c.fecha, c.hora, (c.paciente?.nombre || "").trim().toUpperCase(), c.token].join("|");
export const firmar = c => crypto.createHmac("sha256", process.env.TICKET_SECRET).update(firmaTexto(c)).digest("hex");
export function igualSeguro(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* Horarios del médico: misma lógica que el frontend, repetida aquí para que
   el servidor sea quien decide si una cita cabe. */
export const enAusencia = (doc, fecha) => (doc?.ausencias || []).find(a => fecha >= a.desde && fecha <= a.hasta) || null;
export function rangoDelDia(doc, fecha) {
  const h = doc?.horario; if (!h) return null;
  const dia = fromYmd(fecha).getDay();
  if (!(h.dias || []).includes(dia)) return null;
  const r = h.horas?.[dia] || { inicio: h.inicio, fin: h.fin };
  return { inicio: minutos(r.inicio), fin: minutos(r.fin), dur: Number(h.duracion || 30) };
}
export const durCita = (c, doc) => Number(c.duracion || doc?.horario?.duracion || 30);
const traslapa = (a1, a2, b1, b2) => a1 < b2 && b1 < a2;
export function conflicto(doc, fecha, hora, citas, exceptoId, dur) {
  if (!doc) return "El médico no existe.";
  if (!esFecha(fecha) || !esHora(hora)) return "Fecha u hora no válida.";
  if (enAusencia(doc, fecha)) return `${doc.nombre} estará ausente ese día.`;
  const r = rangoDelDia(doc, fecha); if (!r) return `${doc.nombre} no atiende ese día.`;
  const m = minutos(hora), fin = m + (dur || r.dur);
  if (m < r.inicio || fin > r.fin) return `Fuera del horario del médico (${hhmm(r.inicio)} a ${hhmm(r.fin)}).`;
  if (fecha < hoy() || (fecha === hoy() && m <= minutoActualMx())) return "Esa hora ya pasó.";
  for (const c of citas) {
    if (c.doctorId !== doc.id || c.fecha !== fecha || c.estado === "cancelada" || c.id === exceptoId) continue;
    const ci = minutos(c.hora);
    if (traslapa(m, fin, ci, ci + durCita(c, doc))) return `Choca con la cita de las ${c.hora}.`;
  }
  for (const bq of doc.bloqueos || []) {
    if (bq.fecha === fecha && traslapa(m, fin, minutos(bq.desde), minutos(bq.hasta))) return `El médico marcó ${bq.desde}–${bq.hasta} como no disponible.`;
  }
  return "";
}
