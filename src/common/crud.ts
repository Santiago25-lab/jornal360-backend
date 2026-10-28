import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Type } from '@nestjs/common';
import { z, ZodObject, ZodRawShape } from 'zod';
import { Db } from '../db/db.service';
import { AuditoriaService } from './auditoria.service';
import { ErrorNegocio, Usuario, UsuarioSesion, Validar } from './comun';
import { camel, camelLista } from './util';

export interface DefinicionCrud<S extends ZodRawShape> {
  ruta: string;
  tabla: string;
  entidad: string;
  esquema: ZodObject<S>;
  /** campo camelCase -> columna */
  columnas: Record<string, string>;
  orden: string;
  /** En lugar de borrar, marca esta columna en false (si hay datos relacionados). */
  columnaActivo?: string;
  filtros?: Record<string, string>;
}

/** Crea un controlador REST completo (listar, ver, crear, editar, borrar) con auditoría. */
export function crearCrud<S extends ZodRawShape>(def: DefinicionCrud<S>): Type<unknown> {
  const Editar = def.esquema.partial();
  const cols = Object.entries(def.columnas);

  @Controller(def.ruta)
  class CrudController {
    constructor(
      readonly db: Db,
      readonly auditoria: AuditoriaService,
    ) {}

    @Get()
    async listar(@Usuario() u: UsuarioSesion, @Query() q: Record<string, string>) {
      const cond = ['empresa_id = $1'];
      const vals: unknown[] = [u.empresaId];
      for (const [k, col] of Object.entries(def.filtros ?? {}))
        if (q[k] !== undefined && q[k] !== '') {
          vals.push(q[k]);
          cond.push(`${col} = $${vals.length}`);
        }
      return camelLista(await this.db.many(`select * from ${def.tabla} where ${cond.join(' and ')} order by ${def.orden}`, vals));
    }

    @Get(':id')
    async ver(@Usuario() u: UsuarioSesion, @Param('id') id: string) {
      const r = await this.db.maybe(`select * from ${def.tabla} where id = $1 and empresa_id = $2`, [id, u.empresaId]);
      if (!r) throw new ErrorNegocio('No encontrado', 404);
      return camel(r);
    }

    @Post()
    async crear(@Usuario() u: UsuarioSesion, @Body(new Validar(def.esquema)) d: z.infer<typeof def.esquema>) {
      const presentes = cols.filter(([k]) => (d as any)[k] !== undefined);
      const valores = presentes.map(([k]) => val((d as any)[k]));
      const r = await this.db.one(
        `insert into ${def.tabla} (empresa_id${presentes.map(([, c]) => ', ' + c).join('')})
         values ($1${presentes.map((_, i) => `, $${i + 2}`).join('')}) returning *`,
        [u.empresaId, ...valores],
      );
      await this.auditoria.registrar(u, 'crear', def.entidad, r.id, null, r);
      return camel(r);
    }

    @Patch(':id')
    async editar(@Usuario() u: UsuarioSesion, @Param('id') id: string, @Body(new Validar(Editar)) d: Record<string, unknown>) {
      const antes = await this.db.maybe(`select * from ${def.tabla} where id = $1 and empresa_id = $2`, [id, u.empresaId]);
      if (!antes) throw new ErrorNegocio('No encontrado', 404);
      const presentes = cols.filter(([k]) => d[k] !== undefined);
      if (!presentes.length) return camel(antes);
      const r = await this.db.one(
        `update ${def.tabla} set ${presentes.map(([, c], i) => `${c} = $${i + 3}`).join(', ')} where id = $1 and empresa_id = $2 returning *`,
        [id, u.empresaId, ...presentes.map(([k]) => val(d[k]))],
      );
      await this.auditoria.registrar(u, 'editar', def.entidad, id, antes, r);
      return camel(r);
    }

    @Delete(':id')
    async borrar(@Usuario() u: UsuarioSesion, @Param('id') id: string) {
      const antes = await this.db.maybe(`select * from ${def.tabla} where id = $1 and empresa_id = $2`, [id, u.empresaId]);
      if (!antes) throw new ErrorNegocio('No encontrado', 404);
      try {
        await this.db.exec(`delete from ${def.tabla} where id = $1 and empresa_id = $2`, [id, u.empresaId]);
        await this.auditoria.registrar(u, 'borrar', def.entidad, id, antes, null);
        return { ok: true, borrado: true };
      } catch (e) {
        if ((e as { code?: string }).code === '23503' && def.columnaActivo) {
          await this.db.exec(`update ${def.tabla} set ${def.columnaActivo} = false where id = $1`, [id]);
          await this.auditoria.registrar(u, 'inactivar', def.entidad, id, antes, { ...antes, [def.columnaActivo]: false });
          return { ok: true, borrado: false, mensaje: 'Tiene datos relacionados: se inactivó en lugar de borrarse' };
        }
        throw e;
      }
    }
  }
  Object.defineProperty(CrudController, 'name', { value: `Crud_${def.entidad}` });
  return CrudController;
}

const val = (v: unknown) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
