import { Body, Controller, Delete, Get, Injectable, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { z } from 'zod';
import { AuditoriaService } from '../../common/auditoria.service';
import { ErrorNegocio, Usuario, UsuarioSesion, Validar } from '../../common/comun';
import { crearPdf, encabezado, tabla } from '../../common/pdf';
import { camel, camelLista, fechaLocal, nombreCompleto, pesos, zFecha } from '../../common/util';
import { Db, Ejecutor } from '../../db/db.service';
import { D, Decimal, sum } from '../../domain/decimal';
import { finDeMes, sumarDias, sumarMeses } from '../../domain/fechas';
import { normalizarId } from '../../domain/formulas';
import { TipoHora } from '../../domain/horas';
import { ConceptoNomina, EntradaNomina, liquidarEmpleado, NovedadDias, ResultadoNomina } from '../../domain/nomina';
import { ContextoEmpresa, ContextoService } from '../configuracion/contexto.service';

const PeriodoDto = z.object({
  nombre: z.string().trim().min(1).optional(),
  grupoPagoId: z.string().uuid(),
  desde: zFecha,
  hasta: zFecha,
  fechaPago: zFecha.optional().nullable(),
});

export interface PeriodoFila {
  id: string;
  empresa_id: string;
  grupo_pago_id: string | null;
  tipo: string;
  nombre: string;
  desde: string;
  hasta: string;
  fecha_pago: string | null;
  estado: 'abierto' | 'liquidado' | 'aprobado' | 'cerrado';
  liquidado_por: string | null;
}

@Injectable()
export class NominaService {
  constructor(
    private readonly db: Db,
    private readonly auditoria: AuditoriaService,
    private readonly contexto: ContextoService,
  ) {}

  // ---------- Periodos ----------

  async periodos(u: UsuarioSesion, q: { tipo?: string; estado?: string }) {
    return camelLista(
      await this.db.many(
        `select p.*, g.nombre as grupo_pago, g.periodicidad,
           (select count(*) from liquidaciones l where l.periodo_id = p.id)::int as empleados,
           (select coalesce(sum(neto), 0) from liquidaciones l where l.periodo_id = p.id) as total_neto,
           (select coalesce(sum(costo_total), 0) from liquidaciones l where l.periodo_id = p.id) as total_costo
         from periodos p left join grupos_pago g on g.id = p.grupo_pago_id
         where p.empresa_id = $1 and ($2::text is null or p.tipo = $2) and ($3::text is null or p.estado = $3)
         order by p.desde desc, p.creado_en desc`,
        [u.empresaId, q.tipo || null, q.estado || null],
      ),
    );
  }

  async periodo(u: UsuarioSesion, id: string): Promise<PeriodoFila> {
    const p = await this.db.maybe<PeriodoFila>('select * from periodos where id = $1 and empresa_id = $2', [id, u.empresaId]);
    if (!p) throw new ErrorNegocio('Periodo no encontrado', 404);
    return p;
  }

  /** Propone el siguiente periodo de un grupo de pago según su periodicidad. */
  async sugerir(u: UsuarioSesion, grupoPagoId: string) {
    const g = await this.db.maybe('select * from grupos_pago where id = $1 and empresa_id = $2', [grupoPagoId, u.empresaId]);
    if (!g) throw new ErrorNegocio('Grupo de pago no encontrado', 404);
    const ultimo = await this.db.maybe(`select hasta from periodos where empresa_id = $1 and grupo_pago_id = $2 and tipo = 'nomina' order by hasta desc limit 1`, [u.empresaId, grupoPagoId]);
    const hoy = fechaLocal();
    const desde = ultimo ? sumarDias(ultimo.hasta, 1) : `${hoy.slice(0, 7)}-01`;
    let hasta: string;
    if (g.periodicidad === 'mensual') hasta = finDeMes(desde);
    else if (g.periodicidad === 'quincenal') hasta = Number(desde.slice(8)) <= 15 ? `${desde.slice(0, 7)}-15` : finDeMes(desde);
    else hasta = sumarDias(desde, 6);
    const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const mes = meses[Number(desde.slice(5, 7)) - 1];
    const nombre =
      g.periodicidad === 'mensual'
        ? `Nómina ${mes} ${desde.slice(0, 4)}`
        : g.periodicidad === 'quincenal'
          ? `Nómina ${Number(desde.slice(8)) <= 15 ? 'primera' : 'segunda'} quincena de ${mes} ${desde.slice(0, 4)}`
          : `Nómina semana del ${desde}`;
    return { grupoPagoId, desde, hasta, fechaPago: sumarDias(hasta, g.dias_pago_despues ?? 0), nombre };
  }

  async crearPeriodo(u: UsuarioSesion, d: z.infer<typeof PeriodoDto>) {
    if (d.hasta < d.desde) throw new ErrorNegocio('La fecha final es anterior a la inicial');
    const cruce = await this.db.maybe(
      `select nombre from periodos where empresa_id = $1 and grupo_pago_id = $2 and tipo = 'nomina' and desde <= $4 and hasta >= $3`,
      [u.empresaId, d.grupoPagoId, d.desde, d.hasta],
    );
    if (cruce) throw new ErrorNegocio(`Se cruza con el periodo "${cruce.nombre}"`);
    const nombre = d.nombre ?? (await this.sugerir(u, d.grupoPagoId)).nombre;
    const r = await this.db.one(
      `insert into periodos (empresa_id, grupo_pago_id, tipo, nombre, desde, hasta, fecha_pago) values ($1, $2, 'nomina', $3, $4, $5, $6) returning *`,
      [u.empresaId, d.grupoPagoId, nombre, d.desde, d.hasta, d.fechaPago ?? d.hasta],
    );
    await this.auditoria.registrar(u, 'crear', 'periodo', r.id, null, r);
    return camel(r);
  }

  async borrarPeriodo(u: UsuarioSesion, id: string) {
    const p = await this.periodo(u, id);
    if (p.estado === 'aprobado' || p.estado === 'cerrado') throw new ErrorNegocio('No se puede borrar un periodo aprobado o cerrado');
    await this.db.exec('delete from periodos where id = $1', [id]);
    await this.auditoria.registrar(u, 'borrar', 'periodo', id, p, null);
    return { ok: true };
  }

  // ---------- Construcción de las entradas del motor ----------

  /** Empleados con contrato que cubre el periodo (y del grupo de pago, si aplica). */
  private async empleadosDelPeriodo(empresaId: string, p: Pick<PeriodoFila, 'desde' | 'hasta' | 'grupo_pago_id'>, empleadoIds?: string[]) {
    return this.db.many(
      `select e.*, c.id as contrato_id, c.tipo as contrato_tipo, c.fecha_inicio, c.fecha_fin, c.salario_integral, c.factor_prestacional, c.fase_aprendiz,
              c.auxilio_transporte, c.clase_riesgo, c.tipo_salario, c.horas_semanales
       from empleados e
       join lateral (
         select * from contratos c where c.empleado_id = e.id and c.fecha_inicio <= $3 and (c.fecha_fin is null or c.fecha_fin >= $2)
         order by c.fecha_inicio desc limit 1
       ) c on true
       where e.empresa_id = $1 and ($4::uuid is null or e.grupo_pago_id = $4) and ($5::uuid[] is null or e.id = any($5))
       order by e.apellidos, e.nombres`,
      [empresaId, p.desde, p.hasta, p.grupo_pago_id, empleadoIds ?? null],
    );
  }

  private async conceptosDe(ctx: ContextoEmpresa, empresaId: string, e: any, desde: string, hasta: string) {
    const asign = await this.db.many(
      `select a.*, c.codigo from conceptos_asignaciones a join conceptos c on c.id = a.concepto_id
       where a.empresa_id = $1 and a.desde <= $3 and (a.hasta is null or a.hasta >= $2)`,
      [empresaId, desde, hasta],
    );
    const coincide = (a: any) => {
      switch (a.tipo_objetivo) {
        case 'empleado':
          return a.objetivo === e.id;
        case 'cargo':
          return (e.cargo ?? '').trim().toLowerCase() === a.objetivo.trim().toLowerCase();
        case 'centro_costo':
          return a.objetivo === e.centro_costo_id;
        case 'area':
          return a.objetivo === e.area_id;
        case 'sede':
          return a.objetivo === e.sede_id;
        case 'grupo':
          return a.objetivo === e.grupo_pago_id;
      }
      return false;
    };
    const valores: Record<string, string> = {};
    const asignados = new Set<string>();
    for (const a of asign)
      if (coincide(a)) {
        asignados.add(a.codigo);
        if (a.valor !== null) valores[a.codigo] = D(valores[a.codigo] ?? 0).plus(D(a.valor)).toFixed();
      }
    const conceptos = ctx.conceptos.filter((c: any) => c.aplicaA !== 'asignados' || asignados.has(c.codigo));
    return { conceptos, valores };
  }

  async construirEntrada(ctx: ContextoEmpresa, empresaId: string, p: Pick<PeriodoFila, 'id' | 'desde' | 'hasta'>, e: any) {
    const historial = await this.db.many('select desde, salario from historial_salarial where contrato_id = $1 order by desde', [e.contrato_id]);
    const novDias = await this.db.many(
      `select id, tipo, desde, hasta, dias_previos, descripcion from novedades where empleado_id = $1 and clase = 'dias' and estado = 'aprobada' and desde <= $3 and hasta >= $2`,
      [e.id, p.desde, p.hasta],
    );
    const novValor = await this.db.many(
      `select id, tipo, valor, cantidad, fecha from novedades where empleado_id = $1 and clase = 'valor' and estado = 'aprobada' and fecha between $2 and $3`,
      [e.id, p.desde, p.hasta],
    );
    const horas = await this.db.many(
      `select fecha, tipo, horas from horas_registradas where empleado_id = $1 and estado = 'aprobada' and tipo <> 'HOD' and fecha between $2 and $3`,
      [e.id, p.desde, p.hasta],
    );
    const prestamos = await this.db.many(`select * from prestamos where empleado_id = $1 and activo and saldo > 0 and fecha_inicio <= $2`, [e.id, p.hasta]);
    const embargos = await this.db.many(`select * from embargos where empleado_id = $1 and activo and (saldo is null or saldo > 0)`, [e.id]);

    // Acumulado del mes para la retención (nóminas quincenales o semanales del mismo mes).
    const inicioMes = `${p.hasta.slice(0, 7)}-01`;
    const otras = await this.db.many(
      `select l.resultado from liquidaciones l join periodos pe on pe.id = l.periodo_id
       where l.empleado_id = $1 and pe.tipo = 'nomina' and pe.id <> $2 and pe.desde >= $3 and pe.hasta < $4`,
      [e.id, p.id, inicioMes, p.desde],
    );
    const acumuladoMes = otras.length
      ? {
          ingresosRetencion: sum(otras.map((o) => o.resultado?.bases?.baseRetencionPeriodo ?? 0)).toFixed(),
          noConstitutivos: sum(otras.map((o) => o.resultado?.bases?.noConstitutivosPeriodo ?? 0)).toFixed(),
          retencionPracticada: sum(otras.flatMap((o) => (o.resultado?.lineas ?? []).filter((l: any) => l.concepto === 'RETENCION_FUENTE').map((l: any) => l.valor))).toFixed(),
        }
      : undefined;

    // IBC del mes anterior para valorar incapacidades.
    const anterior = await this.db.maybe(
      `select l.resultado from liquidaciones l join periodos pe on pe.id = l.periodo_id where l.empleado_id = $1 and pe.tipo = 'nomina' and pe.hasta < $2 order by pe.hasta desc limit 1`,
      [e.id, p.desde],
    );
    let ibcMesAnterior: string | undefined;
    const ra: ResultadoNomina | undefined = anterior?.resultado;
    if (ra?.bases?.ibcSalud && ra.dias?.cotizados) ibcMesAnterior = D(ra.bases.ibcSalud).div(ra.dias.cotizados).mul(30).toFixed();

    // Base de vacaciones para salario variable: promedio del último año (CST art. 192).
    let baseVacaciones: string | undefined;
    if (e.tipo_salario === 'variable') {
      const desde12 = sumarMeses(p.desde, -12);
      const codigosVac = ctx.conceptos.filter((c) => c.baseVacaciones).map((c) => c.codigo);
      const tot = await this.db.one(
        `select coalesce(sum(ll.valor), 0) as v, count(distinct to_char(pe.hasta, 'YYYY-MM'))::int as meses
         from liquidacion_lineas ll join periodos pe on pe.id = ll.periodo_id
         where ll.empleado_id = $1 and pe.tipo = 'nomina' and pe.hasta >= $2 and pe.hasta < $3 and ll.concepto = any($4)`,
        [e.id, desde12, p.desde, codigosVac],
      );
      const ini = await this.db.one(
        `select coalesce(sum(valor), 0) as v, count(*)::int as meses from saldos_iniciales where empleado_id = $1 and (tipo like 'variable_mes:%' or tipo like 'salario_mes:%') and fecha_corte >= $2`,
        [e.id, desde12],
      );
      const meses = Math.max(1, tot.meses + ini.meses);
      if (tot.meses + ini.meses > 0) baseVacaciones = D(tot.v).plus(D(ini.v)).div(meses).toFixed();
    }

    const campos: Record<string, string> = {};
    for (const c of ctx.configuracion.campos.filter((x) => x.tipo === 'numero')) {
      const v = e.campos_adicionales?.[c.codigo];
      if (v !== undefined && v !== null && v !== '' && !isNaN(Number(v))) campos[normalizarId(c.codigo)] = String(v);
    }

    const { conceptos, valores } = await this.conceptosDe(ctx, empresaId, e, p.desde, p.hasta);
    const entrada: EntradaNomina = {
      periodo: { desde: p.desde, hasta: p.hasta },
      empleado: {
        id: e.id,
        nombre: nombreCompleto(e),
        fechaIngreso: e.fecha_inicio,
        esPensionado: e.es_pensionado,
        claseRiesgo: e.clase_riesgo,
        procedimientoRetencion: e.procedimiento_retencion,
        porcentajeProcedimiento2: e.porcentaje_proc2 ?? undefined,
        tieneDependiente: e.tiene_dependiente && (!e.soportes_retencion_hasta || e.soportes_retencion_hasta >= p.hasta),
        dependientesAdicionales: e.dependientes_adicionales,
        interesesVivienda: !e.soportes_retencion_hasta || e.soportes_retencion_hasta >= p.hasta ? e.intereses_vivienda : 0,
        medicinaPrepagada: !e.soportes_retencion_hasta || e.soportes_retencion_hasta >= p.hasta ? e.medicina_prepagada : 0,
        aportesVoluntarios: e.aportes_voluntarios,
        variables: campos,
      },
      contrato: {
        tipo: e.contrato_tipo,
        fechaInicio: e.fecha_inicio,
        fechaFin: e.fecha_fin,
        historialSalario: historial.map((h) => ({ desde: h.desde, salario: h.salario })),
        salarioIntegral: e.salario_integral,
        factorPrestacional: e.factor_prestacional ?? undefined,
        faseAprendiz: e.fase_aprendiz ?? undefined,
        auxilioTransporte: e.auxilio_transporte,
      },
      novedadesDias: novDias.map((n): NovedadDias => ({ id: n.id, tipo: n.tipo, desde: n.desde, hasta: n.hasta, diasPrevios: n.dias_previos, descripcion: n.descripcion })),
      novedadesValor: novValor.map((n) => ({ id: n.id, concepto: n.tipo, valor: n.valor ?? undefined, cantidad: n.cantidad ?? undefined, fecha: n.fecha })),
      horas: horas.map((h) => ({ fecha: h.fecha, tipo: h.tipo as TipoHora, horas: h.horas })),
      prestamos: prestamos.map((x) => ({ id: x.id, descripcion: x.descripcion, cuota: x.cuota, saldo: x.saldo, tipo: x.tipo })),
      embargos: embargos.map((x) => ({ id: x.id, descripcion: x.descripcion, tipo: x.tipo, valorFijo: x.valor_fijo ?? undefined, porcentaje: x.porcentaje ?? undefined, saldo: x.saldo, prioridad: x.prioridad ?? undefined })),
      acumuladoMes,
      ibcMesAnterior,
      baseVacaciones,
      valoresAsignados: valores,
    };
    return { entrada, conceptos };
  }

  /** Liquida en memoria (no guarda). */
  async calcular(empresaId: string, p: Pick<PeriodoFila, 'id' | 'desde' | 'hasta' | 'grupo_pago_id'>, empleadoIds?: string[], opciones: { incluirBorradores?: string[] } = {}) {
    const ctx = await this.contexto.cargar(empresaId, opciones);
    const empleados = await this.empleadosDelPeriodo(empresaId, p, empleadoIds);
    const resultados: { empleado: any; resultado: ResultadoNomina }[] = [];
    const errores: { empleado: string; mensaje: string }[] = [];
    for (const e of empleados) {
      if (!e.eps_id && !e.es_pensionado) errores.push({ empleado: nombreCompleto(e), mensaje: 'No tiene EPS registrada' });
      const { entrada, conceptos } = await this.construirEntrada(ctx, empresaId, p, e);
      const r = liquidarEmpleado(entrada, { ...ctx, conceptos: conceptos as ConceptoNomina[] });
      if (r) resultados.push({ empleado: e, resultado: r });
    }
    return { resultados, errores, ctx };
  }

  async liquidar(u: UsuarioSesion, id: string, d: { empleadoIds?: string[] } = {}) {
    const p = await this.periodo(u, id);
    if (p.estado === 'aprobado' || p.estado === 'cerrado') throw new ErrorNegocio('El periodo ya está aprobado o cerrado. Reábralo para volver a liquidar');
    const { resultados, errores } = await this.calcular(u.empresaId, p, d.empleadoIds);
    await this.db.tx(async (c) => {
      if (d.empleadoIds?.length) await this.db.exec('delete from liquidaciones where periodo_id = $1 and empleado_id = any($2)', [id, d.empleadoIds], c);
      else await this.db.exec('delete from liquidaciones where periodo_id = $1', [id], c);
      for (const r of resultados) await this.guardarResultado(c, u.empresaId, id, r.empleado.id, r.empleado.contrato_id, r.resultado);
      await this.db.exec(`update periodos set estado = 'liquidado', liquidado_en = now(), liquidado_por = $2 where id = $1`, [id, u.id], c);
    });
    await this.auditoria.registrar(u, 'liquidar', 'periodo', id, null, { empleados: resultados.length });
    return { ...(await this.resumen(u, id)), errores };
  }

  async guardarResultado(c: Ejecutor, empresaId: string, periodoId: string, empleadoId: string, contratoId: string | null, r: ResultadoNomina) {
    const l = await this.db.one(
      `insert into liquidaciones (empresa_id, periodo_id, empleado_id, contrato_id, resultado, total_devengos, total_deducciones, neto, aportes, provisiones, costo_total)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [empresaId, periodoId, empleadoId, contratoId, JSON.stringify(r), r.totales.devengos, r.totales.deducciones, r.totales.neto, r.totales.aportesEmpleador, r.totales.provisiones, r.totales.costoTotal],
      c,
    );
    if (r.lineas.length) {
      const vals: unknown[] = [];
      const filas = r.lineas.map((x, i) => {
        vals.push(l.id, empresaId, periodoId, empleadoId, x.concepto, x.nombre, x.tipo, x.categoria ?? null, x.cantidad ?? null, x.valor, x.referencia ?? null);
        const b = i * 11;
        return `(${Array.from({ length: 11 }, (_, k) => `$${b + k + 1}`).join(', ')})`;
      });
      await this.db.exec(
        `insert into liquidacion_lineas (liquidacion_id, empresa_id, periodo_id, empleado_id, concepto, nombre, tipo, categoria, cantidad, valor, referencia) values ${filas.join(', ')}`,
        vals,
        c,
      );
    }
  }

  async simular(u: UsuarioSesion, id: string, empleadoIds?: string[]) {
    const p = await this.periodo(u, id);
    const { resultados, errores } = await this.calcular(u.empresaId, p, empleadoIds);
    return {
      errores,
      totales: this.totales(resultados.map((r) => r.resultado)),
      empleados: resultados.map((r) => ({ empleadoId: r.empleado.id, empleado: nombreCompleto(r.empleado), ...r.resultado.totales, alertas: r.resultado.alertas })),
    };
  }

  private totales(rs: ResultadoNomina[]) {
    const t = (k: keyof ResultadoNomina['totales']) => sum(rs.map((r) => r.totales[k])).toFixed();
    return { empleados: rs.length, devengos: t('devengos'), deducciones: t('deducciones'), neto: t('neto'), aportesEmpleador: t('aportesEmpleador'), provisiones: t('provisiones'), costoTotal: t('costoTotal') };
  }

  async resumen(u: UsuarioSesion, id: string) {
    const p = await this.periodo(u, id);
    const liqs = await this.db.many(
      `select l.id, l.empleado_id, l.neto, l.total_devengos, l.total_deducciones, l.aportes, l.provisiones, l.costo_total, l.resultado->'alertas' as alertas,
              l.resultado->'pendientes' as pendientes, e.nombres, e.apellidos, e.numero_documento, cc.nombre as centro_costo
       from liquidaciones l join empleados e on e.id = l.empleado_id left join centros_costo cc on cc.id = e.centro_costo_id where l.periodo_id = $1 order by e.apellidos`,
      [id],
    );
    const conceptos = await this.db.many(
      `select concepto, nombre, tipo, sum(valor) as total, count(*)::int as empleados from liquidacion_lineas where periodo_id = $1 group by concepto, nombre, tipo order by tipo, total desc`,
      [id],
    );
    const t = (k: string) => sum(liqs.map((l) => l[k])).toFixed();
    return {
      periodo: camel(p),
      totales: { empleados: liqs.length, devengos: t('total_devengos'), deducciones: t('total_deducciones'), neto: t('neto'), aportesEmpleador: t('aportes'), provisiones: t('provisiones'), costoTotal: t('costo_total') },
      empleados: liqs.map((l) => ({
        liquidacionId: l.id,
        empleadoId: l.empleado_id,
        empleado: nombreCompleto(l),
        documento: l.numero_documento,
        centroCosto: l.centro_costo,
        devengos: l.total_devengos,
        deducciones: l.total_deducciones,
        neto: l.neto,
        costoTotal: l.costo_total,
        alertas: l.alertas ?? [],
        pendientes: l.pendientes ?? [],
      })),
      conceptos: camelLista(conceptos),
      alertas: liqs.reduce((a, l) => a + (l.alertas ?? []).filter((x: any) => x.nivel !== 'info').length, 0),
    };
  }

  async detalle(u: UsuarioSesion, periodoId: string, empleadoId: string) {
    await this.periodo(u, periodoId);
    const l = await this.db.maybe(
      `select l.*, e.nombres, e.apellidos, e.numero_documento, e.tipo_documento, e.cargo from liquidaciones l join empleados e on e.id = l.empleado_id where l.periodo_id = $1 and l.empleado_id = $2`,
      [periodoId, empleadoId],
    );
    if (!l) throw new ErrorNegocio('El empleado no está liquidado en este periodo', 404);
    return { empleado: nombreCompleto(l), documento: `${l.tipo_documento} ${l.numero_documento}`, cargo: l.cargo, ...l.resultado };
  }

  /** Comparativo con el periodo anterior del mismo grupo (HU-55). */
  async comparativo(u: UsuarioSesion, id: string) {
    const p = await this.periodo(u, id);
    const ctx = await this.contexto.cargar(u.empresaId);
    const umbral = D(ctx.configuracion.aprobacion.umbralVariacion);
    const ant = await this.db.maybe(
      `select * from periodos where empresa_id = $1 and tipo = $2 and coalesce(grupo_pago_id::text, '') = coalesce($3::text, '') and hasta < $4 order by hasta desc limit 1`,
      [u.empresaId, p.tipo, p.grupo_pago_id, p.desde],
    );
    const porConcepto = async (pid: string) =>
      new Map((await this.db.many('select concepto, nombre, tipo, sum(valor) as total from liquidacion_lineas where periodo_id = $1 group by concepto, nombre, tipo', [pid])).map((r) => [r.concepto, r]));
    const porEmpleado = async (pid: string) => new Map((await this.db.many('select empleado_id, neto from liquidaciones where periodo_id = $1', [pid])).map((r) => [r.empleado_id, r.neto]));
    const actualC = await porConcepto(id);
    const anteriorC = ant ? await porConcepto(ant.id) : new Map();
    const variacion = (a: Decimal, b: Decimal) => (b.isZero() ? (a.isZero() ? D(0) : D(1)) : a.minus(b).div(b));
    const conceptos = [...new Set([...actualC.keys(), ...anteriorC.keys()])].map((k) => {
      const a = D(actualC.get(k)?.total ?? 0);
      const b = D(anteriorC.get(k)?.total ?? 0);
      const v = variacion(a, b);
      return { concepto: k, nombre: actualC.get(k)?.nombre ?? anteriorC.get(k)?.nombre, tipo: actualC.get(k)?.tipo ?? anteriorC.get(k)?.tipo, actual: a.toFixed(), anterior: b.toFixed(), variacion: v.toDecimalPlaces(4).toFixed(), resaltar: v.abs().gt(umbral) };
    });
    const actualE = await porEmpleado(id);
    const anteriorE = ant ? await porEmpleado(ant.id) : new Map();
    const nombres = new Map((await this.db.many('select id, nombres, apellidos from empleados where empresa_id = $1', [u.empresaId])).map((e) => [e.id, nombreCompleto(e)]));
    const empleados = [...new Set([...actualE.keys(), ...anteriorE.keys()])].map((k) => {
      const a = D(actualE.get(k) ?? 0);
      const b = D(anteriorE.get(k) ?? 0);
      const v = variacion(a, b);
      return { empleadoId: k, empleado: nombres.get(k), actual: a.toFixed(), anterior: b.toFixed(), variacion: v.toDecimalPlaces(4).toFixed(), resaltar: v.abs().gt(umbral), nuevo: !anteriorE.has(k), salio: !actualE.has(k) };
    });
    return { anterior: ant ? camel(ant) : null, umbral: umbral.toFixed(), conceptos, empleados };
  }

  // ---------- Aprobación y cierre (HU-55, HU-56) ----------

  async aprobar(u: UsuarioSesion, id: string) {
    const p = await this.periodo(u, id);
    if (p.estado !== 'liquidado') throw new ErrorNegocio(p.estado === 'abierto' ? 'Primero liquide el periodo' : 'El periodo ya está aprobado');
    const ctx = await this.contexto.cargar(u.empresaId);
    if (ctx.configuracion.aprobacion.separarLiquidaAprueba && p.liquidado_por === u.id) throw new ErrorNegocio('La misma persona que liquidó no puede aprobar la nómina');
    const errores = await this.db.many(`select 1 from liquidaciones where periodo_id = $1 and resultado->'alertas' @> '[{"nivel":"error"}]' limit 1`, [id]);
    if (errores.length) throw new ErrorNegocio('Hay liquidaciones con errores. Revise las alertas antes de aprobar');
    await this.db.exec(`update periodos set estado = 'aprobado', aprobado_por = $2, aprobado_en = now() where id = $1`, [id, u.id]);
    await this.auditoria.registrar(u, 'aprobar', 'periodo', id, { estado: p.estado }, { estado: 'aprobado' });
    return camel(await this.periodo(u, id));
  }

  async rechazar(u: UsuarioSesion, id: string, motivo: string) {
    const p = await this.periodo(u, id);
    if (p.estado !== 'liquidado' && p.estado !== 'aprobado') throw new ErrorNegocio('Solo se puede devolver una nómina liquidada o aprobada');
    await this.db.exec(`update periodos set estado = 'abierto', aprobado_por = null, aprobado_en = null where id = $1`, [id]);
    await this.auditoria.registrar(u, 'rechazar', 'periodo', id, { estado: p.estado }, { estado: 'abierto' }, { motivo });
    return camel(await this.periodo(u, id));
  }

  /** Aplica los saldos de préstamos y embargos descontados. signo = -1 al cerrar, +1 al reabrir. */
  private async aplicarSaldos(c: Ejecutor, periodoId: string, signo: 1 | -1) {
    const lineas = await this.db.many(`select referencia, valor from liquidacion_lineas where periodo_id = $1 and referencia is not null and tipo = 'deduccion'`, [periodoId], c);
    for (const l of lineas) {
      const v = D(l.valor).mul(signo).toFixed();
      await this.db.exec(`update prestamos set saldo = saldo + $2, activo = (saldo + $2) > 0 where id::text = $1`, [l.referencia, v], c);
      await this.db.exec(`update embargos set saldo = saldo + $2, activo = case when saldo is null then activo else (saldo + $2) > 0 end where id::text = $1 and saldo is not null`, [l.referencia, v], c);
    }
  }

  async cerrar(u: UsuarioSesion, id: string) {
    const p = await this.periodo(u, id);
    if (p.estado !== 'aprobado') throw new ErrorNegocio('Solo se puede cerrar una nómina aprobada');
    await this.db.tx(async (c) => {
      await this.aplicarSaldos(c, id, -1);
      await this.db.exec(
        `insert into pagos (empresa_id, periodo_id, empleado_id, valor) select empresa_id, periodo_id, empleado_id, neto from liquidaciones where periodo_id = $1 and neto > 0
         on conflict (periodo_id, empleado_id) do update set valor = excluded.valor`,
        [id],
        c,
      );
      await this.db.exec(`update periodos set estado = 'cerrado', cerrado_en = now() where id = $1`, [id], c);
    });
    await this.auditoria.registrar(u, 'cerrar', 'periodo', id, { estado: 'aprobado' }, { estado: 'cerrado' });
    return camel(await this.periodo(u, id));
  }

  async reabrir(u: UsuarioSesion, id: string, motivo: string) {
    const p = await this.periodo(u, id);
    if (p.estado !== 'cerrado' && p.estado !== 'aprobado') throw new ErrorNegocio('El periodo no está aprobado ni cerrado');
    const advertencia = p.estado === 'cerrado' && (await this.db.maybe('select archivo_banco_en from periodos where id = $1 and archivo_banco_en is not null', [id]))
      ? 'Ya se generó el archivo del banco: el pago pudo haberse hecho. Considere hacer el ajuste en el periodo siguiente'
      : null;
    await this.db.tx(async (c) => {
      if (p.estado === 'cerrado') {
        await this.aplicarSaldos(c, id, 1);
        await this.db.exec(`delete from pagos where periodo_id = $1 and estado = 'pendiente'`, [id], c);
      }
      await this.db.exec(`update periodos set estado = 'liquidado', aprobado_por = null, aprobado_en = null, cerrado_en = null, reabierto_motivo = $2 where id = $1`, [id, motivo], c);
    });
    await this.auditoria.registrar(u, 'reabrir', 'periodo', id, { estado: p.estado }, { estado: 'liquidado' }, { motivo });
    return { ...camel(await this.periodo(u, id)), advertencia };
  }

  /**
   * Retroactivo (HU-45): vuelve a calcular periodos cerrados con la configuración actual
   * y registra la diferencia salarial como novedad en el periodo abierto. Los cerrados no cambian.
   */
  async retroactivo(u: UsuarioSesion, destinoId: string, d: { periodosOrigen: string[]; motivo: string; aplicar: boolean }) {
    const destino = await this.periodo(u, destinoId);
    if (destino.estado === 'aprobado' || destino.estado === 'cerrado') throw new ErrorNegocio('El periodo de destino debe estar abierto o liquidado');
    const salariales = new Set((await this.db.many(`select codigo from conceptos where empresa_id = $1 and tipo = 'devengo' and salarial`, [u.empresaId])).map((c) => c.codigo));
    const diferencias = new Map<string, { empleado: string; valor: Decimal; detalle: string[] }>();
    for (const pid of d.periodosOrigen) {
      const origen = await this.periodo(u, pid);
      if (origen.estado !== 'cerrado' && origen.estado !== 'aprobado') throw new ErrorNegocio(`El periodo ${origen.nombre} no está cerrado`);
      const guardadas = await this.db.many(`select empleado_id, concepto, valor from liquidacion_lineas where periodo_id = $1 and tipo = 'devengo'`, [pid]);
      const { resultados } = await this.calcular(u.empresaId, origen);
      for (const r of resultados) {
        const nuevo = sum(r.resultado.lineas.filter((l) => l.tipo === 'devengo' && salariales.has(l.concepto)).map((l) => l.valor));
        const antes = sum(guardadas.filter((g) => g.empleado_id === r.empleado.id && salariales.has(g.concepto)).map((g) => g.valor));
        const dif = nuevo.minus(antes);
        if (dif.isZero()) continue;
        const x = diferencias.get(r.empleado.id) ?? { empleado: nombreCompleto(r.empleado), valor: D(0), detalle: [] };
        x.valor = x.valor.plus(dif);
        x.detalle.push(`${origen.nombre}: ${pesos(dif.toFixed())}`);
        diferencias.set(r.empleado.id, x);
      }
    }
    const lista = [...diferencias.entries()].map(([empleadoId, x]) => ({ empleadoId, empleado: x.empleado, valor: x.valor.toDecimalPlaces(0).toFixed(), detalle: x.detalle }));
    if (!d.aplicar) return { diferencias: lista };
    for (const x of lista)
      await this.db.exec(
        `insert into novedades (empresa_id, empleado_id, clase, tipo, fecha, valor, descripcion, creado_por) values ($1, $2, 'valor', 'RETROACTIVO', $3, $4, $5, $6)`,
        [u.empresaId, x.empleadoId, destino.hasta, x.valor, `${d.motivo}. ${x.detalle.join('; ')}`, u.id],
      );
    await this.auditoria.registrar(u, 'retroactivo', 'periodo', destinoId, null, { origen: d.periodosOrigen, empleados: lista.length }, { motivo: d.motivo });
    return { diferencias: lista, aplicado: true };
  }

  /** Prueba un concepto (aunque esté en borrador) con un empleado (HU-13). */
  async probarConcepto(u: UsuarioSesion, codigo: string, d: { empleadoId: string; desde: string; hasta: string }) {
    const c = await this.db.maybe('select codigo, estado from conceptos where empresa_id = $1 and codigo = $2', [u.empresaId, normalizarId(codigo)]);
    if (!c) throw new ErrorNegocio('Concepto no encontrado', 404);
    const p = { id: '00000000-0000-0000-0000-000000000000', desde: d.desde, hasta: d.hasta, grupo_pago_id: null };
    const { resultados } = await this.calcular(u.empresaId, p, [d.empleadoId], { incluirBorradores: [c.codigo] });
    const r = resultados[0]?.resultado;
    if (!r) throw new ErrorNegocio('El empleado no tiene contrato en esas fechas');
    const linea = r.lineas.find((l) => l.concepto === c.codigo);
    return { concepto: c.codigo, estado: c.estado, valor: linea?.valor ?? '0', linea: linea ?? null, alertas: r.alertas, totales: r.totales };
  }

  // ---------- Desprendible (HU-46) ----------

  async desprendible(u: UsuarioSesion, periodoId: string, empleadoId: string): Promise<Buffer> {
    const p = await this.periodo(u, periodoId);
    const det = await this.detalle(u, periodoId, empleadoId);
    const empresa = await this.db.one('select * from empresas where id = $1', [u.empresaId]);
    const filas = (tipo: string) => det.lineas.filter((l: any) => l.tipo === tipo).map((l: any) => [l.nombre, l.cantidad ?? '', pesos(l.valor)]);
    return crearPdf((doc) => {
      encabezado(doc, empresa, 'COMPROBANTE DE PAGO DE NÓMINA');
      doc.fontSize(10).text(`Empleado: ${det.empleado}    Documento: ${det.documento}`);
      doc.text(`Cargo: ${det.cargo ?? ''}    Periodo: ${p.nombre} (${p.desde} a ${p.hasta})`);
      doc.text(`Días pagados: ${det.dias?.salario ?? ''}    Fecha de pago: ${p.fecha_pago ?? ''}`);
      doc.moveDown(0.8);
      doc.font('Helvetica-Bold').text('Devengos');
      tabla(doc, [{ titulo: 'Concepto', ancho: 300 }, { titulo: 'Cantidad', ancho: 80, derecha: true }, { titulo: 'Valor', ancho: 130, derecha: true }], filas('devengo'));
      doc.font('Helvetica-Bold').text('Deducciones');
      tabla(doc, [{ titulo: 'Concepto', ancho: 300 }, { titulo: '', ancho: 80 }, { titulo: 'Valor', ancho: 130, derecha: true }], filas('deduccion'));
      doc.moveDown(0.5).font('Helvetica-Bold').fontSize(11);
      doc.text(`Total devengado: ${pesos(det.totales.devengos)}`);
      doc.text(`Total deducciones: ${pesos(det.totales.deducciones)}`);
      doc.fontSize(13).text(`NETO A PAGAR: ${pesos(det.totales.neto)}`);
      doc.moveDown(1).font('Helvetica').fontSize(8).fillColor('#777777').text('Generado por Jornal 360. Cada valor tiene su cálculo paso a paso en el sistema.');
    });
  }
}

@Controller('periodos')
export class NominaController {
  constructor(private readonly s: NominaService) {}

  @Get()
  listar(@Usuario() u: UsuarioSesion, @Query() q: any) {
    return this.s.periodos(u, q);
  }

  @Get('sugerir/:grupoPagoId')
  sugerir(@Usuario() u: UsuarioSesion, @Param('grupoPagoId') g: string) {
    return this.s.sugerir(u, g);
  }

  @Post()
  crear(@Usuario() u: UsuarioSesion, @Body(new Validar(PeriodoDto)) d: z.infer<typeof PeriodoDto>) {
    return this.s.crearPeriodo(u, d);
  }

  @Get(':id')
  ver(@Usuario() u: UsuarioSesion, @Param('id') id: string) {
    return this.s.resumen(u, id);
  }

  @Delete(':id')
  borrar(@Usuario() u: UsuarioSesion, @Param('id') id: string) {
    return this.s.borrarPeriodo(u, id);
  }

  @Post(':id/liquidar')
  liquidar(@Usuario() u: UsuarioSesion, @Param('id') id: string, @Body(new Validar(z.object({ empleadoIds: z.array(z.string().uuid()).optional() }))) d: any) {
    return this.s.liquidar(u, id, d);
  }

  @Post(':id/simular')
  simular(@Usuario() u: UsuarioSesion, @Param('id') id: string, @Body(new Validar(z.object({ empleadoIds: z.array(z.string().uuid()).optional() }))) d: any) {
    return this.s.simular(u, id, d.empleadoIds);
  }

  @Get(':id/empleados/:empleadoId')
  detalle(@Usuario() u: UsuarioSesion, @Param('id') id: string, @Param('empleadoId') e: string) {
    return this.s.detalle(u, id, e);
  }

  @Get(':id/empleados/:empleadoId/desprendible')
  async desprendible(@Usuario() u: UsuarioSesion, @Param('id') id: string, @Param('empleadoId') e: string, @Res() res: Response) {
    const pdf = await this.s.desprendible(u, id, e);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="desprendible.pdf"');
    res.send(pdf);
  }

  @Get(':id/comparativo')
  comparativo(@Usuario() u: UsuarioSesion, @Param('id') id: string) {
    return this.s.comparativo(u, id);
  }

  @Post(':id/aprobar')
  aprobar(@Usuario() u: UsuarioSesion, @Param('id') id: string) {
    return this.s.aprobar(u, id);
  }

  @Post(':id/rechazar')
  rechazar(@Usuario() u: UsuarioSesion, @Param('id') id: string, @Body(new Validar(z.object({ motivo: z.string().min(3, 'Escriba el motivo') }))) d: any) {
    return this.s.rechazar(u, id, d.motivo);
  }

  @Post(':id/cerrar')
  cerrar(@Usuario() u: UsuarioSesion, @Param('id') id: string) {
    return this.s.cerrar(u, id);
  }

  @Post(':id/reabrir')
  reabrir(@Usuario() u: UsuarioSesion, @Param('id') id: string, @Body(new Validar(z.object({ motivo: z.string().min(3, 'Escriba el motivo') }))) d: any) {
    return this.s.reabrir(u, id, d.motivo);
  }

  @Post(':id/retroactivo')
  retroactivo(
    @Usuario() u: UsuarioSesion,
    @Param('id') id: string,
    @Body(new Validar(z.object({ periodosOrigen: z.array(z.string().uuid()).min(1), motivo: z.string().min(3), aplicar: z.boolean().default(false) }))) d: any,
  ) {
    return this.s.retroactivo(u, id, d);
  }
}

@Controller('conceptos')
export class ProbarConceptoController {
  constructor(private readonly s: NominaService) {}

  @Post(':codigo/probar')
  probar(@Usuario() u: UsuarioSesion, @Param('codigo') codigo: string, @Body(new Validar(z.object({ empleadoId: z.string().uuid(), desde: zFecha, hasta: zFecha }))) d: any) {
    return this.s.probarConcepto(u, codigo, d);
  }
}

