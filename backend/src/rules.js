/* Reglas de escritura por colección. Cada función recibe al usuario,
   el documento que ya existe (o null) y lo que manda el cliente, y devuelve
   el documento final que se guarda. Si algo no está permitido, lanza un
   Error con el mensaje que verá el usuario. El cliente nunca decide permisos. */
import { docsDe, docGet } from "./db.js";
import { conflicto, firmar, limpiar, limpiarTexto, randHex, aleatorio, durCita, esFecha, esHora } from "./util.js";

export class Rechazo extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
const no = (msg, status = 403) => { throw new Rechazo(msg, status); };
const esAdmin = u => u.rol === "admin";
const tam = (o) => JSON.stringify(o).length;
const solo = (obj, claves) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => claves.includes(k)));

/* ---------------- doctores ---------------- */
const CAMPOS_MEDICO_DOCTOR = ["horario", "ausencias", "bloqueos", "descripcion", "servicios", "foto", "banner", "certificados"];
function sanearDoctor(d) {
  const out = { ...d };
  for (const k of ["nombre", "especialidad", "consultorio", "direccion", "email", "telefono", "cedula", "plan", "estado", "color"]) if (k in out) out[k] = limpiar(out[k], 160);
  if ("descripcion" in out) out.descripcion = limpiarTexto(out.descripcion, 900);
  if ("servicios" in out) out.servicios = (Array.isArray(out.servicios) ? out.servicios : []).map(s => limpiar(s, 40)).filter(Boolean).slice(0, 10);
  if ("certificados" in out) out.certificados = (Array.isArray(out.certificados) ? out.certificados : []).slice(0, 20).map(c => ({ ...c, nombre: limpiar(c.nombre, 90), institucion: limpiar(c.institucion, 90), anio: limpiar(c.anio, 4), tipo: c.tipo === "pdf" ? "pdf" : "img" }));
  for (const k of ["foto", "banner"]) if (out[k] && !/^data:image\/(jpeg|png|webp);base64,/.test(out[k])) delete out[k];
  for (const c of out.certificados || []) if (!/^data:(image\/(jpeg|png|webp)|application\/pdf);base64,/.test(c.data || "")) no("Archivo de certificado no válido.", 400);
  if ("costoConsulta" in out) out.costoConsulta = Math.max(0, Number(out.costoConsulta) || 0);
  if ("cuota" in out) out.cuota = Math.max(0, Number(out.cuota) || 0);
  return out;
}
async function reglaDoctores(u, previo, nuevo, id) {
  if (esAdmin(u)) {
    const d = sanearDoctor({ ...nuevo, id });
    if (!d.nombre || d.nombre.length < 3) no("El nombre del médico es obligatorio.", 400);
    if (tam(d) > 9_000_000) no("El perfil es demasiado grande (fotos o certificados).", 413);
    return d;
  }
  if (u.doctorId !== id || !previo) no("Solo puedes modificar tu propio perfil.");
  const d = sanearDoctor({ ...previo, ...solo(nuevo, CAMPOS_MEDICO_DOCTOR), id });
  if (tam(d) > 9_000_000) no("Tu perfil es demasiado grande. Quita algún certificado o usa imágenes más ligeras.", 413);
  return d;
}

/* ---------------- citas ---------------- */
const CAMPOS_MEDICO_CITA = ["estado", "motivoCancelacion", "canceladaPor", "cancelada", "avisoPendiente", "actualizado"];
async function reglaCitas(u, previo, nuevo, id) {
  let c;
  if (esAdmin(u)) {
    c = { ...(previo || {}), ...nuevo, id };
    if (!previo) { c.token = randHex(8); c.creadoPor = u.usuario; c.creado = new Date().toISOString(); }
  } else {
    if (!previo || previo.doctorId !== u.doctorId) no("Esta cita no pertenece a tu consultorio.");
    const cambios = solo(nuevo, CAMPOS_MEDICO_CITA);
    if (cambios.estado && !["atendida", "cancelada", previo.estado].includes(cambios.estado)) no("No puedes cambiar la cita a ese estado.");
    c = { ...previo, ...cambios, id };
  }
  const doc = await docGet("doctores", c.doctorId);
  if (!doc) no("El médico de la cita no existe.", 400);
  if (!esFecha(c.fecha) || !esHora(c.hora)) no("Fecha u hora no válida.", 400);
  c.paciente = { nombre: limpiar(c.paciente?.nombre, 90), telefono: limpiar(c.paciente?.telefono, 20), edad: limpiar(c.paciente?.edad, 3), motivo: limpiar(c.paciente?.motivo, 90) };
  if (c.paciente.nombre.length < 3) no("El nombre del paciente es obligatorio.", 400);
  c.notas = limpiarTexto(c.notas, 600);
  c.duracion = durCita(c, doc);
  if (!["confirmada", "atendida", "cancelada"].includes(c.estado)) c.estado = "confirmada";
  // folio único
  const todas = await docsDe("citas", "doctorId", c.doctorId);
  if (!c.folio || (await docsDe("citas", "folio", c.folio)).some(o => o.id !== id)) {
    const d = new Date(); c.folio = `EC-${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}-${aleatorio(5)}`;
  }
  // el horario solo se valida cuando la cita queda (o vuelve a quedar) confirmada en un horario nuevo
  const cambiaHorario = !previo || previo.fecha !== c.fecha || previo.hora !== c.hora || (previo.estado !== "confirmada" && c.estado === "confirmada");
  if (esAdmin(u) && c.estado === "confirmada" && cambiaHorario) {
    const motivo = conflicto(doc, c.fecha, c.hora, todas, id, c.duracion);
    if (motivo) no(motivo, 409);
    if (previo && (previo.fecha !== c.fecha || previo.hora !== c.hora)) c.token = randHex(8);   // reagendar invalida el ticket anterior
  }
  if (!c.token) c.token = randHex(8);
  c.firma = firmar(c);
  return c;
}

/* ---------------- planes ---------------- */
async function reglaPlanes(u, previo, nuevo, id) {
  if (!esAdmin(u)) no("Solo la recepción puede modificar los planes.");
  const p = { ...nuevo, id };
  p.nombre = limpiar(p.nombre, 40); if (p.nombre.length < 2) no("El plan necesita nombre.", 400);
  p.lema = limpiar(p.lema, 110);
  p.precio = Math.max(0, Number(p.precio) || 0);
  p.incluye = (p.incluye || []).map(t => limpiar(t, 90)).filter(Boolean).slice(0, 12);
  p.excluye = (p.excluye || []).map(t => limpiar(t, 90)).filter(Boolean).slice(0, 12);
  return p;
}

/* ---------------- solicitudes de cambio de plan ---------------- */
async function reglaSolicitudes(u, previo, nuevo, id) {
  if (esAdmin(u)) return { ...(previo || {}), ...nuevo, id };
  if (previo) no("Tu recepción revisará tu solicitud.");
  if (nuevo.doctorId !== u.doctorId) no("Solo puedes solicitar cambios para tu propio plan.");
  const plan = await docGet("planes", nuevo.a); if (!plan || plan.activo === false) no("Ese plan no está disponible.", 400);
  const pendientes = (await docsDe("solicitudes", "doctorId", u.doctorId)).filter(s => s.estado === "pendiente");
  if (pendientes.length) no("Ya tienes una solicitud pendiente.", 409);
  return { id, doctorId: u.doctorId, de: limpiar(nuevo.de, 40), a: plan.id, nota: limpiarTexto(nuevo.nota, 240), estado: "pendiente", fecha: new Date().toISOString() };
}

/* ---------------- mensajes ---------------- */
async function reglaMensajes(u, previo, nuevo, id) {
  if (previo) {
    // un mensaje ya enviado solo cambia su marca de "leído" por quien lo recibe
    const m = { ...previo };
    if (esAdmin(u) && previo.de === "medico" && nuevo.leidoAdmin) { m.leidoAdmin = true; m.leidoAdminEn = new Date().toISOString(); }
    if (!esAdmin(u) && previo.conv === u.doctorId && previo.de === "admin" && nuevo.leidoMedico) { m.leidoMedico = true; m.leidoMedicoEn = new Date().toISOString(); }
    return m;
  }
  const conv = esAdmin(u) ? nuevo.conv : u.doctorId;
  if (!await docGet("doctores", conv)) no("La conversación no existe.", 400);
  const texto = limpiarTexto(nuevo.texto, 1000);
  let citaId = null;
  if (nuevo.citaId) { const c = await docGet("citas", nuevo.citaId); if (!c || c.doctorId !== conv) no("Esa cita no pertenece a esta conversación.", 400); citaId = c.id; }
  if (!texto && !citaId) no("El mensaje está vacío.", 400);
  return { id, conv, de: esAdmin(u) ? "admin" : "medico", autor: u.usuario, texto, citaId, aviso: esAdmin(u) && !!nuevo.aviso,
    fecha: new Date().toISOString(), leidoAdmin: esAdmin(u), leidoMedico: !esAdmin(u) };
}

export const REGLAS = { doctores: reglaDoctores, citas: reglaCitas, planes: reglaPlanes, solicitudes: reglaSolicitudes, mensajes: reglaMensajes };

export function puedeBorrar(u, col, previo) {
  if (esAdmin(u)) return true;
  if (col === "solicitudes" && previo?.doctorId === u.doctorId && previo.estado === "pendiente") return true;
  return false;
}
