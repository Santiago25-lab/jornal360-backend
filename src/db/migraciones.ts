import { Logger } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { config } from '../config';
import { festivosColombia } from '../domain/festivos';
import { sqlCatalogo, sqlSemilla } from '../seed/semilla';
import { Db } from './db.service';

const log = new Logger('Migraciones');

export function rutaEsquema(): string {
  return resolve(__dirname, '..', '..', 'db', 'schema.sql');
}

/**
 * Prepara la base al arrancar (idempotente):
 * - crea las tablas que falten,
 * - si no hay empresa, crea la empresa inicial, el superusuario y el catálogo,
 * - si una empresa no tiene catálogo, lo siembra,
 * - agrega los festivos del año siguiente si aún no existen.
 * Nunca sobrescribe lo que el superusuario ya configuró.
 */
export async function prepararBase(db: Db): Promise<void> {
  const c = config();
  await db.pool.query(readFileSync(rutaEsquema(), 'utf8'));
  const hay = await db.maybe<{ n: string }>('select count(*)::text as n from empresas');
  if (!hay || hay.n === '0') {
    const hash = await bcrypt.hash(c.superadminPassword, 10);
    await db.tx(async (cl) => {
      await cl.query(
        sqlSemilla({
          usuario: c.superadminUsuario,
          nombreUsuario: c.superadminUsuario,
          passwordHashSql: `'${hash}'`,
        }),
      );
    });
    log.log(`Empresa inicial y superusuario "${c.superadminUsuario}" creados`);
    return;
  }
  const empresas = await db.many<{ id: string; n: string }>(
    'select e.id, (select count(*) from parametros p where p.empresa_id = e.id)::text as n from empresas e',
  );
  const anio = new Date().getUTCFullYear();
  for (const e of empresas) {
    if (e.n === '0') {
      await db.tx(async (cl) => {
        await cl.query(sqlCatalogo(e.id, [anio, anio + 1]));
      });
      log.log(`Catálogo sembrado para la empresa ${e.id}`);
    }
    for (const a of [anio, anio + 1]) {
      const f = await db.one<{ n: string }>(
        `select count(*)::text as n from festivos where empresa_id = $1 and extract(year from fecha) = $2`,
        [e.id, a],
      );
      if (f.n === '0')
        for (const x of festivosColombia(a))
          await db.exec('insert into festivos (empresa_id, fecha, nombre) values ($1, $2, $3) on conflict do nothing', [e.id, x.fecha, x.nombre]);
    }
  }
  // Si por algún motivo no existe ningún superusuario, se recrea con las credenciales configuradas.
  const su = await db.maybe(`select 1 from usuarios where rol = 'superusuario' and activo`);
  if (!su) {
    const hash = await bcrypt.hash(c.superadminPassword, 10);
    await db.exec(
      `insert into usuarios (empresa_id, usuario, nombre, password_hash, rol) values ($1, $2, $2, $3, 'superusuario')
       on conflict (lower(usuario)) do update set activo = true, rol = 'superusuario'`,
      [empresas[0].id, c.superadminUsuario, hash],
    );
  }
}
