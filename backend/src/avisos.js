/* Notificaciones push (escritorio y celular) y avisos automáticos:
   - recordatorio al médico 10 minutos antes de cada cita
   - aviso de vencimiento del plan 7 días, 3 días y el mismo día
   Las claves VAPID se crean una sola vez y se guardan en la base. */
import webpush from "web-push";
import { q, docsDe, docGet, docPut } from "./db.js";
import { hoy, minutos, minutoActualMx, randHex, fromYmd } from "./util.js";

export const hora12 = h => { const [H, M] = String(h).split(":").map(Number); const p = H >= 12 ? "p. m." : "a. m."; return `${((H + 11) % 12) + 1}:${String(M).padStart(2, "0")} ${p}`; };

let vapidPublica = null;
export async function iniciarPush() {
  await q(`CREATE TABLE IF NOT EXISTS push_subs (
    endpoint TEXT PRIMARY KEY, usuario_id TEXT NOT NULL, data JSONB NOT NULL, creado TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const r = await q(`SELECT clave, valor FROM meta WHERE clave IN ('vapid_publica','vapid_privada')`);
  let pub = r.rows.find(x => x.clave === "vapid_publica")?.valor, priv = r.rows.find(x => x.clave === "vapid_privada")?.valor;
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys(); pub = k.publicKey; priv = k.privateKey;
    await q(`INSERT INTO meta (clave,valor) VALUES ('vapid_publica',$1),('vapid_privada',$2) ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor`, [pub, priv]);
  }
  webpush.setVapidDetails("mailto:contacto@assistant.mx", pub, priv);
  vapidPublica = pub;
}
export const clavePublica = () => vapidPublica;

/* destino: { usuarioIds:[...] } | { rol:"admin" } | { doctorId } */
export async function enviarPush(destino, aviso) {
  try {
    let ids = destino.usuarioIds || [];
    if (destino.rol) ids = (await q(`SELECT id FROM usuarios WHERE rol=$1 AND activo`, [destino.rol])).rows.map(x => x.id);
    if (destino.doctorId) ids = (await q(`SELECT id FROM usuarios WHERE doctor_id=$1 AND activo`, [destino.doctorId])).rows.map(x => x.id);
    if (!ids.length) return;
    const subs = (await q(`SELECT endpoint, data FROM push_subs WHERE usuario_id = ANY($1)`, [ids])).rows;
    const cuerpo = JSON.stringify({ titulo: aviso.titulo, texto: aviso.texto, vista: aviso.vista || "", etiqueta: aviso.etiqueta || randHex(4) });
    await Promise.all(subs.map(s => webpush.sendNotification(s.data, cuerpo, { TTL: 3600 }).catch(async e => {
      if (e.statusCode === 404 || e.statusCode === 410) await q(`DELETE FROM push_subs WHERE endpoint=$1`, [s.endpoint]);
    })));
  } catch (e) { console.error("push:", e.message); }
}

/* Mensaje automático de la recepción en la conversación del médico */
export async function mensajeSistema(doctorId, texto, extra = {}) {
  const id = "msg-" + randHex(6);
  await docPut("mensajes", id, { id, conv: doctorId, de: "admin", autor: "sistema", texto, sistema: true, fecha: new Date().toISOString(), leidoAdmin: true, leidoMedico: false, ...extra });
}

async function revisarCitas() {
  const fecha = hoy(), ahora = minutoActualMx();
  const citas = (await q(`SELECT data FROM docs WHERE col='citas' AND data->>'fecha'=$1 AND data->>'estado'='confirmada'`, [fecha])).rows.map(r => r.data);
  for (const c of citas) {
    const faltan = minutos(c.hora) - ahora;
    if (faltan > 10 || faltan < 0 || c.aviso10) continue;
    c.aviso10 = true; await docPut("citas", c.id, c);
    const texto = `Tu cita con ${c.paciente?.nombre} es a las ${hora12(c.hora)} (en ${faltan} min). Prepárate para recibirle.${c.notas ? ` Nota de recepción: ${c.notas}` : ""}`;
    await mensajeSistema(c.doctorId, texto, { citaId: c.id });
    await enviarPush({ doctorId: c.doctorId }, { titulo: `Tu paciente llega en ${faltan} min`, texto: `${c.paciente?.nombre} · ${hora12(c.hora)}`, vista: "agenda", etiqueta: "cita-" + c.id });
  }
}
async function revisarPlanes() {
  const fecha = hoy();
  for (const d of await docsDe("doctores")) {
    if (d.estado === "pausada") continue;
    const limite = d.plan === "prueba" ? d.pruebaHasta : d.proximoPago;
    if (!limite) continue;
    const dias = Math.round((fromYmd(limite) - fromYmd(fecha)) / 864e5);
    if (![7, 3, 0].includes(dias)) continue;
    const clave = `${limite}:${dias}`;
    if ((d.avisosPago || []).includes(clave)) continue;
    d.avisosPago = [...(d.avisosPago || []).slice(-20), clave];
    await docPut("doctores", d.id, d);
    const que = d.plan === "prueba" ? "Tu prueba gratis" : "Tu plan";
    const cuando = dias === 0 ? "vence hoy" : `vence en ${dias} días`;
    await mensajeSistema(d.id, `${que} ${cuando}. Para no perder el acceso, realiza tu pago por transferencia (los datos están en "Mi plan") y envíanos tu comprobante por este chat.`);
    await enviarPush({ doctorId: d.id }, { titulo: `${que} ${cuando}`, texto: "Revisa los datos de pago en Mi plan.", vista: "planes", etiqueta: "pago-" + d.id });
  }
}
export function iniciarAvisos() {
  const ciclo = async () => { try { await revisarCitas(); await revisarPlanes(); } catch (e) { console.error("avisos:", e.message); } };
  setInterval(ciclo, 60_000); setTimeout(ciclo, 5_000);
}

/* ¿El médico tiene el acceso suspendido por falta de pago? */
export function bloqueoPorPago(doc) {
  if (!doc) return null;
  const fecha = hoy();
  if (doc.estado === "pausada") return { titulo: "Tu suscripción está pausada", texto: "Tu acceso está suspendido. Comunícate con tu recepción para reactivarlo." };
  if (doc.plan === "prueba" && doc.pruebaHasta && doc.pruebaHasta < fecha) return { titulo: "Tu prueba gratis terminó", texto: "Para seguir usando Assistant elige un plan y realiza tu pago." };
  if (doc.plan !== "prueba" && doc.proximoPago && doc.proximoPago < fecha) return { titulo: "Pago pendiente", texto: `Tu mensualidad venció el ${doc.proximoPago.split("-").reverse().join("/")}. El acceso se reactiva al registrar tu pago.` };
  return null;
}
