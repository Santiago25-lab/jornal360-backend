import { Body, Controller, Get, Injectable, Param, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { z } from 'zod';
import { AuditoriaService } from '../../common/auditoria.service';
import { ErrorNegocio, Usuario, UsuarioSesion, Validar } from '../../common/comun';
import { crearPdf, encabezado, tabla } from '../../common/pdf';
import { camel, camelLista, nombreCompleto, pesos, zFecha } from '../../common/util';
import { Db } from '../../db/db.service';
import { D, Decimal, sum } from '../../domain/decimal';
import { diasComerciales, maxFecha, minFecha, sumarMeses } from '../../domain/fechas';
import { basePrestaciones, liquidarCesantias, liquidarIntereses, liquidarPrima, liquidarVacaciones, PARAMS_PRESTACIONES_POR_DEFECTO, ParamsPrestaciones, salarioEn, semestreDe } from '../../domain/prestaciones';
import { calcularIndemnizacion, calcularMoratoria, TipoContrato } from '../../domain/retiro';
import { ContextoEmpresa, ContextoService } from '../configuracion/contexto.service';
import { NovedadesService } from '../novedades/novedades';
import { NominaService } from './nomina';

const CONCEPTOS_FIJOS = new Set(['SALARIO_BASICO', 'SALARIO_INTEGRAL', 'APOYO_SOSTENIMIENTO', 'VACACIONES_DISFRUTADAS', 'RETROACTIVO']);

@Injectable()
export class PrestacionesService {
  constructor(
    private readonly db: Db,
    private readonly auditoria: AuditoriaService,
    private readonly contexto: ContextoService,
    private readonly nomina: NominaService,
    private readonly novedades: NovedadesService,
  ) {}

  params(ctx: ContextoEmpresa, fecha: string): ParamsPrestaciones {
    return {
      ...PARAMS_PRESTACIONES_POR_DEFECTO,
      diasAnio: ctx.parametros.valor('DIAS_ANIO', fecha)?.toNumber() ?? 360,
      pctInteresesCesantias: ctx.parametros.valor('PCT_INTERESES_CESANTIAS', fecha) ?? D('0.12'),
      diasVacacionesPorAnio: ctx.parametros.valor('DIAS_VACACIONES_ANIO', fecha)?.toNumber() ?? 15,
      mesesVariacionParaPromedio: ctx.parametros.valor('MESES_VARIACION_PROMEDIO', fecha)?.toNumber() ?? 3,
    };
  }

  /** Base (art. 253) de un empleado entre dos fechas: salario, variables pagadas y auxilio. */
  async base(ctx: ContextoEmpresa, e: any, desde: string, hasta: string, conAuxilio: boolean) {
    const historial = await this.db.many('select desde, salario from historial_salarial where contrato_id = $1 order by desde', [e.contrato_id]);
    const salariales = ctx.conceptos.filter((c) => c.tipo === 'devengo' && c.salarial && !CONCEPTOS_FIJOS.has(c.codigo)).map((c) => c.codigo);
    const variables = await this.db.many(
      `select to_char(pe.hasta, 'YYYY-MM') as mes, sum(ll.valor) as variable from liquidacion_lineas ll join periodos pe on pe.id = ll.periodo_id
       where ll.empleado_id = $1 and pe.tipo = 'nomina' and pe.hasta between $2 and $3 and ll.concepto = any($4) group by 1`,
      [e.id, desde, hasta, salariales],
    );
    const iniciales = await this.db.many(
      `select substring(tipo from 14) as mes, valor as variable from saldos_iniciales where empleado_id = $1 and tipo like 'variable_mes:%' and fecha_corte between $2 and $3`,
      [e.id, desde, hasta],
    );
    const salarioFinal = salarioEn(historial.map((h) => ({ desde: h.desde, salario: h.salario })), hasta);
    const smmlv = ctx.parametros.valor('SMMLV', hasta) ?? D(0);
    const tope = (ctx.parametros.valor('TOPE_AUX_TRANSPORTE_SMMLV', hasta) ?? D(2)).mul(smmlv);
    const aux = conAuxilio && e.auxilio_transporte !== 'nunca' && (e.auxilio_transporte === 'siempre' || salarioFinal.lte(tope)) ? (ctx.parametros.valor('AUX_TRANSPORTE', hasta) ?? D(0)) : D(0);
    return basePrestaciones(
      {
        historialSalario: historial.map((h) => ({ desde: h.desde, salario: h.salario })),
        variables: [...variables, ...iniciales],
        auxilioTransporte: aux,
        desde,
        hasta,
        salarioVariable: e.tipo_salario === 'variable',
      },
      this.params(ctx, hasta),
    );
  }

  async diasNoRemunerados(empleadoId: string, desde: string, hasta: string) {
    const n = await this.db.many(
      `select desde, hasta from novedades where empleado_id = $1 and clase = 'dias' and estado = 'aprobada' and tipo in ('licencia_no_remunerada', 'suspension') and desde <= $3 and hasta >= $2`,
      [empleadoId, desde, hasta],
    );
    return n.reduce((a, x) => a + diasComerciales(maxFecha(x.desde, desde), minFecha(x.hasta, hasta)), 0);
  }

  private async empleadosActivosEn(u: UsuarioSesion, desde: string, hasta: string) {
    return this.db.many(
      `select e.*, c.id as contrato_id, c.tipo as contrato_tipo, c.fecha_inicio, c.fecha_fin, c.salario_integral, c.fase_aprendiz, c.auxilio_transporte, c.tipo_salario
       from empleados e join lateral (select * from contratos c where c.empleado_id = e.id and c.fecha_inicio <= $3 and (c.fecha_fin is null or c.fecha_fin >= $2) order by c.fecha_inicio desc limit 1) c on true
       where e.empresa_id = $1 order by e.apellidos`,
      [u.empresaId, desde, hasta],
    );
  }

  /** Prima de servicios del semestre (HU-47). */
  async liquidarPrima(u: UsuarioSesion, d: { anio: number; semestre: 1 | 2; fechaPago?: string }) {
    const desde = `${d.anio}-${d.semestre === 1 ? '01' : '07'}-01`;
    const hasta = d.semestre === 1 ? `${d.anio}-06-30` : `${d.anio}-12-31`;
    const nombre = `Prima de servicios ${d.semestre === 1 ? 'primer' : 'segundo'} semestre ${d.anio}`;
    const ctx = await this.contexto.cargar(u.empresaId);
    const existente = await this.db.maybe(`select * from periodos where empresa_id = $1 and tipo = 'prima' and desde = $2`, [u.empresaId, desde]);
    if (existente && (existente.estado === 'aprobado' || existente.estado === 'cerrado')) throw new ErrorNegocio('La prima de ese semestre ya está aprobada o cerrada');
    const periodo =
      existente ??
      (await this.db.one(`insert into periodos (empresa_id, tipo, nombre, desde, hasta, fecha_pago) values ($1, 'prima', $2, $3, $4, $5) returning *`, [
        u.empresaId,
        nombre,
        desde,
        hasta,
        d.fechaPago ?? (d.semestre === 1 ? `${d.anio}-06-30` : `${d.anio}-12-20`),
      ]));
    const empleados = await this.empleadosActivosEn(u, desde, hasta);
    const p = this.params(ctx, hasta);
    await this.db.tx(async (c) => {
      await this.db.exec('delete from liquidaciones where periodo_id = $1', [periodo.id], c);
      for (const e of empleados) {
        if (e.salario_integral || e.contrato_tipo === 'integral' || (e.contrato_tipo === 'aprendizaje' && (e.fase_aprendiz ?? 'lectiva') === 'lectiva')) continue;
        const fin = minFecha(hasta, e.fecha_fin ?? hasta);
        const ini = maxFecha(desde, e.fecha_inicio);
        const dias = Math.max(0, diasComerciales(ini, fin) - (await this.diasNoRemunerados(e.id, ini, fin)));
        if (dias <= 0) continue;
        const b = await this.base(ctx, e, ini, fin, true);
        const pr = liquidarPrima(b.base, dias, p);
        const pagada = await this.db.one(
          `select coalesce(sum(ll.valor), 0) as v from liquidacion_lineas ll join periodos pe on pe.id = ll.periodo_id
           where ll.empleado_id = $1 and ll.concepto = 'PRIMA_SERVICIOS' and pe.id <> $2 and pe.desde >= $3 and pe.hasta <= $4 and pe.estado in ('aprobado', 'cerrado')`,
          [e.id, periodo.id, desde, hasta],
          c,
        );
        const valor = Decimal.max(pr.valor.minus(D(pagada.v)), D(0));
        const r = this.resultadoSimple(e.id, ini, fin, [
          { concepto: 'PRIMA_SERVICIOS', nombre: 'Prima de servicios', tipo: 'devengo', valor, cantidad: dias, detalle: { formula: pr.formula, variables: { BASE: b.base.toFixed(2), DIAS: String(dias), YA_PAGADA: D(pagada.v).toFixed() }, nota: b.detalle } },
        ]);
        await this.nomina.guardarResultado(c, u.empresaId, periodo.id, e.id, e.contrato_id, r);
      }
      await this.db.exec(`update periodos set estado = 'liquidado', liquidado_en = now(), liquidado_por = $2 where id = $1`, [periodo.id, u.id], c);
    });
    await this.auditoria.registrar(u, 'liquidar_prima', 'periodo', periodo.id, null, { anio: d.anio, semestre: d.semestre });
    return this.nomina.resumen(u, periodo.id);
  }

  /** Cesantías e intereses del año (HU-48): cesantías para consignar al fondo e intereses para pagar al empleado. */
  async liquidarCesantias(u: UsuarioSesion, d: { anio: number; fechaPago?: string }) {
    const desde = `${d.anio}-01-01`;
    const hasta = `${d.anio}-12-31`;
    const ctx = await this.contexto.cargar(u.empresaId);
    const existente = await this.db.maybe(`select * from periodos where empresa_id = $1 and tipo = 'cesantias' and desde = $2`, [u.empresaId, desde]);
    if (existente && (existente.estado === 'aprobado' || existente.estado === 'cerrado')) throw new ErrorNegocio('Las cesantías de ese año ya están aprobadas o cerradas');
    const periodo =
      existente ??
      (await this.db.one(`insert into periodos (empresa_id, tipo, nombre, desde, hasta, fecha_pago) values ($1, 'cesantias', $2, $3, $4, $5) returning *`, [
        u.empresaId,
        `Cesantías e intereses ${d.anio}`,
        desde,
        hasta,
        d.fechaPago ?? `${d.anio + 1}-01-31`,
      ]));
    // Solo quienes siguen vinculados al 31 de diciembre: a los retirados se les pagan en la liquidación del contrato.
    const empleados = (await this.empleadosActivosEn(u, hasta, hasta)).filter((e) => !(e.salario_integral || e.contrato_tipo === 'integral'));
    const p = this.params(ctx, hasta);
    await this.db.tx(async (c) => {
      await this.db.exec('delete from liquidaciones where periodo_id = $1', [periodo.id], c);
      for (const e of empleados) {
        if (e.contrato_tipo === 'aprendizaje' && (e.fase_aprendiz ?? 'lectiva') === 'lectiva') continue;
        const ini = maxFecha(desde, e.fecha_inicio);
        const dias = Math.max(0, diasComerciales(ini, hasta) - (await this.diasNoRemunerados(e.id, ini, hasta)));
        if (dias <= 0) continue;
        const b = await this.base(ctx, e, ini, hasta, true);
        const ces = liquidarCesantias(b.base, dias, p);
        const int = liquidarIntereses(ces.valor, dias, p);
        const fondo = await this.db.maybe('select nombre from entidades where id = $1', [e.cesantias_id]);
        const r = this.resultadoSimple(e.id, ini, hasta, [
          { concepto: 'INTERESES_CESANTIAS', nombre: 'Intereses sobre cesantías', tipo: 'devengo', valor: int.valor, cantidad: dias, detalle: { formula: int.formula, variables: { CESANTIAS: ces.valor.toFixed(), DIAS: String(dias) } } },
          {
            concepto: 'CESANTIAS_CONSIGNAR',
            nombre: `Cesantías a consignar${fondo ? ' en ' + fondo.nombre : ''}`,
            tipo: 'provision',
            valor: ces.valor,
            cantidad: dias,
            detalle: { formula: ces.formula, variables: { BASE: b.base.toFixed(2), DIAS: String(dias) }, nota: b.detalle },
          },
        ]);
        await this.nomina.guardarResultado(c, u.empresaId, periodo.id, e.id, e.contrato_id, r);
      }
      await this.db.exec(`update periodos set estado = 'liquidado', liquidado_en = now(), liquidado_por = $2 where id = $1`, [periodo.id, u.id], c);
    });
    await this.auditoria.registrar(u, 'liquidar_cesantias', 'periodo', periodo.id, null, { anio: d.anio });
    return this.nomina.resumen(u, periodo.id);
  }

  /** Consignación de cesantías por fondo (HU-48). */
  async consignacionPorFondo(u: UsuarioSesion, periodoId: string) {
    const filas = await this.db.many(
      `select coalesce(en.nombre, 'Sin fondo de cesantías') as fondo, en.nit, e.numero_documento, e.nombres, e.apellidos, ll.valor
       from liquidacion_lineas ll join empleados e on e.id = ll.empleado_id left join entidades en on en.id = e.cesantias_id
       where ll.periodo_id = $1 and ll.empresa_id = $2 and ll.concepto = 'CESANTIAS_CONSIGNAR' order by fondo, e.apellidos`,
      [periodoId, u.empresaId],
    );
    const fondos = new Map<string, { fondo: string; nit: string | null; total: Decimal; empleados: any[] }>();
    for (const f of filas) {
      const x = fondos.get(f.fondo) ?? { fondo: f.fondo, nit: f.nit, total: D(0), empleados: [] as any[] };
      x.total = x.total.plus(D(f.valor));
      x.empleados.push({ documento: f.numero_documento, empleado: nombreCompleto(f), valor: f.valor });
      fondos.set(f.fondo, x);
    }
    return [...fondos.values()].map((x) => ({ ...x, total: x.total.toFixed() }));
  }

  resultadoSimple(empleadoId: string, desde: string, hasta: string, lineas: { concepto: string; nombre: string; tipo: any; valor: Decimal; cantidad?: number; detalle: any }[]) {
    const ls = lineas.filter((l) => !l.valor.isZero()).map((l) => ({ concepto: l.concepto, nombre: l.nombre, tipo: l.tipo, valor: l.valor.toFixed(), cantidad: l.cantidad !== undefined ? String(l.cantidad) : undefined, detalle: l.detalle }));
    const t = (tipo: string) => sum(ls.filter((l) => l.tipo === tipo).map((l) => l.valor));
    const dev = t('devengo');
    const ded = t('deduccion');
    return {
      empleadoId,
      desde,
      hasta,
      lineas: ls,
      totales: { devengos: dev.toFixed(), deducciones: ded.toFixed(), neto: dev.minus(ded).toFixed(), aportesEmpleador: '0', provisiones: t('provision').toFixed(), costoTotal: dev.toFixed() },
      bases: {},
      dias: {},
      alertas: [],
      pendientes: [],
    };
  }

  // ---------- Retiro (HU-53, HU-54) ----------

  async calcularRetiro(u: UsuarioSesion, d: { empleadoId: string; fechaRetiro: string; causa: string; sinJustaCausa: boolean; fechaPago?: string | null }) {
    const ctx = await this.contexto.cargar(u.empresaId);
    const e = await this.db.maybe(
      `select e.*, c.id as contrato_id, c.tipo as contrato_tipo, c.fecha_inicio, c.fecha_fin, c.fecha_fin_pactada, c.salario_integral, c.fase_aprendiz, c.auxilio_transporte, c.tipo_salario
       from empleados e join contratos c on c.empleado_id = e.id and c.estado = 'activo' where e.id = $1 and e.empresa_id = $2 order by c.fecha_inicio desc limit 1`,
      [d.empleadoId, u.empresaId],
    );
    if (!e) throw new ErrorNegocio('El empleado no tiene un contrato activo', 404);
    if (d.fechaRetiro < e.fecha_inicio) throw new ErrorNegocio('La fecha de retiro es anterior al inicio del contrato');
    const f = d.fechaRetiro;
    const p = this.params(ctx, f);
    const integral = e.salario_integral || e.contrato_tipo === 'integral';
    const lectiva = e.contrato_tipo === 'aprendizaje' && (e.fase_aprendiz ?? 'lectiva') === 'lectiva';
    const historial = await this.db.many('select desde, salario from historial_salarial where contrato_id = $1 order by desde', [e.contrato_id]);
    const salario = salarioEn(historial.map((h) => ({ desde: h.desde, salario: h.salario })), f);
    const lineas: { concepto: string; nombre: string; tipo: any; valor: Decimal; cantidad?: number; detalle: any }[] = [];
    const notas: string[] = [];

    if (!integral && !lectiva) {
      // Cesantías e intereses del año en curso (los años anteriores ya se consignaron).
      const iniAnio = maxFecha(`${f.slice(0, 4)}-01-01`, e.fecha_inicio);
      const diasAnio = Math.max(0, diasComerciales(iniAnio, f) - (await this.diasNoRemunerados(e.id, iniAnio, f)));
      const bAnio = await this.base(ctx, e, iniAnio, f, true);
      const ces = liquidarCesantias(bAnio.base, diasAnio, p);
      const int = liquidarIntereses(ces.valor, diasAnio, p);
      lineas.push({ concepto: 'CESANTIAS', nombre: 'Cesantías', tipo: 'devengo', valor: ces.valor, cantidad: diasAnio, detalle: { formula: ces.formula, variables: { BASE: bAnio.base.toFixed(2), DIAS: String(diasAnio) }, nota: bAnio.detalle } });
      lineas.push({ concepto: 'INTERESES_CESANTIAS', nombre: 'Intereses sobre cesantías', tipo: 'devengo', valor: int.valor, cantidad: diasAnio, detalle: { formula: int.formula } });
      // Prima del semestre, menos lo ya pagado.
      const sem = semestreDe(f);
      const iniSem = maxFecha(sem.desde, e.fecha_inicio);
      const diasSem = Math.max(0, diasComerciales(iniSem, f) - (await this.diasNoRemunerados(e.id, iniSem, f)));
      const bSem = await this.base(ctx, e, iniSem, f, true);
      const pr = liquidarPrima(bSem.base, diasSem, p);
      const pagada = await this.db.one(
        `select coalesce(sum(ll.valor), 0) as v from liquidacion_lineas ll join periodos pe on pe.id = ll.periodo_id where ll.empleado_id = $1 and ll.concepto = 'PRIMA_SERVICIOS' and pe.desde >= $2 and pe.estado in ('aprobado', 'cerrado')`,
        [e.id, sem.desde],
      );
      lineas.push({
        concepto: 'PRIMA_SERVICIOS',
        nombre: 'Prima de servicios proporcional',
        tipo: 'devengo',
        valor: Decimal.max(pr.valor.minus(D(pagada.v)), D(0)),
        cantidad: diasSem,
        detalle: { formula: pr.formula, variables: { BASE: bSem.base.toFixed(2), DIAS: String(diasSem), YA_PAGADA: D(pagada.v).toFixed() } },
      });
    } else notas.push(integral ? 'Salario integral: las prestaciones están incluidas en el salario (CST art. 132)' : 'Aprendiz en fase lectiva: sin prestaciones');

    // Vacaciones pendientes.
    const saldo = await this.novedades.saldoVacaciones(u, e.id, f);
    if (D(saldo.pendientes).gt(0)) {
      const baseVac = e.tipo_salario === 'variable' ? (await this.base(ctx, e, sumarMeses(f, -12), f, false)).base : salario;
      const v = liquidarVacaciones(baseVac, saldo.pendientes, p);
      lineas.push({ concepto: 'VACACIONES_COMPENSADAS', nombre: 'Vacaciones pendientes', tipo: 'devengo', valor: v.valor, cantidad: Number(saldo.pendientes), detalle: { formula: v.formula, variables: { BASE: baseVac.toFixed(2), DIAS: saldo.pendientes } } });
    }

    // Indemnización por despido sin justa causa.
    if (d.sinJustaCausa) {
      const pr = (c: string, def: number) => ctx.parametros.valor(c, f)?.toNumber() ?? def;
      const ind = calcularIndemnizacion(
        {
          tipoContrato: (integral ? 'indefinido' : e.contrato_tipo) as TipoContrato,
          salarioMensual: salario,
          smmlv: ctx.parametros.valor('SMMLV', f) ?? D(0),
          fechaIngreso: e.fecha_inicio,
          fechaRetiro: f,
          fechaFinPactada: e.fecha_fin_pactada ?? e.fecha_fin,
        },
        {
          topeSmmlv: pr('INDEM_TOPE_SMMLV', 10),
          diasPrimerAnioMenor: pr('INDEM_DIAS_PRIMER_ANIO_MENOR', 30),
          diasAdicionalMenor: pr('INDEM_DIAS_ADICIONAL_MENOR', 20),
          diasPrimerAnioMayor: pr('INDEM_DIAS_PRIMER_ANIO_MAYOR', 20),
          diasAdicionalMayor: pr('INDEM_DIAS_ADICIONAL_MAYOR', 15),
          minimoDiasObraLabor: pr('INDEM_MIN_DIAS_OBRA', 15),
        },
      );
      lineas.push({ concepto: 'INDEMNIZACION', nombre: 'Indemnización por despido sin justa causa', tipo: 'devengo', valor: ind.valor, cantidad: ind.dias.toNumber(), detalle: { nota: ind.detalle, variables: { SALARIO: salario.toFixed(), DIAS: ind.dias.toFixed() } } });
    }

    // Saldos de préstamos (con autorización escrita se pueden descontar de la liquidación).
    const prestamos = await this.db.many(`select * from prestamos where empleado_id = $1 and activo and saldo > 0 and autorizacion_escrita`, [e.id]);
    for (const x of prestamos) lineas.push({ concepto: x.tipo === 'libranza' ? 'LIBRANZA' : 'PRESTAMO', nombre: `Saldo ${x.tipo}: ${x.descripcion}`, tipo: 'deduccion', valor: D(x.saldo), detalle: { nota: 'Saldo pendiente con autorización escrita' } });

    const r = this.resultadoSimple(e.id, e.fecha_inicio, f, lineas);
    if (D(r.totales.neto).lt(0)) {
      notas.push('Los descuentos superan la liquidación: revise los saldos de préstamos');
    }
    let moratoria = null;
    if (d.fechaPago && d.fechaPago > f) {
      moratoria = calcularMoratoria({
        salarioMensual: salario,
        smmlv: ctx.parametros.valor('SMMLV', f) ?? D(0),
        fechaRetiro: f,
        fechaPago: d.fechaPago,
        saldoAdeudado: r.totales.neto,
        tasaMoratoriaMensual: ctx.parametros.valor('TASA_MORATORIA_MENSUAL', f) ?? D('0.02'),
      });
    }
    return {
      empleado: nombreCompleto(e),
      contratoId: e.contrato_id,
      fechaIngreso: e.fecha_inicio,
      fechaRetiro: f,
      causa: d.causa,
      sinJustaCausa: d.sinJustaCausa,
      salario: salario.toFixed(),
      ...r,
      vacaciones: saldo,
      moratoria: moratoria && { dias: moratoria.dias, valorDias: moratoria.valorDias.toFixed(), intereses: moratoria.intereses.toFixed(), total: moratoria.total.toFixed() },
      notas,
      recordatorio: 'Liquide también la última nómina del empleado hasta la fecha de retiro y entréguele la constancia de aportes de los últimos 3 meses (CST art. 65, parágrafo 1).',
    };
  }

  async guardarRetiro(u: UsuarioSesion, d: { empleadoId: string; fechaRetiro: string; causa: string; sinJustaCausa: boolean; fechaPago?: string | null }) {
    const r = await this.calcularRetiro(u, d);
    const fila = await this.db.one(
      `insert into retiros (empresa_id, empleado_id, contrato_id, fecha_retiro, causa, sin_justa_causa, resultado, total, fecha_pago) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
      [u.empresaId, r.empleadoId, r.contratoId, d.fechaRetiro, d.causa, d.sinJustaCausa, JSON.stringify(r), r.totales.neto, d.fechaPago ?? null],
    );
    await this.auditoria.registrar(u, 'crear', 'retiro', fila.id, null, { total: r.totales.neto });
    return camel(fila);
  }

  async retiros(u: UsuarioSesion) {
    return camelLista(
      await this.db.many(
        `select r.id, r.empleado_id, r.fecha_retiro, r.causa, r.sin_justa_causa, r.total, r.estado, r.fecha_pago, r.creado_en, e.nombres, e.apellidos, e.numero_documento
         from retiros r join empleados e on e.id = r.empleado_id where r.empresa_id = $1 order by r.creado_en desc`,
        [u.empresaId],
      ),
    );
  }

  async verRetiro(u: UsuarioSesion, id: string) {
    const r = await this.db.maybe('select * from retiros where id = $1 and empresa_id = $2', [id, u.empresaId]);
    if (!r) throw new ErrorNegocio('Retiro no encontrado', 404);
    return camel(r);
  }

  /** Aprueba el retiro: termina el contrato, retira al empleado y cierra sus préstamos descontados. */
  async aprobarRetiro(u: UsuarioSesion, id: string) {
    const r = await this.db.maybe('select * from retiros where id = $1 and empresa_id = $2', [id, u.empresaId]);
    if (!r) throw new ErrorNegocio('Retiro no encontrado', 404);
    if (r.estado !== 'borrador') throw new ErrorNegocio('El retiro ya está aprobado');
    await this.db.tx(async (c) => {
      await this.db.exec(`update retiros set estado = 'aprobado' where id = $1`, [id], c);
      await this.db.exec(`update contratos set fecha_fin = $2, estado = 'terminado', causa_retiro = $3 where id = $1`, [r.contrato_id, r.fecha_retiro, r.causa], c);
      await this.db.exec(`update empleados set estado = 'retirado' where id = $1`, [r.empleado_id], c);
      await this.db.exec(`update dispositivos set activo = false, desvinculado_en = now() where empleado_id = $1 and activo`, [r.empleado_id], c);
      for (const l of r.resultado.lineas ?? [])
        if (l.tipo === 'deduccion' && (l.concepto === 'PRESTAMO' || l.concepto === 'LIBRANZA'))
          await this.db.exec(`update prestamos set saldo = 0, activo = false where empleado_id = $1 and activo and saldo > 0`, [r.empleado_id], c);
    });
    await this.auditoria.registrar(u, 'aprobar', 'retiro', id, { estado: 'borrador' }, { estado: 'aprobado' });
    return this.verRetiro(u, id);
  }

  async pdfRetiro(u: UsuarioSesion, id: string): Promise<Buffer> {
    const r = await this.db.maybe('select * from retiros where id = $1 and empresa_id = $2', [id, u.empresaId]);
    if (!r) throw new ErrorNegocio('Retiro no encontrado', 404);
    const empresa = await this.db.one('select * from empresas where id = $1', [u.empresaId]);
    const x = r.resultado;
    return crearPdf((doc) => {
      encabezado(doc, empresa, 'LIQUIDACIÓN DEL CONTRATO DE TRABAJO');
      doc.text(`Empleado: ${x.empleado}`);
      doc.text(`Fecha de ingreso: ${x.fechaIngreso}    Fecha de retiro: ${x.fechaRetiro}`);
      doc.text(`Causa: ${x.causa}${x.sinJustaCausa ? ' (sin justa causa)' : ''}    Salario: ${pesos(x.salario)}`);
      doc.moveDown(0.8);
      tabla(
        doc,
        [
          { titulo: 'Concepto', ancho: 280 },
          { titulo: 'Días', ancho: 80, derecha: true },
          { titulo: 'Valor', ancho: 150, derecha: true },
        ],
        x.lineas.map((l: any) => [l.nombre, l.cantidad ?? '', (l.tipo === 'deduccion' ? '- ' : '') + pesos(l.valor)]),
      );
      doc.font('Helvetica-Bold').fontSize(12).text(`TOTAL A PAGAR: ${pesos(x.totales.neto)}`);
      doc.moveDown(0.5).font('Helvetica').fontSize(9);
      for (const n of x.notas ?? []) doc.text(`• ${n}`);
      doc.moveDown(3).text('______________________________                ______________________________');
      doc.text('Firma del empleador                                              Firma del trabajador');
      doc.moveDown(1).fontSize(8).fillColor('#777777').text(x.recordatorio);
    });
  }
}

@Controller('prestaciones')
export class PrestacionesController {
  constructor(private readonly s: PrestacionesService) {}

  @Post('prima')
  prima(@Usuario() u: UsuarioSesion, @Body(new Validar(z.object({ anio: z.number().int().min(2000).max(2100), semestre: z.union([z.literal(1), z.literal(2)]), fechaPago: zFecha.optional() }))) d: any) {
    return this.s.liquidarPrima(u, d);
  }

  @Post('cesantias')
  cesantias(@Usuario() u: UsuarioSesion, @Body(new Validar(z.object({ anio: z.number().int().min(2000).max(2100), fechaPago: zFecha.optional() }))) d: any) {
    return this.s.liquidarCesantias(u, d);
  }

  @Get('cesantias/:periodoId/fondos')
  fondos(@Usuario() u: UsuarioSesion, @Param('periodoId') id: string) {
    return this.s.consignacionPorFondo(u, id);
  }
}

const RetiroDto = z.object({ empleadoId: z.string().uuid(), fechaRetiro: zFecha, causa: z.string().min(3), sinJustaCausa: z.boolean(), fechaPago: zFecha.optional().nullable() });

@Controller('retiros')
export class RetirosController {
  constructor(private readonly s: PrestacionesService) {}

  @Get()
  listar(@Usuario() u: UsuarioSesion) {
    return this.s.retiros(u);
  }

  @Post('calcular')
  calcular(@Usuario() u: UsuarioSesion, @Body(new Validar(RetiroDto)) d: z.infer<typeof RetiroDto>) {
    return this.s.calcularRetiro(u, d);
  }

  @Post()
  guardar(@Usuario() u: UsuarioSesion, @Body(new Validar(RetiroDto)) d: z.infer<typeof RetiroDto>) {
    return this.s.guardarRetiro(u, d);
  }

  @Get(':id')
  ver(@Usuario() u: UsuarioSesion, @Param('id') id: string) {
    return this.s.verRetiro(u, id);
  }

  @Post(':id/aprobar')
  aprobar(@Usuario() u: UsuarioSesion, @Param('id') id: string) {
    return this.s.aprobarRetiro(u, id);
  }

  @Get(':id/pdf')
  async pdf(@Usuario() u: UsuarioSesion, @Param('id') id: string, @Res() res: Response, @Query('x') _x?: string) {
    const pdf = await this.s.pdfRetiro(u, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="liquidacion-contrato.pdf"');
    res.send(pdf);
  }
}

