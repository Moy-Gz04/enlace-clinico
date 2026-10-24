import pg from "pg";

/* Conexión a Neon. La cadena llega por DATABASE_URL (nunca en el código). */
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 8,
  idleTimeoutMillis: 30000,
});

export const q = (text, params) => pool.query(text, params);

/* Esquema: usuarios con contraseña cifrada; el resto de la información son
   documentos JSON por colección (doctores, citas, planes, solicitudes,
   mensajes). Los permisos y validaciones viven en rules.js, no en la base. */
export async function crearEsquema() {
  await q(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id            TEXT PRIMARY KEY,
      usuario       TEXT UNIQUE NOT NULL,
      rol           TEXT NOT NULL CHECK (rol IN ('admin','medico')),
      doctor_id     TEXT,
      nombre        TEXT,
      hash          TEXT NOT NULL,
      activo        BOOLEAN NOT NULL DEFAULT TRUE,
      debe_cambiar  BOOLEAN NOT NULL DEFAULT FALSE,
      intentos      INT NOT NULL DEFAULT 0,
      bloqueo_hasta TIMESTAMPTZ,
      ultimo_acceso TIMESTAMPTZ,
      sesion_ver    INT NOT NULL DEFAULT 1,
      creado        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS docs (
      col         TEXT NOT NULL,
      id          TEXT NOT NULL,
      data        JSONB NOT NULL,
      actualizado TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (col, id)
    );
    CREATE INDEX IF NOT EXISTS docs_doctor ON docs ((data->>'doctorId'));
    CREATE INDEX IF NOT EXISTS docs_conv   ON docs ((data->>'conv'));
    CREATE TABLE IF NOT EXISTS bitacora (
      id      BIGSERIAL PRIMARY KEY,
      fecha   TIMESTAMPTZ NOT NULL DEFAULT now(),
      usuario TEXT,
      accion  TEXT NOT NULL,
      detalle TEXT
    );
    CREATE TABLE IF NOT EXISTS meta (
      clave TEXT PRIMARY KEY,
      valor TEXT
    );
  `);
}

export async function docsDe(col, filtro, valor) {
  const r = filtro
    ? await q(`SELECT data FROM docs WHERE col=$1 AND data->>$2 = $3`, [col, filtro, valor])
    : await q(`SELECT data FROM docs WHERE col=$1`, [col]);
  return r.rows.map(x => x.data);
}
export async function docGet(col, id) {
  const r = await q(`SELECT data FROM docs WHERE col=$1 AND id=$2`, [col, id]);
  return r.rows[0]?.data || null;
}
export async function docPut(col, id, data) {
  await q(`INSERT INTO docs (col,id,data,actualizado) VALUES ($1,$2,$3,now())
           ON CONFLICT (col,id) DO UPDATE SET data=EXCLUDED.data, actualizado=now()`, [col, id, data]);
  await tocar();
}
export async function docDel(col, id) {
  await q(`DELETE FROM docs WHERE col=$1 AND id=$2`, [col, id]);
  await tocar();
}
/* Versión global de los datos: el cliente la consulta para saber si recargar. */
export async function tocar() {
  await q(`INSERT INTO meta (clave,valor) VALUES ('version', $1)
           ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor`, [String(Date.now())]);
}
export async function version() {
  const r = await q(`SELECT valor FROM meta WHERE clave='version'`);
  return r.rows[0]?.valor || "0";
}
export async function bitacora(usuario, accion, detalle = "") {
  await q(`INSERT INTO bitacora (usuario,accion,detalle) VALUES ($1,$2,$3)`,
    [usuario || "—", String(accion).slice(0, 120), String(detalle || "").slice(0, 300)]);
  // la bitácora solo conserva lo más reciente
  await q(`DELETE FROM bitacora WHERE id < (SELECT COALESCE(MAX(id),0) - 2000 FROM bitacora)`);
}
