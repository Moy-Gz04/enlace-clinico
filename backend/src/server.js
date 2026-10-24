/* =====================================================================
   API de Enlace Clínico
   - Autenticación con contraseña cifrada (bcrypt) y JWT de 8 horas.
   - Cada petición vuelve a leer al usuario: si se desactiva o cambia su
     contraseña, sus sesiones dejan de servir al momento.
   - El servidor decide qué ve y qué puede cambiar cada rol (rules.js).
   - Los tickets se firman con TICKET_SECRET, que nunca sale del servidor.
   ===================================================================== */
import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { q, crearEsquema, docsDe, docGet, docPut, docDel, bitacora, version, tocar } from "./db.js";
import { REGLAS, puedeBorrar, Rechazo } from "./rules.js";
import { sembrar } from "./seed.js";
import { randHex, validarPassword, passwordTemporal, firmaTexto, igualSeguro, limpiar, firmar } from "./util.js";

for (const k of ["DATABASE_URL", "JWT_SECRET", "TICKET_SECRET"]) {
  if (!process.env[k]) { console.error(`Falta la variable de entorno ${k}`); process.exit(1); }
}
const ORIGENES = (process.env.CORS_ORIGIN || "https://enlace-clinico.netlify.app").split(",").map(s => s.trim());
const COLECCIONES = ["doctores", "citas", "planes", "solicitudes", "mensajes"];
const USUARIO_RE = /^[a-z0-9._-]{4,32}$/;

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet());
app.use(cors({ origin: (o, cb) => cb(null, !o || ORIGENES.includes(o)), methods: ["GET", "POST", "PUT", "DELETE"], allowedHeaders: ["Content-Type", "Authorization"], maxAge: 600 }));
app.use(express.json({ limit: "12mb" }));
app.use("/api", rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));
const limiteLogin = rateLimit({ windowMs: 15 * 60_000, limit: 25, standardHeaders: true, legacyHeaders: false, message: { error: "Demasiados intentos. Espera unos minutos." } });

const envolver = fn => (req, res) => fn(req, res).catch(e => {
  if (e instanceof Rechazo) return res.status(e.status).json({ error: e.message });
  console.error(e); res.status(500).json({ error: "Ocurrió un error en el servidor. Intenta de nuevo." });
});
const publico = u => ({ id: u.id, usuario: u.usuario, rol: u.rol, doctorId: u.doctor_id, nombre: u.nombre, debeCambiar: u.debe_cambiar });
const firmarToken = u => jwt.sign({ sub: u.id, v: u.sesion_ver }, process.env.JWT_SECRET, { expiresIn: "8h" });

async function auth(req, res, next) {
  try {
    const t = (req.headers.authorization || "").replace(/^Bearer /, "");
    const p = jwt.verify(t, process.env.JWT_SECRET);
    const r = await q(`SELECT * FROM usuarios WHERE id=$1`, [p.sub]);
    const u = r.rows[0];
    if (!u || !u.activo || u.sesion_ver !== p.v) return res.status(401).json({ error: "Tu sesión terminó. Vuelve a entrar." });
    req.u = { id: u.id, usuario: u.usuario, rol: u.rol, doctorId: u.doctor_id, debeCambiar: u.debe_cambiar };
    // con contraseña temporal solo se permite cambiarla
    if (u.debe_cambiar && !req.path.startsWith("/auth/")) return res.status(403).json({ error: "Primero cambia tu contraseña temporal." });
    next();
  } catch { res.status(401).json({ error: "Tu sesión terminó. Vuelve a entrar." }); }
}
const soloAdmin = (req, res, next) => req.u.rol === "admin" ? next() : res.status(403).json({ error: "Solo la recepción puede hacer esto." });

app.get("/", (req, res) => res.json({ servicio: "Enlace Clínico API", estado: "ok" }));
app.get("/api/salud", envolver(async (req, res) => { await q("SELECT 1"); res.json({ ok: true }); }));

/* ---------------- autenticación ---------------- */
const HASH_FALSO = bcrypt.hashSync("no-existe-" + randHex(8), 12);
app.post("/api/auth/login", limiteLogin, envolver(async (req, res) => {
  const usuario = limpiar(req.body?.usuario, 32).toLowerCase(), password = String(req.body?.password || "").slice(0, 128);
  if (!usuario || !password) return res.status(400).json({ error: "Escribe tu usuario y contraseña." });
  const u = (await q(`SELECT * FROM usuarios WHERE usuario=$1`, [usuario])).rows[0];
  if (u?.bloqueo_hasta && new Date(u.bloqueo_hasta) > new Date()) {
    const min = Math.ceil((new Date(u.bloqueo_hasta) - new Date()) / 60000);
    return res.status(423).json({ error: `Cuenta bloqueada por intentos fallidos. Intenta en ${min} min.` });
  }
  const ok = await bcrypt.compare(password, u?.hash || HASH_FALSO);   // mismo tiempo exista o no el usuario
  if (!u || !u.activo || !ok) {
    if (u) {
      const intentos = u.intentos + 1;
      await q(`UPDATE usuarios SET intentos=$2, bloqueo_hasta=$3 WHERE id=$1`, [u.id, intentos >= 5 ? 0 : intentos, intentos >= 5 ? new Date(Date.now() + 5 * 60000) : null]);
      await bitacora(usuario, "Intento de acceso fallido", intentos >= 5 ? "Cuenta bloqueada 5 min" : "");
    } else await bitacora(usuario, "Intento de acceso fallido", "Usuario inexistente");
    return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
  }
  await q(`UPDATE usuarios SET intentos=0, bloqueo_hasta=NULL, ultimo_acceso=now() WHERE id=$1`, [u.id]);
  await bitacora(u.usuario, "Inicio de sesión");
  res.json({ token: firmarToken(u), usuario: publico(u) });
}));
app.get("/api/auth/yo", auth, envolver(async (req, res) => {
  const u = (await q(`SELECT * FROM usuarios WHERE id=$1`, [req.u.id])).rows[0];
  res.json({ usuario: publico(u) });
}));
app.post("/api/auth/password", auth, envolver(async (req, res) => {
  const u = (await q(`SELECT * FROM usuarios WHERE id=$1`, [req.u.id])).rows[0];
  const nueva = String(req.body?.nueva || "");
  if (!u.debe_cambiar && !(await bcrypt.compare(String(req.body?.actual || ""), u.hash))) return res.status(400).json({ error: "La contraseña actual no es correcta." });
  const v = validarPassword(nueva); if (v) return res.status(400).json({ error: v });
  if (await bcrypt.compare(nueva, u.hash)) return res.status(400).json({ error: "La nueva contraseña debe ser distinta a la anterior." });
  const r = (await q(`UPDATE usuarios SET hash=$2, debe_cambiar=FALSE, sesion_ver=sesion_ver+1 WHERE id=$1 RETURNING *`, [u.id, await bcrypt.hash(nueva, 12)])).rows[0];
  await bitacora(u.usuario, "Cambio de contraseña");
  res.json({ token: firmarToken(r), usuario: publico(r) });   // las demás sesiones quedan cerradas
}));

/* ---------------- estado: todo lo que el usuario puede ver ---------------- */
app.get("/api/version", auth, envolver(async (req, res) => res.json({ version: await version() })));
app.get("/api/estado", auth, envolver(async (req, res) => {
  const adm = req.u.rol === "admin", did = req.u.doctorId;
  const [doctores, citas, planes, solicitudes, mensajes] = await Promise.all([
    adm ? docsDe("doctores") : docsDe("doctores", "id", did),
    adm ? docsDe("citas") : docsDe("citas", "doctorId", did),
    docsDe("planes"),
    adm ? docsDe("solicitudes") : docsDe("solicitudes", "doctorId", did),
    adm ? docsDe("mensajes") : docsDe("mensajes", "conv", did),
  ]);
  const out = { version: await version(), doctores, citas, planes, solicitudes, mensajes, usuarios: [], bitacora: [] };
  if (adm) {
    out.usuarios = (await q(`SELECT id,usuario,rol,doctor_id,activo,debe_cambiar,ultimo_acceso,creado FROM usuarios ORDER BY usuario`)).rows
      .map(u => ({ id: u.id, usuario: u.usuario, rol: u.rol, doctorId: u.doctor_id, activo: u.activo, debeCambiar: u.debe_cambiar, ultimoAcceso: u.ultimo_acceso, creado: u.creado }));
    out.bitacora = (await q(`SELECT fecha,usuario,accion,detalle FROM bitacora ORDER BY id DESC LIMIT 300`)).rows;
  }
  res.json(out);
}));

/* ---------------- escritura de documentos ---------------- */
app.put("/api/docs/:col/:id", auth, envolver(async (req, res) => {
  const { col, id } = req.params;
  if (!COLECCIONES.includes(col) || !/^[A-Za-z0-9_-]{3,40}$/.test(id)) return res.status(404).json({ error: "No encontrado." });
  const previo = await docGet(col, id);
  const data = await REGLAS[col](req.u, previo, req.body?.data || {}, id);
  await docPut(col, id, data);
  res.json({ data });
}));
app.delete("/api/docs/:col/:id", auth, envolver(async (req, res) => {
  const { col, id } = req.params;
  if (!COLECCIONES.includes(col)) return res.status(404).json({ error: "No encontrado." });
  const previo = await docGet(col, id); if (!previo) return res.json({ ok: true });
  if (!puedeBorrar(req.u, col, previo)) return res.status(403).json({ error: "No puedes eliminar esto." });
  if (col === "doctores") {
    const futuras = (await docsDe("citas", "doctorId", id)).filter(c => c.estado === "confirmada" && c.fecha >= new Date().toISOString().slice(0, 10));
    if (futuras.length) return res.status(409).json({ error: `Tiene ${futuras.length} citas próximas. Cancélalas o reagéndalas primero.` });
    await q(`DELETE FROM usuarios WHERE doctor_id=$1`, [id]);
  }
  await docDel(col, id);
  res.json({ ok: true });
}));
app.post("/api/bitacora", auth, envolver(async (req, res) => {
  await bitacora(req.u.usuario, limpiar(req.body?.accion, 120), limpiar(req.body?.detalle, 300));
  res.json({ ok: true });
}));

/* ---------------- cuentas de médicos (solo recepción) ---------------- */
app.post("/api/usuarios", auth, soloAdmin, envolver(async (req, res) => {
  const usuario = limpiar(req.body?.usuario, 32).toLowerCase(), password = String(req.body?.password || ""), doctorId = String(req.body?.doctorId || "");
  if (!USUARIO_RE.test(usuario)) return res.status(400).json({ error: "Usuario inválido: 4 a 32 caracteres (a-z, 0-9, . _ -)." });
  const v = validarPassword(password); if (v) return res.status(400).json({ error: "Contraseña temporal: " + v });
  if (!await docGet("doctores", doctorId)) return res.status(400).json({ error: "El médico no existe." });
  if ((await q(`SELECT 1 FROM usuarios WHERE usuario=$1`, [usuario])).rowCount) return res.status(409).json({ error: "Ese usuario ya existe." });
  if ((await q(`SELECT 1 FROM usuarios WHERE doctor_id=$1`, [doctorId])).rowCount) return res.status(409).json({ error: "Ese médico ya tiene una cuenta." });
  await q(`INSERT INTO usuarios (id,usuario,rol,doctor_id,hash,debe_cambiar) VALUES ($1,$2,'medico',$3,$4,TRUE)`, ["usr-" + randHex(6), usuario, doctorId, await bcrypt.hash(password, 12)]);
  await bitacora(req.u.usuario, "Cuenta de médico creada", `@${usuario}`); await tocar();
  res.json({ ok: true });
}));
app.post("/api/usuarios/:id/reset", auth, soloAdmin, envolver(async (req, res) => {
  const tmp = passwordTemporal();
  const r = await q(`UPDATE usuarios SET hash=$2, debe_cambiar=TRUE, intentos=0, bloqueo_hasta=NULL, sesion_ver=sesion_ver+1 WHERE id=$1 AND rol='medico' RETURNING usuario`, [req.params.id, await bcrypt.hash(tmp, 12)]);
  if (!r.rowCount) return res.status(404).json({ error: "Cuenta no encontrada." });
  await bitacora(req.u.usuario, "Contraseña restablecida", `@${r.rows[0].usuario}`); await tocar();
  res.json({ usuario: r.rows[0].usuario, password: tmp });
}));
app.put("/api/usuarios/:id", auth, soloAdmin, envolver(async (req, res) => {
  const r = await q(`UPDATE usuarios SET activo=$2, sesion_ver=sesion_ver+1 WHERE id=$1 AND rol='medico' RETURNING usuario, activo`, [req.params.id, !!req.body?.activo]);
  if (!r.rowCount) return res.status(404).json({ error: "Cuenta no encontrada." });
  await bitacora(req.u.usuario, r.rows[0].activo ? "Acceso reactivado" : "Acceso desactivado", `@${r.rows[0].usuario}`); await tocar();
  res.json({ ok: true });
}));

/* ---------------- verificación de tickets ---------------- */
app.post("/api/verificar", auth, envolver(async (req, res) => {
  const t = String(req.body?.codigo || "").trim().slice(0, 800);
  let folio = t.toUpperCase(), token = null, frag = null, datos = null;
  if (t.startsWith("EC1.")) { const [, cuerpo, f] = t.split("."); try { datos = JSON.parse(Buffer.from(cuerpo.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")); folio = datos.f; token = datos.t; frag = f; } catch { return res.json({ tipo: "bad", titulo: "Código no reconocido", texto: "Este QR no es un ticket de Enlace Clínico." }); } }
  else if (t.startsWith("ENLACE-CLINICO|")) [, folio, token, frag] = t.split("|");
  const c = (await docsDe("citas", "folio", String(folio || "").toUpperCase()))[0];
  await bitacora(req.u.usuario, "Verificación de ticket", folio);
  if (!c) return res.json({ tipo: "bad", titulo: "Ticket no encontrado", texto: "No hay ninguna cita con ese folio. Puede ser falso o haberse reagendado.", folio });
  if (req.u.rol !== "admin" && c.doctorId !== req.u.doctorId) return res.json({ tipo: "bad", titulo: "Ticket de otro consultorio", texto: "Este ticket no corresponde a tus citas.", folio });
  const doc = await docGet("doctores", c.doctorId);
  const cita = { folio: c.folio, paciente: c.paciente?.nombre, medico: doc?.nombre, fecha: c.fecha, hora: c.hora, estado: c.estado };
  if (!igualSeguro(firmar(c), c.firma || "")) return res.json({ tipo: "bad", titulo: "Ticket alterado", texto: "Los datos de esta cita ya no coinciden con su firma original.", cita });
  if (token && (!igualSeguro(token, c.token) || !String(c.firma).startsWith(frag || "-"))) return res.json({ tipo: "bad", titulo: "Código no válido", texto: "El QR no corresponde a este folio; puede ser una copia modificada o un ticket anterior a un reagendado.", cita });
  if (datos && (datos.p !== c.paciente?.nombre || datos.d !== c.fecha || datos.h !== c.hora)) return res.json({ tipo: "bad", titulo: "Datos alterados", texto: "El nombre, la fecha o la hora del QR no coinciden con la cita registrada.", cita });
  if (c.estado === "cancelada") return res.json({ tipo: "bad", titulo: "Cita cancelada", texto: "El ticket es auténtico, pero esta cita fue cancelada.", cita });
  res.json({ tipo: "ok", titulo: c.estado === "atendida" ? "Ticket auténtico · ya atendida" : "Ticket auténtico", texto: token ? "La firma del código coincide con la cita registrada." : "Verificado por folio.", cita });
}));

/* ---------------- datos de prueba ---------------- */
app.post("/api/demo/reset", auth, soloAdmin, envolver(async (req, res) => { await sembrar(req.u.usuario); res.json({ ok: true }); }));

app.use((req, res) => res.status(404).json({ error: "No encontrado." }));

const PUERTO = process.env.PORT || 4600;
await crearEsquema();
if (!(await q(`SELECT 1 FROM usuarios LIMIT 1`)).rowCount) { console.log("Base vacía: cargando datos de prueba"); await sembrar(); }
app.listen(PUERTO, () => console.log(`Enlace Clínico API en el puerto ${PUERTO}`));
