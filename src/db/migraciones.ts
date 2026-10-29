import { Logger } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { aEspacio } from '../common/espacios';
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
  await prepararPlataforma(db);
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
    await asignarEspacios(db);
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
  await asignarEspacios(db);
  // Si por algún motivo no existe ningún superusuario, se recrea con las credenciales configuradas.
  const su = await db.maybe(`select 1 from usuarios where rol = 'superusuario' and activo`);
  if (!su) {
    const hash = await bcrypt.hash(c.superadminPassword, 10);
    await db.exec(
      `insert into usuarios (empresa_id, usuario, nombre, password_hash, rol) values ($1, $2, $2, $3, 'superusuario')
       on conflict (empresa_id, lower(usuario)) do update set activo = true, rol = 'superusuario'`,
      [empresas[0].id, c.superadminUsuario, hash],
    );
  }
}

/** Empresas creadas antes de los espacios: reciben uno a partir de su razón social. */
async function asignarEspacios(db: Db) {
  const sin = await db.many<{ id: string; razon_social: string }>('select id, razon_social from empresas where espacio is null order by creado_en');
  for (const e of sin) {
    const base = aEspacio(e.razon_social) || 'empresa';
    let espacio = base;
    for (let i = 2; await db.maybe('select 1 from empresas where lower(espacio) = $1', [espacio]); i++) espacio = `${base}-${i}`;
    await db.exec('update empresas set espacio = $2 where id = $1', [e.id, espacio]);
    log.log(`Espacio "${espacio}" asignado a ${e.razon_social}`);
  }
}

/** Crea el administrador de la plataforma si se configuró su contraseña y todavía no hay ninguno. */
async function prepararPlataforma(db: Db) {
  const c = config();
  const hay = await db.maybe('select 1 from administradores_plataforma limit 1');
  if (hay) return;
  if (!c.plataformaPassword) {
    log.warn('No hay administrador de la plataforma: defina PLATAFORMA_PASSWORD para crearlo');
    return;
  }
  await db.exec('insert into administradores_plataforma (usuario, nombre, password_hash) values ($1, $1, $2)', [c.plataformaUsuario, await bcrypt.hash(c.plataformaPassword, 10)]);
  log.log(`Administrador de la plataforma "${c.plataformaUsuario}" creado`);
}
