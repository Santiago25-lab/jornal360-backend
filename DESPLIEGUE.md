# Jornal 360 · Guía de despliegue

Orden: **1. Supabase → 2. Railway (backend) → 3. Vercel (frontend) → 4. volver a Railway para el CORS.**

## 1. Supabase (base de datos)

1. Cree un proyecto en https://supabase.com (región São Paulo es la más cercana a Colombia).
2. Abra **SQL Editor → New query**, pegue todo `backend/supabase/jornal360_supabase.sql` y pulse **Run**.
   Crea las 39 tablas, el catálogo legal 2026 (66 parámetros, 44 conceptos, tablas, festivos) y el superusuario.
   Se puede ejecutar de nuevo sin duplicar nada.
3. En **Project Settings → Database → Connection string → URI** copie la cadena del **Session pooler** (puerto 5432).
   Reemplace `[YOUR-PASSWORD]` por la contraseña de la base.

> Las tablas tienen RLS activado sin políticas: nadie puede leerlas con la clave pública de Supabase.
> Solo el backend entra, con la cadena de conexión.

## 2. Railway (backend)

1. Suba la carpeta `backend` a su repositorio del backend.
2. En Railway: **New Project → Deploy from GitHub repo** → elija ese repositorio.
3. En **Variables** agregue:

| Variable | Valor |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | la cadena del paso 1.3 |
| `DATABASE_SSL` | `true` |
| `JWT_SECRETO` | una clave larga aleatoria (`openssl rand -base64 48`) |
| `QR_SECRETO` | otra clave larga distinta |
| `JWT_HORAS` | `12` |
| `CORS_ORIGENES` | por ahora `*`; en el paso 4 la URL de Vercel |
| `URL_FRONTEND` | la URL de Vercel (paso 4) |
| `MIGRAR_AL_INICIAR` | `true` |
| `DESFASE_MINUTOS` | `-300` (hora de Colombia) |

   `PORT` lo pone Railway solo. `SUPERADMIN_USUARIO` y `SUPERADMIN_PASSWORD` solo se usan si la base no tiene usuarios
   (por defecto Santiago / 123456santiago).
4. **Settings → Networking → Generate Domain**. Pruebe `https://SU-API.up.railway.app/api/salud`:
   debe responder `{"estado":"ok",...}`.

## 3. Vercel (frontend)

1. Suba la carpeta `frontend` a su repositorio del frontend.
2. En Vercel: **Add New → Project** → importe el repositorio.
3. Variable de entorno: `NEXT_PUBLIC_API_URL` = `https://SU-API.up.railway.app/api`.
4. **Deploy**.

## 4. Cerrar el círculo

En Railway cambie `CORS_ORIGENES` y `URL_FRONTEND` por la URL de Vercel (por ejemplo `https://jornal360.vercel.app`).
Si usa dominio propio, ponga ambas separadas por coma en `CORS_ORIGENES`. Railway reinicia solo.

## 5. Primer ingreso

1. Entre a la URL de Vercel con **Santiago** / **123456santiago**.
2. Cambie la contraseña en **Configuración → Mi contraseña**.
3. Siga el **asistente de primeros pasos**: empresa (NIT), días laborales, sedes y grupos de pago, valores de ley,
   marcación y empleados.
4. Complete el NIT de las EPS, fondos y cajas que use (Configuración → Sedes, áreas y turnos → Entidades).
5. Antes del primer pago, valide el archivo del banco con su banco.

## Verificado antes de entregar

- 143 pruebas automáticas del backend (motor de cálculo y API contra PostgreSQL real).
- El script de Supabase se aplicó dos veces seguidas sobre una base vacía sin errores.
- Recorrido completo en navegador con backend y frontend compilados en modo producción:
  ingreso, configuración, empleado nuevo, nómina (liquidar, paso a paso, aprobar, cerrar), prima, retiro,
  concepto propio con prueba, reportes; móvil y tema oscuro, sin errores en consola ni en la API.
