# Enlace Clínico

Recepción médica virtual: la recepción agenda citas para médicos suscriptores,
emite tickets con QR verificables y se comunica con cada médico por chat interno.

- **Frontend** (raíz: `index.html`, `assets/`): sitio estático en Netlify — https://enlace-clinico.netlify.app
- **Backend** (`backend/`): API Node + Express en Render, base de datos PostgreSQL en Neon.

## Backend

Variables de entorno (Render → Environment):

| Variable | Qué es |
|---|---|
| `DATABASE_URL` | Cadena de conexión de Neon |
| `JWT_SECRET` | Clave larga y aleatoria para firmar sesiones |
| `TICKET_SECRET` | Clave larga y aleatoria para firmar tickets |
| `CORS_ORIGIN` | `https://enlace-clinico.netlify.app` |

Al arrancar crea las tablas y, si la base está vacía, carga datos de prueba.

```bash
cd backend && npm install && npm start   # requiere backend/.env con las variables
```
