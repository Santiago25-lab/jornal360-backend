import { Body, Controller, Delete, Get, Injectable, Param, Patch, Post, Query } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { AuditoriaService } from '../../common/auditoria.service';
import { ErrorNegocio, Usuario, UsuarioSesion, Validar } from '../../common/comun';
import { camel, camelLista, fechaLocal, nombreCompleto, zFecha, zNumero } from '../../common/util';
import { Db } from '../../db/db.service';
import { D } from '../../domain/decimal';
import { diasCalendario, diasComerciales, diferenciaDias, maxFecha, minFecha, sumarDias } from '../../domain/fechas';
import { normalizarId } from '../../domain/formulas';
import { ContextoService } from '../configuracion/contexto.service';

export const TIPOS_DIAS = [
  'incapacidad_eg',
  'incapacidad_laboral',
  'licencia_maternidad',
  'licencia_paternidad',
  'licencia_remunerada',
  'licencia_no_remunerada',
  'suspension',
  'ausencia_injustificada',
  'vacaciones',
] as const;

/** Licencias remuneradas del CST art. 57 (el superusuario puede usar "otra"). */
export const LICENCIAS_REMUNERADAS = [
  { codigo: 'luto', nombre: 'Licencia por luto', diasHabiles: 5, baseLegal: 'CST art. 57 num. 10' },
  { codigo: 'calamidad', nombre: 'Calamidad doméstica', baseLegal: 'CST art. 57 num. 6' },
  { codigo: 'sufragio', nombre: 'Ejercicio del sufragio', baseLegal: 'CST art. 57 num. 6' },
  { codigo: 'cita_medica', nombre: 'Cita médica', baseLegal: 'CST art. 57 num. 6' },
  { codigo: 'escolar', nombre: 'Obligaciones escolares como acudiente', baseLegal: 'CST art. 57 num. 6' },
  { codigo: 'judicial', nombre: 'Citación judicial, administrativa o legal', baseLegal: 'CST art. 57 num. 6' },
  { codigo: 'cuidado_menor', nombre: 'Cuidado de menor con enfermedad grave', diasHabiles: 10, baseLegal: 'CST art. 57 num. 12' },
  { codigo: 'otra', nombre: 'Otra licencia remunerada' },
];

const NovedadDiasDto = z.object({
  empleadoId: z.string().uuid(),
  tipo: z.enum(TIPOS_DIAS),
  desde: zFecha,
  hasta: zFecha.optional().nullable(),
  diasHabiles: z.number().int().min(1).max(365).optional().nullable(),
  semanasAdicionales: z.number().int().min(0).max(20).optional(),
  prorrogaDe: z.string().uuid().optional().nullable(),
  subtipo: z.string().optional().nullable(),
  diagnostico: z.string().optional().nullable(),
  soporte: z.string().optional().nullable(),
  descripcion: z.string().optional().nullable(),
  confirmar: z.boolean().optional(),
});

const NovedadValorDto = z.object({
  empleadoId: z.string().uuid(),
  concepto: z.string().min(1),
  fecha: zFecha,
  valor: zNumero.optional().nullable(),
  cantidad: zNumero.optional().nullable(),
  descripcion: z.string().optional().nullable(),
  confirmar: z.boolean().optional(),
});

const PrestamoDto = z.object({
  empleadoId: z.string().uuid(),
  tipo: z.enum(['prestamo', 'libranza']),
  descripcion: z.string().min(1),
  valorTotal: zNumero,
  numeroCuotas: z.number().int().min(1).max(360),
  cuota: zNumero.optional(),
  fechaInicio: zFecha,
  autorizacionEscrita: z.boolean(),
});

const EmbargoDto = z.object({
  empleadoId: z.string().uuid(),
  tipo: z.enum(['ordinario', 'alimentos', 'cooperativa']),
  descripcion: z.string().min(1),
  juzgado: z.string().optional().nullable(),
  numeroProceso: z.string().optional().nullable(),
  valorFijo: zNumero.optional().nullable(),
  porcentaje: zNumero.optional().nullable(),
  saldo: zNumero.optional().nullable(),
  prioridad: z.number().int().min(1).max(99).optional().nullable(),
});

@Injectable()
export class NovedadesService {
  constructor(
    private readonly db: Db,
    private readonly auditoria: AuditoriaService,
    private readonly contexto: ContextoService,
  ) {}

  private async empleado(u: UsuarioSesion, id: string) {
    const e = await this.db.maybe('select * from empleados where id = $1 and empresa_id = $2', [id, u.empresaId]);
    if (!e) throw new ErrorNegocio('Empleado no encontrado', 404);
    return e;
  }

  async listar(u: UsuarioSesion, q: { empleadoId?: string; desde?: string; hasta?: string; tipo?: string; clase?: string }) {
    const desde = q.desde ?? '1900-01-01';
    const hasta = q.hasta ?? '2999-12-31';
    return camelLista(
      await this.db.many(
        `select n.*, e.nombres, e.apellidos, e.numero_documento from novedades n join empleados e on e.id = n.empleado_id
         where n.empresa_id = $1 and ($2::uuid is null or n.empleado_id = $2) and ($5::text is null or n.tipo = $5) and ($6::text is null or n.clase = $6)
           and coalesce(n.hasta, n.fecha) >= $3 and coalesce(n.desde, n.fecha) <= $4
         order by coalesce(n.desde, n.fecha) desc`,
        [u.empresaId, q.empleadoId || null, desde, hasta, q.tipo || null, q.clase || null],
      ),
    );
  }

  /** Registra incapacidades, licencias, vacaciones y ausencias (HU-33 a HU-37). */
  async crearDias(u: UsuarioSesion, d: z.infer<typeof NovedadDiasDto>) {
    const e = await this.empleado(u, d.empleadoId);
    const ctx = await this.contexto.cargar(u.empresaId);
    const advertencias: string[] = [];
    let desde = d.desde;
    let hasta = d.hasta ?? null;
    let diasHabiles = d.diasHabiles ?? null;
    let diasPrevios = 0;

    if (d.tipo === 'vacaciones') {
      if (!diasHabiles) throw new ErrorNegocio('Indique cuántos días hábiles de vacaciones');
      const cal = await this.contexto.calendarioEmpleado(ctx, e.id);
      const v = cal.calcularVacaciones(d.desde, diasHabiles);
      desde = v.inicioReal;
      hasta = v.fin;
      const saldo = await this.saldoVacaciones(u, e.id);
      if (D(diasHabiles).gt(D(saldo.pendientes))) advertencias.push(`El empleado solo tiene ${saldo.pendientes} días pendientes`);
      const preaviso = ctx.configuracion.vacaciones.diasPreaviso;
      if (diferenciaDias(fechaLocal(), desde) < preaviso) advertencias.push(`Las vacaciones se avisan con menos de ${preaviso} días de anticipación (CST art. 187)`);
    } else if (d.tipo === 'licencia_maternidad' || d.tipo === 'licencia_paternidad') {
      if (!hasta) {
        const semanas = (ctx.parametros.valor(d.tipo === 'licencia_maternidad' ? 'SEMANAS_LICENCIA_MATERNIDAD' : 'SEMANAS_LICENCIA_PATERNIDAD', d.desde)?.toNumber() ?? 0) + (d.semanasAdicionales ?? 0);
        hasta = sumarDias(d.desde, semanas * 7 - 1);
      }
    } else if (d.tipo === 'licencia_remunerada' && !hasta) {
      const lic = LICENCIAS_REMUNERADAS.find((l) => l.codigo === d.subtipo);
      const dh = diasHabiles ?? lic?.diasHabiles;
      if (!dh) throw new ErrorNegocio('Indique la fecha de terminación o los días hábiles de la licencia');
      const cal = await this.contexto.calendarioEmpleado(ctx, e.id);
      let f = d.desde;
      let n = 0;
      for (;;) {
        if (cal.esDiaLaboral(f)) n++;
        if (n === dh) break;
        f = sumarDias(f, 1);
      }
      hasta = f;
      diasHabiles = dh;
    }
    if (!hasta) throw new ErrorNegocio('Indique la fecha de terminación');
    if (hasta < desde) throw new ErrorNegocio('La fecha de terminación es anterior al inicio');

    if (d.prorrogaDe) {
      const p = await this.db.maybe(`select * from novedades where id = $1 and empleado_id = $2 and tipo in ('incapacidad_eg', 'incapacidad_laboral')`, [d.prorrogaDe, e.id]);
      if (!p) throw new ErrorNegocio('La incapacidad inicial no existe');
      diasPrevios = p.dias_previos + diasComerciales(p.desde, p.hasta);
    }
    const cruce = await this.db.maybe(
      `select tipo, desde, hasta from novedades where empleado_id = $1 and clase = 'dias' and estado <> 'rechazada' and desde <= $3 and hasta >= $2 limit 1`,
      [e.id, desde, hasta],
    );
    if (cruce) throw new ErrorNegocio(`Se cruza con otra novedad (${cruce.tipo.replace(/_/g, ' ')} del ${cruce.desde} al ${cruce.hasta})`);
    if (advertencias.length && !d.confirmar) throw new ErrorNegocio(advertencias.join('. '), 409, { requiereConfirmacion: true, advertencias });

    const r = await this.db.one(
      `insert into novedades (empresa_id, empleado_id, clase, tipo, desde, hasta, dias_previos, dias_habiles, diagnostico, soporte, descripcion, creado_por)
       values ($1, $2, 'dias', $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *`,
      [
        u.empresaId,
        e.id,
        d.tipo,
        desde,
        hasta,
        diasPrevios,
        diasHabiles,
        d.diagnostico ?? null,
        d.soporte ?? null,
        [d.subtipo ? LICENCIAS_REMUNERADAS.find((l) => l.codigo === d.subtipo)?.nombre : null, d.descripcion].filter(Boolean).join(' - ') || null,
        u.id,
      ],
    );
    await this.auditoria.registrar(u, 'crear', 'novedad', r.id, null, r, { motivo: advertencias.length ? `Confirmado: ${advertencias.join('; ')}` : undefined });
    const extra: Record<string, unknown> = { diasCalendario: diasCalendario(desde, hasta) };
    if (d.tipo === 'vacaciones') {
      const cal = await this.contexto.calendarioEmpleado(ctx, e.id);
      extra.regreso = cal.calcularVacaciones(desde, diasHabiles!).regreso;
    }
    return { ...camel(r), ...extra, advertencias };
  }

  async crearValor(u: UsuarioSesion, d: z.infer<typeof NovedadValorDto>) {
    await this.empleado(u, d.empleadoId);
    const codigo = normalizarId(d.concepto);
    const c = await this.db.maybe(`select codigo, nombre from conceptos where empresa_id = $1 and codigo = $2`, [u.empresaId, codigo]);
    const horas = ['HON', 'HED', 'HEN', 'HDD', 'HDN', 'HEDD', 'HEND'];
    if (!c && !horas.includes(codigo)) throw new ErrorNegocio(`El concepto ${codigo} no existe`);
    if (d.valor == null && d.cantidad == null) throw new ErrorNegocio('Escriba el valor o la cantidad');
    if (codigo === 'VACACIONES_COMPENSADAS') {
      const saldo = await this.saldoVacaciones(u, d.empleadoId);
      const ctx = await this.contexto.cargar(u.empresaId);
      const maxPct = ctx.parametros.valor('MAX_PCT_VACACIONES_DINERO', d.fecha) ?? D('0.5');
      const permitido = D(saldo.causados).mul(maxPct).minus(D(saldo.compensados));
      if (D(d.cantidad ?? 0).gt(permitido) && !d.confirmar)
        throw new ErrorNegocio(`Solo se puede pagar en dinero hasta ${permitido.toDecimalPlaces(2).toFixed()} días (la mitad de las vacaciones, CST art. 189)`, 409, { requiereConfirmacion: true });
    }
    const r = await this.db.one(
      `insert into novedades (empresa_id, empleado_id, clase, tipo, fecha, valor, cantidad, descripcion, creado_por) values ($1, $2, 'valor', $3, $4, $5, $6, $7, $8) returning *`,
      [u.empresaId, d.empleadoId, codigo, d.fecha, d.valor ?? null, d.cantidad ?? null, d.descripcion ?? null, u.id],
    );
    await this.auditoria.registrar(u, 'crear', 'novedad', r.id, null, r);
    return camel(r);
  }

  async editarEstado(u: UsuarioSesion, id: string, estado: 'pendiente' | 'aprobada' | 'rechazada') {
    const antes = await this.db.maybe('select * from novedades where id = $1 and empresa_id = $2', [id, u.empresaId]);
    if (!antes) throw new ErrorNegocio('Novedad no encontrada', 404);
    await this.verificarNoLiquidada(antes);
    const r = await this.db.one('update novedades set estado = $2 where id = $1 returning *', [id, estado]);
    await this.auditoria.registrar(u, 'cambiar_estado', 'novedad', id, antes, r);
    return camel(r);
  }

  private async verificarNoLiquidada(n: any) {
    const ini = n.desde ?? n.fecha;
    const fin = n.hasta ?? n.fecha;
    const cerrado = await this.db.maybe(
      `select p.nombre from periodos p join liquidaciones l on l.periodo_id = p.id where l.empleado_id = $1 and p.estado in ('aprobado', 'cerrado') and p.desde <= $3 and p.hasta >= $2 limit 1`,
      [n.empleado_id, ini, fin],
    );
    if (cerrado) throw new ErrorNegocio(`La novedad ya está en la nómina ${cerrado.nombre}, que está aprobada o cerrada. Haga el ajuste en el periodo abierto`);
  }

  async borrar(u: UsuarioSesion, id: string) {
    const antes = await this.db.maybe('select * from novedades where id = $1 and empresa_id = $2', [id, u.empresaId]);
    if (!antes) throw new ErrorNegocio('Novedad no encontrada', 404);
    await this.verificarNoLiquidada(antes);
    await this.db.exec('delete from novedades where id = $1', [id]);
    await this.auditoria.registrar(u, 'borrar', 'novedad', id, antes, null);
    return { ok: true };
  }

  /** Días de vacaciones causados, disfrutados, compensados y pendientes (HU-38). */
  async saldoVacaciones(u: UsuarioSesion, empleadoId: string, corte = fechaLocal()) {
    const ctx = await this.contexto.cargar(u.empresaId);
    const contratos = await this.db.many(`select * from contratos where empleado_id = $1 order by fecha_inicio`, [empleadoId]);
    const noRem = await this.db.many(
      `select desde, hasta from novedades where empleado_id = $1 and clase = 'dias' and tipo in ('licencia_no_remunerada', 'suspension') and estado = 'aprobada'`,
      [empleadoId],
    );
    let diasServicio = 0;
    for (const c of contratos) {
      const fin = minFecha(c.fecha_fin ?? corte, corte);
      if (fin < c.fecha_inicio) continue;
      diasServicio += diasComerciales(c.fecha_inicio, fin);
      for (const n of noRem) diasServicio -= Math.max(0, diasComerciales(maxFecha(n.desde, c.fecha_inicio), minFecha(n.hasta, fin)));
    }
    const porAnio = ctx.parametros.valor('DIAS_VACACIONES_ANIO', corte)?.toNumber() ?? 15;
    const inicial = await this.db.maybe(`select coalesce(sum(valor), 0) as v from saldos_iniciales where empleado_id = $1 and tipo = 'vacaciones_dias'`, [empleadoId]);
    const causados = D(diasServicio).mul(porAnio).div(360).plus(D(inicial?.v ?? 0));
    const disfrutados = await this.db.one(
      `select coalesce(sum(dias_habiles), 0) as v from novedades where empleado_id = $1 and tipo = 'vacaciones' and estado <> 'rechazada'`,
      [empleadoId],
    );
    const compensados = await this.db.one(
      `select coalesce(sum(cantidad), 0) as v from novedades where empleado_id = $1 and tipo = 'VACACIONES_COMPENSADAS' and estado <> 'rechazada'`,
      [empleadoId],
    );
    const pendientes = causados.minus(D(disfrutados.v)).minus(D(compensados.v));
    const periodos = pendientes.div(porAnio);
    return {
      corte,
      diasServicio,
      causados: causados.toDecimalPlaces(2).toFixed(),
      saldoInicial: D(inicial?.v ?? 0).toFixed(),
      disfrutados: D(disfrutados.v).toFixed(),
      compensados: D(compensados.v).toFixed(),
      pendientes: pendientes.toDecimalPlaces(2).toFixed(),
      periodosAcumulados: periodos.toDecimalPlaces(2).toFixed(),
      alertaAcumulacion: periodos.gt(ctx.configuracion.vacaciones.maxPeriodosAcumulados),
    };
  }

  /** Fecha de regreso antes de registrar (vista previa). */
  async calcularVacaciones(u: UsuarioSesion, empleadoId: string, desde: string, dias: number) {
    const ctx = await this.contexto.cargar(u.empresaId);
    const cal = await this.contexto.calendarioEmpleado(ctx, empleadoId);
    return cal.calcularVacaciones(desde, dias);
  }

  // ---------- Préstamos y embargos ----------

  async prestamos(u: UsuarioSesion, empleadoId?: string) {
    return camelLista(
      await this.db.many(
        `select p.*, e.nombres, e.apellidos from prestamos p join empleados e on e.id = p.empleado_id where p.empresa_id = $1 and ($2::uuid is null or p.empleado_id = $2) order by p.creado_en desc`,
        [u.empresaId, empleadoId || null],
      ),
    );
  }

  async crearPrestamo(u: UsuarioSesion, d: z.infer<typeof PrestamoDto>) {
    await this.empleado(u, d.empleadoId);
    if (!d.autorizacionEscrita) throw new ErrorNegocio('Los descuentos de nómina necesitan autorización escrita del trabajador (CST arts. 149 y 151)');
    const cuota = d.cuota ? D(d.cuota) : D(d.valorTotal).div(d.numeroCuotas).toDecimalPlaces(0, 2);
    const r = await this.db.one(
      `insert into prestamos (empresa_id, empleado_id, tipo, descripcion, valor_total, numero_cuotas, cuota, saldo, fecha_inicio, autorizacion_escrita)
       values ($1, $2, $3, $4, $5, $6, $7, $5, $8, true) returning *`,
      [u.empresaId, d.empleadoId, d.tipo, d.descripcion, d.valorTotal, d.numeroCuotas, cuota.toFixed(), d.fechaInicio],
    );
    await this.auditoria.registrar(u, 'crear', 'prestamo', r.id, null, r);
    return camel(r);
  }

  async editarPrestamo(u: UsuarioSesion, id: string, d: { activo?: boolean; cuota?: string; saldo?: string }) {
    const antes = await this.db.maybe('select * from prestamos where id = $1 and empresa_id = $2', [id, u.empresaId]);
    if (!antes) throw new ErrorNegocio('Préstamo no encontrado', 404);
    const r = await this.db.one('update prestamos set activo = coalesce($2, activo), cuota = coalesce($3, cuota), saldo = coalesce($4, saldo) where id = $1 returning *', [id, d.activo ?? null, d.cuota ?? null, d.saldo ?? null]);
    await this.auditoria.registrar(u, 'editar', 'prestamo', id, antes, r);
    return camel(r);
  }

  async embargos(u: UsuarioSesion, empleadoId?: string) {
    return camelLista(
      await this.db.many(
        `select b.*, e.nombres, e.apellidos from embargos b join empleados e on e.id = b.empleado_id where b.empresa_id = $1 and ($2::uuid is null or b.empleado_id = $2) order by b.creado_en desc`,
        [u.empresaId, empleadoId || null],
      ),
    );
  }

  async crearEmbargo(u: UsuarioSesion, d: z.infer<typeof EmbargoDto>) {
    await this.empleado(u, d.empleadoId);
    if (d.valorFijo == null && d.porcentaje == null) throw new ErrorNegocio('Indique el valor fijo o el porcentaje del embargo');
    const r = await this.db.one(
      `insert into embargos (empresa_id, empleado_id, tipo, descripcion, juzgado, numero_proceso, valor_fijo, porcentaje, saldo, prioridad)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
      [u.empresaId, d.empleadoId, d.tipo, d.descripcion, d.juzgado ?? null, d.numeroProceso ?? null, d.valorFijo ?? null, d.porcentaje ?? null, d.saldo ?? null, d.prioridad ?? null],
    );
    await this.auditoria.registrar(u, 'crear', 'embargo', r.id, null, r);
    return camel(r);
  }

  async editarEmbargo(u: UsuarioSesion, id: string, d: { activo?: boolean; saldo?: string | null }) {
    const antes = await this.db.maybe('select * from embargos where id = $1 and empresa_id = $2', [id, u.empresaId]);
    if (!antes) throw new ErrorNegocio('Embargo no encontrado', 404);
    const r = await this.db.one('update embargos set activo = coalesce($2, activo), saldo = coalesce($3, saldo) where id = $1 returning *', [id, d.activo ?? null, d.saldo ?? null]);
    await this.auditoria.registrar(u, 'editar', 'embargo', id, antes, r);
    return camel(r);
  }

  // ---------- Carga masiva de novedades (HU-39) y saldos iniciales (HU-59) ----------

  async plantilla(tipo: 'novedades' | 'saldos' | 'empleados'): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    if (tipo === 'novedades') {
      const ws = wb.addWorksheet('Novedades');
      ws.columns = ['documento', 'concepto', 'fecha (AAAA-MM-DD)', 'valor', 'cantidad', 'descripción'].map((h) => ({ header: h, width: 20 }));
      ws.addRow(['1012345678', 'COMISIONES', '2026-10-31', 500000, '', 'Comisión de ventas']);
    } else if (tipo === 'saldos') {
      const ws = wb.addWorksheet('Saldos');
      ws.columns = ['documento', 'tipo', 'valor', 'fecha de corte (AAAA-MM-DD)'].map((h) => ({ header: h, width: 24 }));
      ws.addRow(['1012345678', 'vacaciones_dias', 7.5, '2026-07-31']);
      const t = wb.addWorksheet('Tipos de saldo');
      t.addRows([
        ['tipo', 'qué es'],
        ['vacaciones_dias', 'Días de vacaciones pendientes a la fecha de corte'],
        ['cesantias', 'Cesantías causadas en el año hasta la fecha de corte'],
        ['intereses', 'Intereses de cesantías causados en el año'],
        ['prima', 'Prima causada en el semestre'],
        ['ingresos_retencion', 'Ingresos laborales del año (para retención y certificado)'],
        ['retencion', 'Retención practicada en el año'],
        ['aportes_obligatorios', 'Aportes obligatorios del empleado en el año'],
        ['variable_mes:AAAA-MM', 'Pagos salariales variables de ese mes (para promedios)'],
        ['salario_mes:AAAA-MM', 'Salario básico de ese mes (para promedios)'],
      ]);
    } else {
      const ws = wb.addWorksheet('Empleados');
      ws.columns = ['tipo_documento', 'documento', 'nombres', 'apellidos', 'correo', 'cargo', 'tipo_contrato', 'fecha_inicio', 'fecha_fin', 'salario', 'banco', 'tipo_cuenta', 'numero_cuenta'].map((h) => ({ header: h, width: 16 }));
      ws.addRow(['CC', '1012345678', 'María', 'López', 'maria@correo.com', 'Auxiliar', 'indefinido', '2024-02-01', '', 1750905, 'Bancolombia', 'Ahorros', '12345678901']);
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  private async leerExcel(archivoBase64: string): Promise<string[][]> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(archivoBase64, 'base64') as any);
    const ws = wb.worksheets[0];
    if (!ws) throw new ErrorNegocio('El archivo no tiene hojas');
    const filas: string[][] = [];
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const vals: string[] = [];
      for (let i = 1; i <= Math.max(ws.columnCount, 13); i++) {
        const v = row.getCell(i).value as any;
        vals.push(v instanceof Date ? v.toISOString().slice(0, 10) : v === null || v === undefined ? '' : String(v?.result ?? v?.text ?? v).trim());
      }
      if (vals.some(Boolean)) filas.push(vals);
    });
    return filas;
  }

  async importarNovedades(u: UsuarioSesion, d: { archivoBase64: string; confirmar: boolean }) {
    const filas = await this.leerExcel(d.archivoBase64);
    const empleados = new Map((await this.db.many('select id, numero_documento from empleados where empresa_id = $1', [u.empresaId])).map((e) => [e.numero_documento, e.id]));
    const conceptos = new Set((await this.db.many('select codigo from conceptos where empresa_id = $1', [u.empresaId])).map((c) => c.codigo));
    const errores: { fila: number; mensaje: string }[] = [];
    const validas: any[] = [];
    filas.forEach((f, i) => {
      const n = i + 2;
      const [doc, concepto, fecha, valor, cantidad, descripcion] = f;
      const empleadoId = empleados.get(doc);
      const codigo = normalizarId(concepto ?? '');
      if (!empleadoId) return errores.push({ fila: n, mensaje: `No existe el empleado ${doc}` });
      if (!conceptos.has(codigo) && !['HON', 'HED', 'HEN', 'HDD', 'HDN', 'HEDD', 'HEND'].includes(codigo)) return errores.push({ fila: n, mensaje: `El concepto ${concepto} no existe` });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return errores.push({ fila: n, mensaje: 'La fecha debe tener formato AAAA-MM-DD' });
      const num = (s: string) => (s ? s.replace(',', '.') : null);
      if (!valor && !cantidad) return errores.push({ fila: n, mensaje: 'Escriba el valor o la cantidad' });
      if ((valor && isNaN(Number(num(valor)))) || (cantidad && isNaN(Number(num(cantidad))))) return errores.push({ fila: n, mensaje: 'El valor o la cantidad no son números' });
      validas.push({ empleadoId, codigo, fecha, valor: num(valor), cantidad: num(cantidad), descripcion: descripcion || null });
    });
    if (!d.confirmar) return { validas: validas.length, errores, importadas: 0 };
    for (const v of validas)
      await this.db.exec(
        `insert into novedades (empresa_id, empleado_id, clase, tipo, fecha, valor, cantidad, descripcion, creado_por) values ($1, $2, 'valor', $3, $4, $5, $6, $7, $8)`,
        [u.empresaId, v.empleadoId, v.codigo, v.fecha, v.valor, v.cantidad, v.descripcion, u.id],
      );
    await this.auditoria.registrar(u, 'importar_novedades', 'novedad', null, null, { importadas: validas.length });
    return { validas: validas.length, errores, importadas: validas.length };
  }

  async importarSaldos(u: UsuarioSesion, d: { archivoBase64: string; confirmar: boolean }) {
    const filas = await this.leerExcel(d.archivoBase64);
    const empleados = new Map((await this.db.many('select id, numero_documento from empleados where empresa_id = $1', [u.empresaId])).map((e) => [e.numero_documento, e.id]));
    const tipos = /^(vacaciones_dias|cesantias|intereses|prima|ingresos_retencion|retencion|aportes_obligatorios|variable_mes:\d{4}-\d{2}|salario_mes:\d{4}-\d{2})$/;
    const errores: { fila: number; mensaje: string }[] = [];
    const validas: any[] = [];
    filas.forEach((f, i) => {
      const n = i + 2;
      const [doc, tipo, valor, fecha] = f;
      const empleadoId = empleados.get(doc);
      if (!empleadoId) return errores.push({ fila: n, mensaje: `No existe el empleado ${doc}` });
      if (!tipos.test(tipo)) return errores.push({ fila: n, mensaje: `Tipo de saldo no válido: ${tipo}` });
      if (isNaN(Number(String(valor).replace(',', '.')))) return errores.push({ fila: n, mensaje: 'El valor no es un número' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return errores.push({ fila: n, mensaje: 'La fecha de corte debe tener formato AAAA-MM-DD' });
      validas.push({ empleadoId, tipo, valor: String(valor).replace(',', '.'), fecha });
    });
    if (!d.confirmar) return { validas: validas.length, errores, importadas: 0 };
    for (const v of validas)
      await this.db.exec(
        `insert into saldos_iniciales (empresa_id, empleado_id, tipo, valor, fecha_corte) values ($1, $2, $3, $4, $5)
         on conflict (empleado_id, tipo, fecha_corte) do update set valor = excluded.valor`,
        [u.empresaId, v.empleadoId, v.tipo, v.valor, v.fecha],
      );
    await this.auditoria.registrar(u, 'importar_saldos', 'saldo_inicial', null, null, { importadas: validas.length });
    return { validas: validas.length, errores, importadas: validas.length };
  }

  /** Crea empleados y contratos desde Excel (HU-59). */
  async importarEmpleados(u: UsuarioSesion, d: { archivoBase64: string; confirmar: boolean }) {
    const filas = await this.leerExcel(d.archivoBase64);
    const existentes = new Set((await this.db.many('select numero_documento from empleados where empresa_id = $1', [u.empresaId])).map((e) => e.numero_documento));
    const tiposContrato = ['indefinido', 'fijo', 'obra_labor', 'ocasional', 'aprendizaje', 'integral', 'tiempo_parcial'];
    const errores: { fila: number; mensaje: string }[] = [];
    const validas: any[] = [];
    filas.forEach((f, i) => {
      const n = i + 2;
      const [tipoDoc, doc, nombres, apellidos, correo, cargo, tipoContrato, inicio, fin, salario, banco, tipoCuenta, cuenta] = f;
      if (!doc || !nombres || !apellidos) return errores.push({ fila: n, mensaje: 'Faltan documento, nombres o apellidos' });
      if (existentes.has(doc)) return errores.push({ fila: n, mensaje: `Ya existe un empleado con documento ${doc}` });
      if (!tiposContrato.includes(tipoContrato)) return errores.push({ fila: n, mensaje: `Tipo de contrato no válido: ${tipoContrato}` });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(inicio)) return errores.push({ fila: n, mensaje: 'La fecha de inicio debe tener formato AAAA-MM-DD' });
      if (fin && !/^\d{4}-\d{2}-\d{2}$/.test(fin)) return errores.push({ fila: n, mensaje: 'La fecha fin debe tener formato AAAA-MM-DD' });
      if (tipoContrato === 'fijo' && !fin) return errores.push({ fila: n, mensaje: 'El contrato a término fijo necesita fecha fin' });
      if (isNaN(Number(salario))) return errores.push({ fila: n, mensaje: 'El salario no es un número' });
      existentes.add(doc);
      validas.push({ tipoDoc: tipoDoc || 'CC', doc, nombres, apellidos, correo: correo || null, cargo: cargo || null, tipoContrato, inicio, fin: fin || null, salario, banco: banco || null, tipoCuenta: tipoCuenta || null, cuenta: cuenta || null });
    });
    if (!d.confirmar) return { validas: validas.length, errores, importadas: 0 };
    const grupo = await this.db.maybe('select id from grupos_pago where empresa_id = $1 and activo order by nombre limit 1', [u.empresaId]);
    const sede = await this.db.maybe('select id from sedes where empresa_id = $1 and activa order by nombre limit 1', [u.empresaId]);
    const turno = await this.db.maybe('select id from turnos where empresa_id = $1 and activo order by nombre limit 1', [u.empresaId]);
    await this.db.tx(async (c) => {
      for (const v of validas) {
        const e = await this.db.one(
          `insert into empleados (empresa_id, tipo_documento, numero_documento, nombres, apellidos, correo, cargo, banco, tipo_cuenta, numero_cuenta, grupo_pago_id, sede_id, turno_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
          [u.empresaId, v.tipoDoc, v.doc, v.nombres, v.apellidos, v.correo, v.cargo, v.banco, v.tipoCuenta, v.cuenta, grupo?.id ?? null, sede?.id ?? null, turno?.id ?? null],
          c,
        );
        const ct = await this.db.one(
          `insert into contratos (empresa_id, empleado_id, tipo, fecha_inicio, fecha_fin, fecha_fin_pactada, cargo, salario_integral, tipo_salario)
           values ($1, $2, $3, $4, $5, $5, $6, $7, $8) returning id`,
          [u.empresaId, e.id, v.tipoContrato, v.inicio, v.fin, v.cargo, v.tipoContrato === 'integral', v.tipoContrato === 'integral' ? 'integral' : 'fijo'],
          c,
        );
        await this.db.exec(`insert into historial_salarial (contrato_id, desde, salario, motivo, creado_por) values ($1, $2, $3, 'Carga inicial', $4)`, [ct.id, v.inicio, v.salario, u.id], c);
      }
    });
    await this.auditoria.registrar(u, 'importar_empleados', 'empleado', null, null, { importados: validas.length });
    return { validas: validas.length, errores, importadas: validas.length };
  }

  // ---------- Dotación (HU-50) ----------

  async dotacion(u: UsuarioSesion, fecha: string) {
    const ctx = await this.contexto.cargar(u.empresaId);
    const smmlv = ctx.parametros.valor('SMMLV', fecha) ?? D(0);
    const filas = await this.db.many(
      `select e.id, e.nombres, e.apellidos, e.numero_documento, e.campos_adicionales, c.fecha_inicio,
              (select h.salario from historial_salarial h where h.contrato_id = c.id and h.desde <= $2 order by h.desde desc limit 1) as salario,
              d.entregado_en, d.elementos, d.confirmado
       from empleados e join contratos c on c.empleado_id = e.id and c.estado = 'activo'
       left join entregas_dotacion d on d.empleado_id = e.id and d.fecha_programada = $2
       where e.empresa_id = $1 and e.estado = 'activo' order by e.apellidos`,
      [u.empresaId, fecha],
    );
    return filas
      .filter((f) => D(f.salario ?? 0).lte(smmlv.mul(2)) && diasComerciales(f.fecha_inicio, fecha) > 90)
      .map((f) => ({ empleadoId: f.id, empleado: nombreCompleto(f), documento: f.numero_documento, salario: f.salario, entregadoEn: f.entregado_en, elementos: f.elementos, confirmado: f.confirmado }));
  }

  async registrarDotacion(u: UsuarioSesion, d: { empleadoId: string; fechaProgramada: string; entregadoEn: string; elementos: string; confirmado: boolean }) {
    await this.empleado(u, d.empleadoId);
    const r = await this.db.one(
      `insert into entregas_dotacion (empresa_id, empleado_id, fecha_programada, entregado_en, elementos, confirmado) values ($1, $2, $3, $4, $5, $6)
       on conflict (empleado_id, fecha_programada) do update set entregado_en = excluded.entregado_en, elementos = excluded.elementos, confirmado = excluded.confirmado returning *`,
      [u.empresaId, d.empleadoId, d.fechaProgramada, d.entregadoEn, d.elementos, d.confirmado],
    );
    await this.auditoria.registrar(u, 'entregar_dotacion', 'empleado', d.empleadoId, null, r);
    return camel(r);
  }
}

@Controller('novedades')
export class NovedadesController {
  constructor(private readonly s: NovedadesService) {}

  @Get()
  listar(@Usuario() u: UsuarioSesion, @Query() q: any) {
    return this.s.listar(u, q);
  }

  @Get('licencias')
  licencias() {
    return LICENCIAS_REMUNERADAS;
  }

  @Post('dias')
  dias(@Usuario() u: UsuarioSesion, @Body(new Validar(NovedadDiasDto)) d: z.infer<typeof NovedadDiasDto>) {
    return this.s.crearDias(u, d);
  }

  @Post('valor')
  valor(@Usuario() u: UsuarioSesion, @Body(new Validar(NovedadValorDto)) d: z.infer<typeof NovedadValorDto>) {
    return this.s.crearValor(u, d);
  }

  @Patch(':id/estado')
  estado(@Usuario() u: UsuarioSesion, @Param('id') id: string, @Body(new Validar(z.object({ estado: z.enum(['pendiente', 'aprobada', 'rechazada']) }))) d: any) {
    return this.s.editarEstado(u, id, d.estado);
  }

  @Delete(':id')
  borrar(@Usuario() u: UsuarioSesion, @Param('id') id: string) {
    return this.s.borrar(u, id);
  }

  @Get('vacaciones/:empleadoId/saldo')
  saldo(@Usuario() u: UsuarioSesion, @Param('empleadoId') id: string, @Query('corte') corte?: string) {
    return this.s.saldoVacaciones(u, id, corte);
  }

  @Get('vacaciones/:empleadoId/calcular')
  calcular(@Usuario() u: UsuarioSesion, @Param('empleadoId') id: string, @Query('desde') desde: string, @Query('dias') dias: string) {
    return this.s.calcularVacaciones(u, id, desde, Number(dias));
  }

  @Get('plantilla/:tipo')
  async plantilla(@Param('tipo') tipo: 'novedades' | 'saldos' | 'empleados') {
    if (!['novedades', 'saldos', 'empleados'].includes(tipo)) throw new ErrorNegocio('Plantilla no encontrada', 404);
    return { nombre: `plantilla-${tipo}.xlsx`, archivoBase64: (await this.s.plantilla(tipo)).toString('base64') };
  }

  @Post('importar/:tipo')
  importar(@Usuario() u: UsuarioSesion, @Param('tipo') tipo: string, @Body(new Validar(z.object({ archivoBase64: z.string().min(10), confirmar: z.boolean().default(false) }))) d: any) {
    if (tipo === 'novedades') return this.s.importarNovedades(u, d);
    if (tipo === 'saldos') return this.s.importarSaldos(u, d);
    if (tipo === 'empleados') return this.s.importarEmpleados(u, d);
    throw new ErrorNegocio('Tipo de importación no válido', 404);
  }

  @Get('dotacion')
  dotacion(@Usuario() u: UsuarioSesion, @Query('fecha') fecha: string) {
    return this.s.dotacion(u, fecha ?? fechaLocal());
  }

  @Post('dotacion')
  registrarDotacion(
    @Usuario() u: UsuarioSesion,
    @Body(new Validar(z.object({ empleadoId: z.string().uuid(), fechaProgramada: zFecha, entregadoEn: zFecha, elementos: z.string().min(1), confirmado: z.boolean() }))) d: any,
  ) {
    return this.s.registrarDotacion(u, d);
  }
}

@Controller()
export class DescuentosController {
  constructor(private readonly s: NovedadesService) {}

  @Get('prestamos')
  prestamos(@Usuario() u: UsuarioSesion, @Query('empleadoId') id?: string) {
    return this.s.prestamos(u, id);
  }

  @Post('prestamos')
  crearPrestamo(@Usuario() u: UsuarioSesion, @Body(new Validar(PrestamoDto)) d: z.infer<typeof PrestamoDto>) {
    return this.s.crearPrestamo(u, d);
  }

  @Patch('prestamos/:id')
  editarPrestamo(@Usuario() u: UsuarioSesion, @Param('id') id: string, @Body(new Validar(z.object({ activo: z.boolean().optional(), cuota: zNumero.optional(), saldo: zNumero.optional() }))) d: any) {
    return this.s.editarPrestamo(u, id, d);
  }

  @Get('embargos')
  embargos(@Usuario() u: UsuarioSesion, @Query('empleadoId') id?: string) {
    return this.s.embargos(u, id);
  }

  @Post('embargos')
  crearEmbargo(@Usuario() u: UsuarioSesion, @Body(new Validar(EmbargoDto)) d: z.infer<typeof EmbargoDto>) {
    return this.s.crearEmbargo(u, d);
  }

  @Patch('embargos/:id')
  editarEmbargo(@Usuario() u: UsuarioSesion, @Param('id') id: string, @Body(new Validar(z.object({ activo: z.boolean().optional(), saldo: zNumero.optional().nullable() }))) d: any) {
    return this.s.editarEmbargo(u, id, d);
  }
}
