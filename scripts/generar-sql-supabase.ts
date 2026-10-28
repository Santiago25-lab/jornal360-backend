/**
 * Genera el archivo único para pegar en el SQL Editor de Supabase:
 *   npx ts-node scripts/generar-sql-supabase.ts
 * Resultado: supabase/jornal360_supabase.sql (dentro del repositorio) y una copia en ../supabase
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { sqlSemilla } from '../src/seed/semilla';

const usuario = process.env.SUPERADMIN_USUARIO ?? 'Santiago';
const password = process.env.SUPERADMIN_PASSWORD ?? '123456santiago';

const esquema = readFileSync(join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
const semilla = sqlSemilla({
  usuario,
  nombreUsuario: 'Santiago',
  // pgcrypto genera un hash bcrypt compatible con el backend.
  passwordHashSql: `crypt('${password.replace(/'/g, "''")}', gen_salt('bf', 10))`,
});

const contenido = `-- =====================================================================
-- Jornal 360 · Script completo para Supabase
-- Pegue todo este archivo en Supabase → SQL Editor → New query → Run.
-- Se puede ejecutar varias veces: no duplica datos.
-- Crea las tablas, el superusuario (${usuario}) y el catálogo legal inicial.
-- =====================================================================

${esquema}

-- ---------- Datos iniciales ----------
begin;
${semilla}
commit;
`;

for (const destino of [join(__dirname, '..', 'supabase'), join(__dirname, '..', '..', 'supabase')]) {
  mkdirSync(destino, { recursive: true });
  writeFileSync(join(destino, 'jornal360_supabase.sql'), contenido);
  console.log(`Listo: ${join(destino, 'jornal360_supabase.sql')} (${(contenido.length / 1024).toFixed(0)} KB)`);
}
