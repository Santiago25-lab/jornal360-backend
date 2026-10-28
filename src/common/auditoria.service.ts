import { Injectable } from '@nestjs/common';
import { Db, Ejecutor } from '../db/db.service';
import { UsuarioSesion } from './comun';

@Injectable()
export class AuditoriaService {
  constructor(private readonly db: Db) {}

  /** Registra quién hizo qué, con el valor anterior y el nuevo (HU-05). */
  async registrar(
    u: Pick<UsuarioSesion, 'id' | 'empresaId' | 'nombre'> | null,
    accion: string,
    entidad: string,
    entidadId: string | null,
    antes: unknown,
    despues: unknown,
    opciones: { motivo?: string; ip?: string; empresaId?: string; ex?: Ejecutor } = {},
  ) {
    await this.db.exec(
      `insert into auditoria (empresa_id, usuario_id, usuario_nombre, accion, entidad, entidad_id, antes, despues, motivo, ip)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        u?.empresaId ?? opciones.empresaId ?? null,
        u?.id ?? null,
        u?.nombre ?? 'Sistema',
        accion,
        entidad,
        entidadId,
        antes === undefined ? null : JSON.stringify(antes),
        despues === undefined ? null : JSON.stringify(despues),
        opciones.motivo ?? null,
        opciones.ip ?? null,
      ],
      opciones.ex,
    );
  }
}
