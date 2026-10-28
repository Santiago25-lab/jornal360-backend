import { Injectable } from '@nestjs/common';
import { Db } from '../../db/db.service';
import { Calendario, ConfigCalendario, TipoDiaEspecial } from '../../domain/calendario';
import { ConceptoNomina, ContextoNomina } from '../../domain/nomina';
import { ParametrosEnMemoria, TablasEnMemoria } from '../../domain/parametros';
import { CONFIG_HORAS_POR_DEFECTO, ConfigHoras } from '../../domain/horas';
import { CONFIGURACION_INICIAL } from '../../seed/semilla';

export type ConfiguracionEmpresa = typeof CONFIGURACION_INICIAL;

export interface ContextoEmpresa extends ContextoNomina {
  configuracion: ConfiguracionEmpresa;
  festivos: string[];
  diasEspeciales: { fecha: string; tipo: TipoDiaEspecial; sedeId: string | null }[];
  conceptosPorCodigo: Map<string, ConceptoNomina & { id: string; aplicaA: string; cuentaDebito?: string; cuentaCredito?: string; terceroCredito?: string | null }>;
}

/** Une la configuración guardada con los valores por defecto, para tolerar claves nuevas. */
export function configuracionCompleta(guardada: Partial<ConfiguracionEmpresa> | null | undefined): ConfiguracionEmpresa {
  const base = JSON.parse(JSON.stringify(CONFIGURACION_INICIAL)) as ConfiguracionEmpresa;
  const g = guardada ?? {};
  for (const k of Object.keys(base) as (keyof ConfiguracionEmpresa)[]) {
    const v = (g as any)[k];
    if (v === undefined) continue;
    (base as any)[k] = Array.isArray(base[k]) ? v : { ...(base as any)[k], ...v };
  }
  return base;
}

export const filaAConcepto = (r: any) => ({
  id: r.id,
  codigo: r.codigo,
  nombre: r.nombre,
  descripcion: r.descripcion,
  tipo: r.tipo,
  categoria: r.categoria ?? undefined,
  formula: r.formula,
  salarial: r.salarial,
  baseIbc: r.base_ibc,
  baseArl: r.base_arl,
  baseParafiscales: r.base_parafiscales,
  basePrestaciones: r.base_prestaciones,
  baseVacaciones: r.base_vacaciones,
  baseRetencion: r.base_retencion,
  cuenta40: r.cuenta40,
  porHoras: r.por_horas,
  requiereNovedad: r.requiere_novedad,
  orden: r.orden,
  redondeo: r.redondeo,
  esLegal: r.es_legal,
  baseLegal: r.base_legal,
  cuentaDebito: r.cuenta_debito,
  cuentaCredito: r.cuenta_credito,
  terceroCredito: r.tercero_credito,
  aplicaA: r.aplica_a,
  estado: r.estado,
  version: r.version,
});

@Injectable()
export class ContextoService {
  constructor(private readonly db: Db) {}

  async cargar(empresaId: string, opciones: { incluirBorradores?: string[] } = {}): Promise<ContextoEmpresa> {
    const [empresa, vigencias, tablas, conceptos, festivos, especiales] = await Promise.all([
      this.db.one('select exonerada, configuracion from empresas where id = $1', [empresaId]),
      this.db.many(
        `select p.codigo, v.desde, v.valor from parametros_vigencias v join parametros p on p.id = v.parametro_id where p.empresa_id = $1`,
        [empresaId],
      ),
      this.db.many('select codigo, columnas, filas from tablas_parametro where empresa_id = $1', [empresaId]),
      this.db.many(
        `select * from conceptos where empresa_id = $1 and (estado = 'activo' or (estado = 'borrador' and codigo = any($2::text[]))) order by orden`,
        [empresaId, opciones.incluirBorradores ?? []],
      ),
      this.db.many(`select to_char(fecha, 'YYYY-MM-DD') as fecha from festivos where empresa_id = $1`, [empresaId]),
      this.db.many(`select to_char(fecha, 'YYYY-MM-DD') as fecha, tipo, sede_id from dias_especiales where empresa_id = $1`, [empresaId]),
    ]);
    const lista = conceptos.map(filaAConcepto);
    return {
      conceptos: lista as ConceptoNomina[],
      parametros: new ParametrosEnMemoria(vigencias.map((v) => ({ codigo: v.codigo, desde: v.desde, valor: v.valor }))),
      tablas: new TablasEnMemoria(tablas.map((t) => ({ codigo: t.codigo, columnas: t.columnas, filas: t.filas }))),
      empresa: { exonerada: empresa.exonerada },
      configuracion: configuracionCompleta(empresa.configuracion),
      festivos: festivos.map((f) => f.fecha),
      diasEspeciales: especiales.map((d) => ({ fecha: d.fecha, tipo: d.tipo, sedeId: d.sede_id })),
      conceptosPorCodigo: new Map(lista.map((c) => [c.codigo, c as any])),
    };
  }

  /**
   * Calendario de un empleado: la configuración de su área, sede o grupo reemplaza
   * la de la empresa (HU-61). Más específico gana: área, luego sede, luego grupo.
   */
  calendario(ctx: ContextoEmpresa, overrides: (Partial<ConfigCalendario> | null | undefined)[] = [], sedeId?: string | null): Calendario {
    const base = { ...ctx.configuracion.calendario };
    for (const o of [...overrides].reverse()) if (o) Object.assign(base, o);
    return new Calendario({
      diasLaborales: base.diasLaborales,
      diaDescanso: base.diaDescanso,
      sabadoHabilVacaciones: base.sabadoHabilVacaciones,
      festivos: new Set(ctx.festivos),
      diasEspeciales: new Map(ctx.diasEspeciales.filter((d) => !d.sedeId || d.sedeId === sedeId).map((d) => [d.fecha, d.tipo])),
    });
  }

  async calendarioEmpleado(ctx: ContextoEmpresa, empleadoId: string): Promise<Calendario> {
    const r = await this.db.maybe(
      `select a.calendario as area, s.calendario as sede, g.calendario as grupo, e.sede_id
       from empleados e left join areas a on a.id = e.area_id left join sedes s on s.id = e.sede_id left join grupos_pago g on g.id = e.grupo_pago_id
       where e.id = $1`,
      [empleadoId],
    );
    return this.calendario(ctx, [r?.area, r?.sede, r?.grupo], r?.sede_id);
  }

  configHoras(ctx: ContextoEmpresa, fecha: string): ConfigHoras {
    const h = ctx.configuracion.horas;
    return {
      ...CONFIG_HORAS_POR_DEFECTO,
      ...h,
      maxExtrasDia: ctx.parametros.valor('MAX_EXTRAS_DIA', fecha)?.toNumber() ?? 2,
      maxExtrasSemana: ctx.parametros.valor('MAX_EXTRAS_SEMANA', fecha)?.toNumber() ?? 12,
    };
  }
}
