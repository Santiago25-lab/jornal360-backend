# Jornal 360 · Backend (API)

API de nómina y asistencia para Colombia. NestJS + TypeScript + PostgreSQL (Supabase).

## Cómo funciona

- `src/domain/`: el **motor de cálculo**, sin dependencias de la base: fórmulas, festivos, calendario laboral,
  clasificación de horas, nómina, prestaciones, retención, retiro, QR y archivos para bancos y contabilidad.
  Ningún valor legal está fijo en el código: todos son parámetros, tablas o fórmulas editables.
- `src/modules/`: la API REST (todas las rutas empiezan por `/api`).
- `db/schema.sql`: el esquema. El servidor lo aplica al arrancar (idempotente) y siembra el catálogo legal
  la primera vez.
- `supabase/jornal360_supabase.sql`: el mismo esquema más los datos iniciales, para pegar en Supabase
  (se regenera con `npm run sql:supabase`).

## Desarrollo

```bash
npm install
cp .env.example .env    # y ajuste DATABASE_URL
npm run start:dev
```

## Pruebas

Unitarias (motor de cálculo) y de extremo a extremo contra un PostgreSQL real:

```bash
PG_TEST_URL=postgres://postgres@localhost:5433 npm test
```

## Despliegue en Railway

1. Cree un proyecto en Railway desde este repositorio de GitHub.
2. En **Variables**, copie las de `.env.example` con sus valores reales.
3. Railway usa `railway.json`: compila con `npm run build` y arranca con `npm start`.
4. Verifique `https://SU-API.up.railway.app/api/salud`.

Superusuario inicial: **Santiago** / **123456santiago**. Cámbiela después del primer ingreso.
