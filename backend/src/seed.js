/* Datos iniciales de prueba: 1 recepción, 3 médicos, planes y citas de ejemplo.
   Se cargan solo si la base está vacía, o cuando la recepción pide
   "Restablecer datos de prueba". */
import bcrypt from "bcryptjs";
import { q, docPut, bitacora, tocar } from "./db.js";
import { hoy, addDays, addMonths, randHex, aleatorio, rangoDelDia, hhmm, firmar } from "./util.js";

export const PLANES_BASE = [
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
    incluye:["Citas ilimitadas","Recordatorio al paciente un día antes","Reporte mensual de citas y asistencia","Todo lo del plan Esencial"], excluye:[] },
  { id:"clinica", nombre:"Clínica", precio:2490, orden:3, activo:true, destacado:false,
    lema:"Para consultorios con varios horarios, sedes o asistentes.",
    limites:{ citasMes:0, descargas:true, reagendar:true, recordatorios:true, reportes:true },
    incluye:["Todo lo del plan Profesional","Atención prioritaria de la recepción","Lista de espera para huecos que se liberan","Hasta 2 sedes de consulta"], excluye:[] },
];

export const USUARIOS_PRUEBA = [
  { usuario:"admin",      password:"Recepcion#2026",  rol:"admin",  nombre:"Recepción" },
  { usuario:"dra.ruiz",   password:"RuizConsulta#26", rol:"medico", doctorId:"doc-ruiz" },
  { usuario:"dr.salas",   password:"SalasPedia#26",   rol:"medico", doctorId:"doc-salas" },
  { usuario:"dra.mendez", password:"MendezCardio#26", rol:"medico", doctorId:"doc-mendez" },
];

export async function sembrar(porQuien = "sistema") {
  await q(`DELETE FROM docs; DELETE FROM usuarios;`);
  const t = hoy();
  const doctores = [
    { id:"doc-ruiz", nombre:"Dra. Elena Ruiz", especialidad:"Medicina general", cedula:"10293847", telefono:"771 123 4567", email:"elena.ruiz@ejemplo.mx", costoConsulta:600, consultorio:"Torre Médica Pachuca, cons. 304", direccion:"Av. Juárez 120, Pachuca, Hgo.", plan:"profesional", cuota:1490, estado:"activa", inicio:addDays(t,-40), proximoPago:addDays(t,3), color:"#0B7A63", horario:{dias:[1,2,3,4,5], inicio:"09:00", fin:"14:00", duracion:30}, ejemplo:true },
    { id:"doc-salas", nombre:"Dr. Andrés Salas", especialidad:"Pediatría", cedula:"88452210", telefono:"771 765 4321", email:"andres.salas@ejemplo.mx", costoConsulta:750, consultorio:"Clínica del Valle, cons. 12", direccion:"Blvd. Colosio 455, Pachuca, Hgo.", plan:"esencial", cuota:890, estado:"activa", inicio:addDays(t,-70), proximoPago:addDays(t,21), color:"#2563A8", horario:{dias:[1,3,5,6], inicio:"16:00", fin:"20:00", duracion:30}, ejemplo:true },
    { id:"doc-mendez", nombre:"Dra. Laura Méndez", especialidad:"Cardiología", cedula:"55123987", telefono:"771 222 9090", email:"laura.mendez@ejemplo.mx", costoConsulta:1100, consultorio:"Hospital San Ángel, piso 2", direccion:"Río de la Plata 30, Pachuca, Hgo.", plan:"prueba", cuota:0, estado:"activa", inicio:addDays(t,-3), pruebaInicio:new Date(Date.now()-3*864e5).toISOString(), pruebaHasta:addDays(t,4), proximoPago:null, color:"#9A4A9B", horario:{dias:[2,4], inicio:"10:00", fin:"15:00", duracion:45}, ejemplo:true },
  ];
  for (const p of PLANES_BASE) await docPut("planes", p.id, p);
  for (const d of doctores) await docPut("doctores", d.id, d);
  for (const u of USUARIOS_PRUEBA) {
    await q(`INSERT INTO usuarios (id,usuario,rol,doctor_id,nombre,hash) VALUES ($1,$2,$3,$4,$5,$6)`,
      ["usr-" + randHex(6), u.usuario, u.rol, u.doctorId || null, u.nombre || null, await bcrypt.hash(u.password, 12)]);
  }
  // citas de ejemplo en los siguientes días de consulta de cada médico
  const pacientes = [["Mariana Torres Gil","771 555 0101","34","Revisión general","Trae resultados de laboratorio. Alergia a la penicilina."],["Jorge Luis Medina","771 555 0202","52","Control de presión",""],["Sofía Ramírez Ortega","771 555 0303","6","Vacunación","Viene con su mamá; traer cartilla de vacunación."],["Ricardo Peña Soto","771 555 0404","61","Electrocardiograma","Paciente con marcapasos."],["Ana Karen Vite","771 555 0505","28","Dolor de garganta",""],["Héctor Ibarra Cruz","771 555 0606","45","Valoración cardiológica","Enviado por su médico familiar."]];
  const plan = [["doc-ruiz",0,0],["doc-ruiz",1,1],["doc-salas",2,0],["doc-mendez",3,0],["doc-ruiz",4,2],["doc-mendez",5,1]];
  for (const [docId, i, n] of plan) {
    const doc = doctores.find(x => x.id === docId);
    let f = addDays(t, 1), r = null, k = 0;
    while (!r && k < 14) { r = rangoDelDia(doc, f); if (!r) { f = addDays(f, 1); k++; } }
    if (!r) continue;
    const [nombre, tel, edad, motivo, notas] = pacientes[i];
    const d = new Date();
    const c = { id:"cit-"+randHex(6), folio:`EC-${String(d.getFullYear()).slice(2)}${String(d.getMonth()+1).padStart(2,"0")}-${aleatorio(5)}`, token:randHex(8), doctorId:docId, fecha:f, hora:hhmm(r.inicio + n*r.dur), duracion:r.dur, estado:"confirmada", paciente:{nombre,telefono:tel,edad,motivo}, notas, creado:new Date().toISOString(), creadoPor:"admin", ejemplo:true };
    c.firma = firmar(c);
    await docPut("citas", c.id, c);
  }
  // mensajes de bienvenida
  const ahora = Date.now();
  for (const [i, doc] of doctores.entries()) {
    const id = "msg-"+randHex(6);
    await docPut("mensajes", id, { id, conv:doc.id, de:"admin", autor:"admin", texto:`Hola, ${doc.nombre}. Este es tu canal directo con la recepción: escríbenos cambios de horario, pacientes que quieras atender o cualquier duda.`, fecha:new Date(ahora-(i+1)*3600e3).toISOString(), leidoAdmin:true, leidoMedico:i!==0 });
  }
  const id = "msg-"+randHex(6);
  await docPut("mensajes", id, { id, conv:"doc-ruiz", de:"medico", autor:"dra.ruiz", texto:"Gracias. ¿Me pueden confirmar mis citas de esta semana?", fecha:new Date(ahora-20*60e3).toISOString(), leidoAdmin:false, leidoMedico:true });
  await bitacora(porQuien, "Datos de prueba creados", "1 administrador, 3 médicos, 6 citas");
  await tocar();
}
