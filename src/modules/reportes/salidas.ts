import { Body, Controller, Get, Injectable, Param, Patch, Post, Query } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { AuditoriaService } from '../../common/auditoria.service';
import { ErrorNegocio, Usuario, UsuarioSesion, Validar } from '../../common/comun';
import { crearPdf, encabezado, tabla } from '../../common/pdf';
import { camel, camelLista, fechaLocal, nombreCompleto, pesos, zFecha } from '../../common/util';
import { Db } from '../../db/db.service';
import { contabilizar, FormatoArchivo, generarArchivo } from '../../domain/archivos';
import { D, sum } from '../../domain/decimal';
import { diferenciaDias, sumarDias } from '../../domain/fechas';
import { ContextoService } from '../configuracion/contexto.service';
import { EmpleadosService } from '../empleados/empleados';
import { NovedadesService } from '../novedades/novedades';

const TIPO_CUENTA_CODIGO: Record<string, string> = { ahorros: 'S', corriente: 'D' };
const TIPO_DOC_CODIGO: Record<string, string> = { CC: '1', CE: '2', NIT: '3', TI: '4', PA: '5', PEP: '6', PPT: '7' };

// ---------- Pagos al banco (HU-57) ----------

@Injectable()
export class PagosService {
  constructor(
    private readonly db: Db,
    private readonly auditoria: AuditoriaService,
  ) {}

  async pagos(u: UsuarioSesion, periodoId: string) {
    return camelLista(
      await this.db.many(
        `select pa.*, e.nombres, e.apellidos, e.numero_documento, e.banco, e.tipo_cuenta, e.numero_cuenta from pagos pa join empleados e on e.id = pa.empleado_id
         where pa.periodo_id = $1 and pa.empresa_id = $2 order by e.apellidos`,
        [periodoId, u.empresaId],
      ),
    );
  }

  async generar(u: UsuarioSesion, periodoId: string, d: { formato: string; excluirInvalidos: boolean }) {
    const p = await this.db.maybe('select * from periodos where id = $1 and empresa_id = $2', [periodoId, u.empresaId]);
    if (!p) throw new ErrorNegocio('Periodo no encontrado', 404);
    if (p.estado !== 'aprobado' && p.estado !== 'cerrado') throw new ErrorNegocio('Solo se genera el archivo de una nómina aprobada');
    const f = await this.db.maybe(`select * from formatos_archivo where empresa_id = $1 and clase = 'banco' and codigo = $2 and activo`, [u.empresaId, d.formato]);
    if (!f) throw new ErrorNegocio('Formato de banco no encontrado', 404);
    const empresa = await this.db.one('select * from empresas where id = $1', [u.empresaId]);
    const filas = await this.db.many(
      `select l.neto, e.* from liquidaciones l join empleados e on e.id = l.empleado_id where l.periodo_id = $1 and l.neto > 0 order by e.apellidos`,
      [periodoId],
    );
    const invalidos = filas
      .filter((e) => !e.numero_cuenta || !/^\d{4,20}$/.test(String(e.numero_cuenta).replace(/[\s-]/g, '')) || !e.banco)
      .map((e) => ({ empleadoId: e.id, empleado: nombreCompleto(e), motivo: !e.numero_cuenta ? 'Sin cuenta bancaria' : !e.banco ? 'Sin banco' : 'Número de cuenta no válido' }));
    if (invalidos.length && !d.excluirInvalidos) throw new ErrorNegocio('Hay empleados sin cuenta bancaria o con datos inválidos', 409, { invalidos, requiereConfirmacion: true });
    const validos = filas.filter((e) => !invalidos.some((i) => i.empleadoId === e.id));
    const total = sum(validos.map((e) => e.neto));
    const def = f.definicion as FormatoArchivo;
    const contenido = generarArchivo(
      def,
      {
        empresa: { nit: empresa.nit, razonSocial: empresa.razon_social, cuenta: empresa.cuenta_pagadora ?? '', tipoCuentaCodigo: TIPO_CUENTA_CODIGO[(empresa.tipo_cuenta_pagadora ?? '').toLowerCase()] ?? empresa.tipo_cuenta_pagadora ?? '' },
        fechaPago: p.fecha_pago ?? p.hasta,
        total: { registros: validos.length, valor: total.toFixed(2) },
      },
      validos.map((e) => ({
        empleado: {
          documento: e.numero_documento,
          nombre: nombreCompleto(e),
          banco: e.banco,
          codigoBanco: e.codigo_banco ?? '',
          cuenta: String(e.numero_cuenta).replace(/[\s-]/g, ''),
          tipoCuenta: e.tipo_cuenta,
          tipoCuentaCodigo: TIPO_CUENTA_CODIGO[(e.tipo_cuenta ?? '').toLowerCase()] ?? e.tipo_cuenta ?? '',
          tipoDocumentoCodigo: TIPO_DOC_CODIGO[e.tipo_documento] ?? '1',
          tipoTransaccion: (e.tipo_cuenta ?? '').toLowerCase() === 'corriente' ? '27' : '37',
        },
        pago: { valor: D(e.neto).toFixed(2), referencia: p.nombre.slice(0, 21) },
      })),
    );
    await this.db.exec('update periodos set archivo_banco_en = now() where id = $1', [periodoId]);
    await this.db.exec(`update pagos set formato = $2 where periodo_id = $1`, [periodoId, d.formato]);
    await this.auditoria.registrar(u, 'generar_archivo_banco', 'periodo', periodoId, null, { formato: d.formato, registros: validos.length, total: total.toFixed() });
    return {
      nombre: `${d.formato.toLowerCase()}-${p.desde}.${def.extension}`,
      contenidoBase64: Buffer.from(contenido, 'latin1').toString('base64'),
      registros: validos.length,
      total: total.toFixed(),
      excluidos: invalidos,
      nota: def.nota ?? null,
    };
  }

  async marcar(u: UsuarioSesion, d: { ids: string[]; estado: 'pagado' | 'rechazado' | 'pendiente'; fecha?: string; observacion?: string }) {
    const n = await this.db.exec(`update pagos set estado = $3, fecha = coalesce($4, fecha), observacion = coalesce($5, observacion) where empresa_id = $1 and id = any($2::uuid[])`, [
      u.empresaId,
      d.ids,
      d.estado,
      d.fecha ?? fechaLocal(),
      d.observacion ?? null,
    ]);
    await this.auditoria.registrar(u, 'marcar_pagos', 'pago', null, null, d);
    return { actualizados: n };
  }
}

@Controller('pagos')
export class PagosController {
  constructor(private readonly s: PagosService) {}

  @Get('periodos/:id')
  pagos(@Usuario() u: UsuarioSesion, @Param('id') id: string) {
    return this.s.pagos(u, id);
  }

  @Post('periodos/:id/archivo')
  generar(@Usuario() u: UsuarioSesion, @Param('id') id: string, @Body(new Validar(z.object({ formato: z.string().min(1), excluirInvalidos: z.boolean().default(false) }))) d: any) {
    return this.s.generar(u, id, d);
  }

  @Patch()
  marcar(@Usuario() u: UsuarioSesion, @Body(new Validar(z.object({ ids: z.array(z.string().uuid()).min(1), estado: z.enum(['pagado', 'rechazado', 'pendiente']), fecha: zFecha.optional(), observacion: z.string().optional() }))) d: any) {
    return this.s.marcar(u, d);
  }
}

// ---------- Contabilidad (HU-58) ----------

@Injectable()
export class ContabilidadService {
  constructor(
    private readonly db: Db,
    private readonly auditoria: AuditoriaService,
  ) {}

  async comprobante(u: UsuarioSesion, periodoId: string) {
    const p = await this.db.maybe('select * from periodos where id = $1 and empresa_id = $2', [periodoId, u.empresaId]);
    if (!p) throw new ErrorNegocio('Periodo no encontrado', 404);
    const lineas = await this.db.many(
      `select ll.concepto, ll.nombre, ll.tipo, ll.valor, c.cuenta_debito, c.cuenta_credito, c.tercero_credito, cc.codigo as centro,
              e.numero_documento, e.nombres, e.apellidos, eps.nit as eps_nit, eps.nombre as eps_nombre, afp.nit as afp_nit, afp.nombre as afp_nombre,
              ces.nit as ces_nit, ces.nombre as ces_nombre, ccf.nit as ccf_nit, ccf.nombre as ccf_nombre
       from liquidacion_lineas ll
       join empleados e on e.id = ll.empleado_id
       left join conceptos c on c.empresa_id = ll.empresa_id and c.codigo = ll.concepto
       left join centros_costo cc on cc.id = e.centro_costo_id
       left join entidades eps on eps.id = e.eps_id left join entidades afp on afp.id = e.afp_id
       left join entidades ces on ces.id = e.cesantias_id left join entidades ccf on ccf.id = e.ccf_id
       where ll.periodo_id = $1`,
      [periodoId],
    );
    const entidad = async (tipo: string) => this.db.maybe(`select nit, nombre from entidades where empresa_id = $1 and tipo = $2 and activa order by nombre limit 1`, [u.empresaId, tipo]);
    const arl = await entidad('arl');
    const dian = await entidad('dian');
    const icbf = { nit: '899999239', nombre: 'ICBF' };
    const sena = { nit: '899999034', nombre: 'SENA' };
    const tercero = (l: any) => {
      const t = (nit: string | null, nombre: string | null) => (nit ? { nit, nombre: nombre ?? '' } : undefined);
      switch (l.tercero_credito) {
        case 'eps':
          return t(l.eps_nit, l.eps_nombre);
        case 'afp':
          return t(l.afp_nit, l.afp_nombre);
        case 'cesantias':
          return t(l.ces_nit, l.ces_nombre);
        case 'ccf':
          return t(l.ccf_nit, l.ccf_nombre);
        case 'arl':
          return arl ? { nit: arl.nit, nombre: arl.nombre } : undefined;
        case 'dian':
          return dian ? { nit: dian.nit, nombre: dian.nombre } : { nit: '800197268', nombre: 'DIAN' };
        case 'icbf':
          return icbf;
        case 'sena':
          return sena;
      }
      return undefined;
    };
    const r = contabilizar(
      lineas.map((l) => ({
        concepto: l.concepto,
        nombre: l.nombre,
        tipo: l.tipo,
        valor: l.valor,
        cuentaDebito: l.cuenta_debito ?? (l.concepto === 'CESANTIAS_CONSIGNAR' ? '261005' : l.concepto === 'EMBARGO' || l.concepto === 'PRESTAMO' || l.concepto === 'LIBRANZA' ? '250505' : null),
        cuentaCredito: l.cuenta_credito ?? (l.concepto === 'CESANTIAS_CONSIGNAR' ? '250510' : l.concepto === 'EMBARGO' ? '238030' : l.concepto === 'PRESTAMO' || l.concepto === 'LIBRANZA' ? '136525' : null),
        centroCosto: l.centro ?? '',
        empleado: { nit: l.numero_documento, nombre: nombreCompleto(l) },
        terceroCredito: tercero(l),
      })),
    );
    return { periodo: camel(p), ...r, cuadrado: r.debitos === r.creditos };
  }

  async exportar(u: UsuarioSesion, periodoId: string, formato: string) {
    const c = await this.comprobante(u, periodoId);
    if (c.sinCuenta.length) throw new ErrorNegocio('Hay conceptos sin cuenta contable', 400, { sinCuenta: c.sinCuenta });
    const f = await this.db.maybe(`select * from formatos_archivo where empresa_id = $1 and clase = 'contable' and codigo = $2 and activo`, [u.empresaId, formato]);
    if (!f) throw new ErrorNegocio('Formato contable no encontrado', 404);
    const def = f.definicion as FormatoArchivo;
    const contenido = generarArchivo(def, { fecha: c.periodo.hasta, comprobante: c.periodo.nombre.slice(0, 20) }, c.movimientos as any);
    await this.auditoria.registrar(u, 'exportar_contabilidad', 'periodo', periodoId, null, { formato });
    return { nombre: `contabilidad-${formato.toLowerCase()}-${c.periodo.desde}.${def.extension}`, contenidoBase64: Buffer.from(contenido, 'utf8').toString('base64'), movimientos: c.movimientos.length, nota: def.nota ?? null };
  }
}

@Controller('contabilidad')
export class ContabilidadController {
  constructor(private readonly s: ContabilidadService) {}

  @Get('periodos/:id')
  comprobante(@Usuario() u: UsuarioSesion, @Param('id') id: string) {
    return this.s.comprobante(u, id);
  }

  @Post('periodos/:id/exportar')
  exportar(@Usuario() u: UsuarioSesion, @Param('id') id: string, @Body(new Validar(z.object({ formato: z.string().min(1) }))) d: { formato: string }) {
    return this.s.exportar(u, id, d.formato);
  }
}

// ---------- Reportes, panel e indicadores (HU-60) ----------

@Injectable()
export class ReportesService {
  constructor(
    private readonly db: Db,
    private readonly contexto: ContextoService,
    private readonly empleados: EmpleadosService,
    private readonly novedades: NovedadesService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /** Indicadores del panel de inicio. */
  async panel(u: UsuarioSesion, q: { meses?: string }) {
    const meses = Number(q.meses ?? 12);
    const hoy = fechaLocal();
    const activos = await this.db.one(`select count(*)::int as n from empleados where empresa_id = $1 and estado = 'activo'`, [u.empresaId]);
    const ultimo = await this.db.maybe(
      `select p.*, (select coalesce(sum(costo_total), 0) from liquidaciones l where l.periodo_id = p.id) as costo,
              (select coalesce(sum(neto), 0) from liquidaciones l where l.periodo_id = p.id) as neto,
              (select coalesce(sum(provisiones), 0) from liquidaciones l where l.periodo_id = p.id) as provisiones
       from periodos p where p.empresa_id = $1 and p.tipo = 'nomina' and p.estado <> 'abierto' order by p.hasta desc limit 1`,
      [u.empresaId],
    );
    const anterior = ultimo
      ? await this.db.maybe(
          `select (select coalesce(sum(costo_total), 0) from liquidaciones l where l.periodo_id = p.id) as costo, (select coalesce(sum(neto), 0) from liquidaciones l where l.periodo_id = p.id) as neto
           from periodos p where p.empresa_id = $1 and p.tipo = 'nomina' and p.estado <> 'abierto' and p.hasta < $2 order by p.hasta desc limit 1`,
          [u.empresaId, ultimo.desde],
        )
      : null;
    const serie = await this.db.many(
      `select to_char(p.hasta, 'YYYY-MM') as mes, sum(l.costo_total) as costo, sum(l.neto) as neto, sum(l.aportes) as aportes, sum(l.provisiones) as provisiones
       from periodos p join liquidaciones l on l.periodo_id = p.id
       where p.empresa_id = $1 and p.tipo = 'nomina' and p.estado <> 'abierto' and p.hasta >= ($2::date - make_interval(months => $3)) group by 1 order by 1`,
      [u.empresaId, hoy, meses],
    );
    const distribucion = ultimo
      ? await this.db.many(
          `select case
              when ll.tipo = 'aporte_empleador' then 'Seguridad social y parafiscales'
              when ll.tipo = 'provision' then 'Prestaciones (provisión)'
              when ll.concepto in ('SALARIO_BASICO', 'SALARIO_INTEGRAL', 'APOYO_SOSTENIMIENTO') then 'Salarios'
              when ll.concepto in ('HON', 'HED', 'HEN', 'HDD', 'HDN', 'HEDD', 'HEND') then 'Horas extra y recargos'
              when ll.concepto = 'AUXILIO_TRANSPORTE' then 'Auxilio de transporte'
              else 'Otros pagos' end as grupo, sum(ll.valor) as total
           from liquidacion_lineas ll where ll.periodo_id = $1 and ll.tipo <> 'deduccion' group by 1 order by 2 desc`,
          [ultimo.id],
        )
      : [];
    const extras = await this.db.one(
      `select coalesce(sum(horas), 0) as horas from horas_registradas where empresa_id = $1 and estado = 'aprobada' and tipo <> 'HOD' and fecha >= date_trunc('month', $2::date)`,
      [u.empresaId, hoy],
    );
    const ausentismo = await this.db.one(
      `select count(distinct empleado_id)::int as personas, coalesce(sum(least(hasta, $2::date) - greatest(desde, date_trunc('month', $2::date)::date) + 1), 0)::int as dias
       from novedades where empresa_id = $1 and clase = 'dias' and estado = 'aprobada' and tipo in ('incapacidad_eg', 'incapacidad_laboral', 'licencia_no_remunerada', 'ausencia_injustificada', 'suspension')
         and desde <= $2 and hasta >= date_trunc('month', $2::date)`,
      [u.empresaId, hoy],
    );
    const prov = await this.db.one(
      `select coalesce(sum(case when ll.concepto in ('PROV_CESANTIAS', 'PROV_INTERESES') then ll.valor end), 0) as cesantias,
              coalesce(sum(case when ll.concepto = 'PROV_PRIMA' then ll.valor end), 0) as prima,
              coalesce(sum(case when ll.concepto = 'PROV_VACACIONES' then ll.valor end), 0) as vacaciones
       from liquidacion_lineas ll join periodos p on p.id = ll.periodo_id where ll.empresa_id = $1 and p.estado <> 'abierto' and p.hasta >= date_trunc('year', $2::date)`,
      [u.empresaId, hoy],
    );
    const variacion = (a: any, b: any) => (b && D(b).gt(0) ? D(a).minus(D(b)).div(D(b)).toDecimalPlaces(4).toFixed() : null);
    return {
      empleadosActivos: activos.n,
      ultimoPeriodo: ultimo ? { id: ultimo.id, nombre: ultimo.nombre, estado: ultimo.estado, costo: ultimo.costo, neto: ultimo.neto, provisiones: ultimo.provisiones, variacionCosto: variacion(ultimo.costo, anterior?.costo), variacionNeto: variacion(ultimo.neto, anterior?.neto) } : null,
      serie: camelLista(serie),
      distribucion,
      horasExtraMes: extras.horas,
      ausentismoMes: ausentismo,
      provisionesAnio: prov,
      pendientes: await this.pendientes(u),
      calendario: await this.calendarioObligaciones(u),
    };
  }

  /** Lo que hay que hacer: horas por aprobar, contratos por vencer, nóminas por revisar, etc. */
  async pendientes(u: UsuarioSesion) {
    const hoy = fechaLocal();
    const out: { tipo: string; titulo: string; detalle: string; cantidad: number; enlace: string; nivel: 'info' | 'advertencia' | 'urgente' }[] = [];
    const horas = await this.db.one(`select count(*)::int as n, coalesce(sum(horas), 0) as h from horas_registradas where empresa_id = $1 and estado = 'pendiente'`, [u.empresaId]);
    if (horas.n) out.push({ tipo: 'horas', titulo: `${D(horas.h).toDecimalPlaces(1).toFixed()} horas extra por aprobar`, detalle: 'Sin aprobar no pasan a la nómina', cantidad: horas.n, enlace: '/asistencia/horas', nivel: 'advertencia' });
    const contratos = await this.empleados.contratosPorVencer(u);
    if (contratos.length)
      out.push({ tipo: 'contratos', titulo: `${contratos.length} contrato(s) por vencer`, detalle: contratos.slice(0, 3).map((c) => `${c.empleado} (${c.fechaFin})`).join(', '), cantidad: contratos.length, enlace: '/empleados?filtro=por-vencer', nivel: contratos.some((c) => c.diasRestantes <= 30) ? 'urgente' : 'advertencia' });
    const porRevisar = await this.db.many(`select id, nombre, estado from periodos where empresa_id = $1 and estado in ('liquidado', 'aprobado') order by desde`, [u.empresaId]);
    for (const p of porRevisar)
      out.push({ tipo: 'nomina', titulo: p.estado === 'liquidado' ? `${p.nombre}: por revisar y aprobar` : `${p.nombre}: aprobada, falta cerrar`, detalle: 'Revise el comparativo y las alertas', cantidad: 1, enlace: `/nomina/${p.id}`, nivel: 'info' });
    const incompletas = await this.db.one(
      `select count(*)::int as n from marcaciones m where m.empresa_id = $1 and not m.anulada and m.tipo = 'entrada' and m.hora < now() - interval '20 hours' and m.hora > now() - interval '15 days'
         and not exists (select 1 from marcaciones s where s.empleado_id = m.empleado_id and not s.anulada and s.tipo = 'salida' and s.hora > m.hora and s.hora < m.hora + interval '20 hours')`,
      [u.empresaId],
    );
    if (incompletas.n) out.push({ tipo: 'marcaciones', titulo: `${incompletas.n} marcación(es) sin salida`, detalle: 'Corríjalas para que las horas se calculen', cantidad: incompletas.n, enlace: '/asistencia/marcaciones', nivel: 'advertencia' });
    const soportes = await this.db.one(`select count(*)::int as n from empleados where empresa_id = $1 and estado = 'activo' and soportes_retencion_hasta < $2`, [u.empresaId, hoy]);
    if (soportes.n) out.push({ tipo: 'retencion', titulo: `${soportes.n} empleado(s) con soportes de retención vencidos`, detalle: 'Las deducciones dejan de aplicarse', cantidad: soportes.n, enlace: '/empleados', nivel: 'info' });
    const sinEps = await this.db.one(`select count(*)::int as n from empleados where empresa_id = $1 and estado = 'activo' and eps_id is null and not es_pensionado`, [u.empresaId]);
    if (sinEps.n) out.push({ tipo: 'afiliaciones', titulo: `${sinEps.n} empleado(s) sin EPS registrada`, detalle: 'Complete las afiliaciones antes de liquidar', cantidad: sinEps.n, enlace: '/empleados', nivel: 'advertencia' });
    for (const o of await this.calendarioObligaciones(u))
      if (o.diasRestantes >= 0 && o.diasRestantes <= o.avisarDias) out.push({ tipo: 'obligacion', titulo: `${o.nombre}: faltan ${o.diasRestantes} días`, detalle: `Fecha límite ${o.fecha}`, cantidad: 1, enlace: o.enlace, nivel: o.diasRestantes <= 5 ? 'urgente' : 'advertencia' });
    return out;
  }

  /** Fechas legales del año (prima, intereses, cesantías, dotación). */
  async calendarioObligaciones(u: UsuarioSesion) {
    const ctx = await this.contexto.cargar(u.empresaId);
    const hoy = fechaLocal();
    const anio = Number(hoy.slice(0, 4));
    const av = ctx.configuracion.avisos;
    const lista = [
      { nombre: 'Pago de intereses sobre cesantías', fecha: `${anio}-01-31`, avisarDias: av.diasCesantias, enlace: '/prestaciones', baseLegal: 'Ley 52 de 1975' },
      { nombre: 'Consignación de cesantías al fondo', fecha: `${anio}-02-14`, avisarDias: av.diasCesantias, enlace: '/prestaciones', baseLegal: 'Ley 50 de 1990 art. 99' },
      { nombre: 'Entrega de dotación', fecha: `${anio}-04-30`, avisarDias: 15, enlace: '/novedades/dotacion', baseLegal: 'CST art. 232' },
      { nombre: 'Prima de servicios (primer pago)', fecha: `${anio}-06-30`, avisarDias: av.diasPrima, enlace: '/prestaciones', baseLegal: 'CST art. 306' },
      { nombre: 'Entrega de dotación', fecha: `${anio}-08-31`, avisarDias: 15, enlace: '/novedades/dotacion', baseLegal: 'CST art. 232' },
      { nombre: 'Prima de servicios (segundo pago)', fecha: `${anio}-12-20`, avisarDias: av.diasPrima, enlace: '/prestaciones', baseLegal: 'CST art. 306' },
      { nombre: 'Entrega de dotación', fecha: `${anio}-12-20`, avisarDias: 15, enlace: '/novedades/dotacion', baseLegal: 'CST art. 232' },
      { nombre: 'Pago de intereses sobre cesantías', fecha: `${anio + 1}-01-31`, avisarDias: av.diasCesantias, enlace: '/prestaciones', baseLegal: 'Ley 52 de 1975' },
    ];
    return lista.map((o) => ({ ...o, diasRestantes: diferenciaDias(hoy, o.fecha) })).filter((o) => o.diasRestantes >= -30);
  }

  /** Resumen de nómina por concepto, centro de costo y empleado (HU-60). */
  async resumen(u: UsuarioSesion, q: { desde: string; hasta: string; centroCostoId?: string; sedeId?: string; empleadoId?: string }) {
    const filas = await this.db.many(
      `select ll.concepto, ll.nombre, ll.tipo, cc.nombre as centro_costo, s.nombre as sede, e.id as empleado_id, e.nombres, e.apellidos, e.numero_documento, p.nombre as periodo, sum(ll.valor) as valor
       from liquidacion_lineas ll join periodos p on p.id = ll.periodo_id join empleados e on e.id = ll.empleado_id
       left join centros_costo cc on cc.id = e.centro_costo_id left join sedes s on s.id = e.sede_id
       where ll.empresa_id = $1 and p.estado <> 'abierto' and p.hasta between $2 and $3
         and ($4::uuid is null or e.centro_costo_id = $4) and ($5::uuid is null or e.sede_id = $5) and ($6::uuid is null or e.id = $6)
       group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 order by p.nombre, e.apellidos, ll.tipo, ll.concepto`,
      [u.empresaId, q.desde, q.hasta, q.centroCostoId || null, q.sedeId || null, q.empleadoId || null],
    );
    const porConcepto = new Map<string, { concepto: string; nombre: string; tipo: string; total: string }>();
    const porCentro = new Map<string, { centroCosto: string; devengos: string; aportes: string; provisiones: string; costo: string }>();
    for (const f of filas) {
      const c = porConcepto.get(f.concepto) ?? { concepto: f.concepto, nombre: f.nombre, tipo: f.tipo, total: '0' };
      c.total = D(c.total).plus(D(f.valor)).toFixed();
      porConcepto.set(f.concepto, c);
      const k = f.centro_costo ?? 'Sin centro de costo';
      const cc = porCentro.get(k) ?? { centroCosto: k, devengos: '0', aportes: '0', provisiones: '0', costo: '0' };
      if (f.tipo === 'devengo') cc.devengos = D(cc.devengos).plus(D(f.valor)).toFixed();
      if (f.tipo === 'aporte_empleador') cc.aportes = D(cc.aportes).plus(D(f.valor)).toFixed();
      if (f.tipo === 'provision') cc.provisiones = D(cc.provisiones).plus(D(f.valor)).toFixed();
      if (f.tipo !== 'deduccion') cc.costo = D(cc.costo).plus(D(f.valor)).toFixed();
      porCentro.set(k, cc);
    }
    return { porConcepto: [...porConcepto.values()], porCentroCosto: [...porCentro.values()], detalle: camelLista(filas) };
  }

  async saldosVacaciones(u: UsuarioSesion) {
    const emps = await this.db.many(`select id, nombres, apellidos, numero_documento from empleados where empresa_id = $1 and estado = 'activo' order by apellidos`, [u.empresaId]);
    const out = [];
    for (const e of emps) out.push({ empleadoId: e.id, empleado: nombreCompleto(e), documento: e.numero_documento, ...(await this.novedades.saldoVacaciones(u, e.id)) });
    return out;
  }

  async asistencia(u: UsuarioSesion, q: { desde: string; hasta: string }) {
    const horas = await this.db.many(
      `select e.id as empleado_id, e.nombres, e.apellidos, a.nombre as area, h.tipo, sum(h.horas) as horas from horas_registradas h join empleados e on e.id = h.empleado_id
       left join areas a on a.id = e.area_id where h.empresa_id = $1 and h.estado = 'aprobada' and h.fecha between $2 and $3 group by 1, 2, 3, 4, 5 order by e.apellidos`,
      [u.empresaId, q.desde, q.hasta],
    );
    const alertas = await this.db.many(
      `select e.id as empleado_id, a.tipo, count(*)::int as veces from alertas_asistencia a join empleados e on e.id = a.empleado_id where a.empresa_id = $1 and a.fecha between $2 and $3 group by 1, 2`,
      [u.empresaId, q.desde, q.hasta],
    );
    const ausencias = await this.db.many(
      `select n.empleado_id, n.tipo, sum(least(n.hasta, $3::date) - greatest(n.desde, $2::date) + 1)::int as dias from novedades n
       where n.empresa_id = $1 and n.clase = 'dias' and n.estado = 'aprobada' and n.desde <= $3 and n.hasta >= $2 group by 1, 2`,
      [u.empresaId, q.desde, q.hasta],
    );
    const porEmpleado = new Map<string, any>();
    for (const h of horas) {
      const x = porEmpleado.get(h.empleado_id) ?? { empleadoId: h.empleado_id, empleado: nombreCompleto(h), area: h.area, horas: {}, alertas: {}, ausencias: {} };
      x.horas[h.tipo] = h.horas;
      porEmpleado.set(h.empleado_id, x);
    }
    const emps = new Map((await this.db.many('select id, nombres, apellidos from empleados where empresa_id = $1', [u.empresaId])).map((e) => [e.id, nombreCompleto(e)]));
    for (const a of alertas) {
      const x = porEmpleado.get(a.empleado_id) ?? { empleadoId: a.empleado_id, empleado: emps.get(a.empleado_id), horas: {}, alertas: {}, ausencias: {} };
      x.alertas[a.tipo] = a.veces;
      porEmpleado.set(a.empleado_id, x);
    }
    for (const a of ausencias) {
      const x = porEmpleado.get(a.empleado_id) ?? { empleadoId: a.empleado_id, empleado: emps.get(a.empleado_id), horas: {}, alertas: {}, ausencias: {} };
      x.ausencias[a.tipo] = a.dias;
      porEmpleado.set(a.empleado_id, x);
    }
    return [...porEmpleado.values()];
  }

  /** Certificado de ingresos y retenciones del año (formulario 220, HU-52). */
  async certificadoIngresos(u: UsuarioSesion, empleadoId: string, anio: number) {
    const e = await this.db.maybe('select * from empleados where id = $1 and empresa_id = $2', [empleadoId, u.empresaId]);
    if (!e) throw new ErrorNegocio('Empleado no encontrado', 404);
    const filas = await this.db.many(
      `select ll.concepto, ll.tipo, c.base_retencion, c.salarial, sum(ll.valor) as valor from liquidacion_lineas ll join periodos p on p.id = ll.periodo_id
       left join conceptos c on c.empresa_id = ll.empresa_id and c.codigo = ll.concepto
       where ll.empleado_id = $1 and p.estado in ('aprobado', 'cerrado') and extract(year from p.hasta) = $2 group by 1, 2, 3, 4`,
      [empleadoId, anio],
    );
    const iniciales = await this.db.many(`select tipo, sum(valor) as valor from saldos_iniciales where empleado_id = $1 and extract(year from fecha_corte) = $2 group by 1`, [empleadoId, anio]);
    const ini = (t: string) => D(iniciales.find((x) => x.tipo === t)?.valor ?? 0);
    const s = (pred: (f: any) => boolean) => sum(filas.filter(pred).map((f) => f.valor));
    const pagosSalariales = s((f) => f.tipo === 'devengo' && f.salarial).plus(ini('ingresos_retencion'));
    const prestaciones = s((f) => ['PRIMA_SERVICIOS', 'CESANTIAS', 'INTERESES_CESANTIAS', 'VACACIONES_COMPENSADAS', 'VACACIONES_DISFRUTADAS'].includes(f.concepto));
    const otros = s((f) => f.tipo === 'devengo' && !f.salarial && !['PRIMA_SERVICIOS', 'CESANTIAS', 'INTERESES_CESANTIAS', 'VACACIONES_COMPENSADAS'].includes(f.concepto));
    const salud = s((f) => f.concepto === 'SALUD_EMPLEADO');
    const pension = s((f) => f.concepto === 'PENSION_EMPLEADO' || f.concepto === 'FONDO_SOLIDARIDAD').plus(ini('aportes_obligatorios'));
    const voluntarios = s((f) => f.concepto === 'APORTE_VOLUNTARIO');
    const retencion = s((f) => f.concepto === 'RETENCION_FUENTE').plus(ini('retencion'));
    const cesantiasConsignadas = s((f) => f.concepto === 'CESANTIAS_CONSIGNAR');
    const r = {
      anio,
      empleado: nombreCompleto(e),
      documento: `${e.tipo_documento} ${e.numero_documento}`,
      pagosSalariales: pagosSalariales.toFixed(),
      prestacionesSociales: prestaciones.toFixed(),
      cesantiasConsignadas: cesantiasConsignadas.toFixed(),
      otrosPagos: otros.toFixed(),
      totalIngresos: pagosSalariales.plus(prestaciones).plus(otros).plus(cesantiasConsignadas).toFixed(),
      aportesSalud: salud.toFixed(),
      aportesPension: pension.toFixed(),
      aportesVoluntarios: voluntarios.toFixed(),
      retencionPracticada: retencion.toFixed(),
      nota: 'Resumen para diligenciar el formulario 220 de la DIAN. Verifique las casillas con el formulario vigente del año.',
    };
    await this.auditoria.registrar(u, 'generar', 'certificado_ingresos', empleadoId, null, { anio });
    return r;
  }

  async certificadoIngresosPdf(u: UsuarioSesion, empleadoId: string, anio: number) {
    const r = await this.certificadoIngresos(u, empleadoId, anio);
    const empresa = await this.db.one('select * from empresas where id = $1', [u.empresaId]);
    return crearPdf((doc) => {
      encabezado(doc, empresa, `CERTIFICADO DE INGRESOS Y RETENCIONES ${anio}`);
      doc.text(`Trabajador: ${r.empleado}    ${r.documento}`);
      doc.moveDown(0.5);
      tabla(
        doc,
        [
          { titulo: 'Concepto', ancho: 340 },
          { titulo: 'Valor', ancho: 170, derecha: true },
        ],
        [
          ['Pagos por salarios', pesos(r.pagosSalariales)],
          ['Prestaciones sociales', pesos(r.prestacionesSociales)],
          ['Cesantías consignadas', pesos(r.cesantiasConsignadas)],
          ['Otros pagos', pesos(r.otrosPagos)],
          ['Total de ingresos brutos', pesos(r.totalIngresos)],
          ['Aportes obligatorios a salud', pesos(r.aportesSalud)],
          ['Aportes obligatorios a pensión y FSP', pesos(r.aportesPension)],
          ['Aportes voluntarios', pesos(r.aportesVoluntarios)],
          ['Retención en la fuente', pesos(r.retencionPracticada)],
        ],
      );
      doc.fontSize(8).fillColor('#777777').text(r.nota);
    });
  }

  async exportarExcel(titulo: string, columnas: { clave: string; titulo: string }[], filas: Record<string, unknown>[]) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(titulo.slice(0, 30));
    ws.columns = columnas.map((c) => ({ header: c.titulo, key: c.clave, width: Math.max(12, c.titulo.length + 4) }));
    for (const f of filas) ws.addRow(Object.fromEntries(columnas.map((c) => [c.clave, valorCelda(f[c.clave])])));
    ws.getRow(1).font = { bold: true };
    return { nombre: `${titulo.toLowerCase().replace(/\s+/g, '-')}.xlsx`, archivoBase64: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64') };
  }

  async exportarPdf(titulo: string, columnas: { clave: string; titulo: string }[], filas: Record<string, unknown>[], empresaId: string) {
    const empresa = await this.db.one('select * from empresas where id = $1', [empresaId]);
    const ancho = 510 / columnas.length;
    const pdf = await crearPdf((doc) => {
      encabezado(doc, empresa, titulo);
      tabla(
        doc,
        columnas.map((c) => ({ titulo: c.titulo, ancho })),
        filas.map((f) => columnas.map((c) => String(f[c.clave] ?? ''))),
      );
    });
    return { nombre: `${titulo.toLowerCase().replace(/\s+/g, '-')}.pdf`, archivoBase64: pdf.toString('base64') };
  }
}

const valorCelda = (v: unknown) => (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v);

@Controller('reportes')
export class ReportesController {
  constructor(
    private readonly s: ReportesService,
    private readonly db: Db,
  ) {}

  @Get('panel')
  panel(@Usuario() u: UsuarioSesion, @Query() q: any) {
    return this.s.panel(u, q);
  }

  @Get('pendientes')
  pendientes(@Usuario() u: UsuarioSesion) {
    return this.s.pendientes(u);
  }

  @Get('calendario')
  calendario(@Usuario() u: UsuarioSesion) {
    return this.s.calendarioObligaciones(u);
  }

  @Get('resumen')
  resumen(@Usuario() u: UsuarioSesion, @Query() q: any) {
    return this.s.resumen(u, { desde: q.desde ?? `${fechaLocal().slice(0, 4)}-01-01`, hasta: q.hasta ?? fechaLocal(), ...q });
  }

  @Get('vacaciones')
  vacaciones(@Usuario() u: UsuarioSesion) {
    return this.s.saldosVacaciones(u);
  }

  @Get('asistencia')
  asistencia(@Usuario() u: UsuarioSesion, @Query() q: any) {
    return this.s.asistencia(u, { desde: q.desde ?? sumarDias(fechaLocal(), -30), hasta: q.hasta ?? fechaLocal() });
  }

  @Get('certificado-ingresos/:empleadoId')
  certificado(@Usuario() u: UsuarioSesion, @Param('empleadoId') id: string, @Query('anio') anio: string) {
    return this.s.certificadoIngresos(u, id, Number(anio ?? Number(fechaLocal().slice(0, 4)) - 1));
  }

  @Get('certificado-ingresos/:empleadoId/pdf')
  async certificadoPdf(@Usuario() u: UsuarioSesion, @Param('empleadoId') id: string, @Query('anio') anio: string) {
    const pdf = await this.s.certificadoIngresosPdf(u, id, Number(anio ?? Number(fechaLocal().slice(0, 4)) - 1));
    return { nombre: `certificado-ingresos-${anio}.pdf`, archivoBase64: pdf.toString('base64') };
  }

  /** Exporta cualquier tabla del frontend a Excel o PDF (HU-60). */
  @Post('exportar')
  exportar(
    @Usuario() u: UsuarioSesion,
    @Body(new Validar(z.object({ titulo: z.string().min(1), formato: z.enum(['excel', 'pdf']), columnas: z.array(z.object({ clave: z.string(), titulo: z.string() })).min(1), filas: z.array(z.record(z.any())) }))) d: any,
  ) {
    return d.formato === 'excel' ? this.s.exportarExcel(d.titulo, d.columnas, d.filas) : this.s.exportarPdf(d.titulo, d.columnas, d.filas, u.empresaId);
  }

  @Get('auditoria')
  async auditoria(@Usuario() u: UsuarioSesion, @Query() q: any) {
    return camelLista(
      await this.db.many(
        `select id, usuario_nombre, accion, entidad, entidad_id, antes, despues, motivo, ip, creado_en from auditoria
         where empresa_id = $1 and ($2::text is null or entidad = $2) and ($3::text is null or entidad_id = $3)
           and creado_en >= coalesce($4::date, '1900-01-01') and creado_en < coalesce($5::date + 1, '2999-01-01')
         order by creado_en desc limit $6`,
        [u.empresaId, q.entidad || null, q.entidadId || null, q.desde || null, q.hasta || null, Math.min(Number(q.limite ?? 200), 2000)],
      ),
    );
  }
}

// ---------- Notificaciones (avisos dentro del sistema) ----------

@Controller('notificaciones')
export class NotificacionesController {
  constructor(
    private readonly db: Db,
    private readonly reportes: ReportesService,
  ) {}

  /** Genera los avisos vigentes (una sola vez cada uno) y devuelve la lista. */
  @Get()
  async listar(@Usuario() u: UsuarioSesion) {
    const hoy = fechaLocal();
    for (const p of await this.reportes.pendientes(u))
      await this.db.exec(
        `insert into notificaciones (empresa_id, tipo, titulo, mensaje, enlace, clave) values ($1, $2, $3, $4, $5, $6) on conflict (empresa_id, clave) where clave is not null do nothing`,
        [u.empresaId, p.tipo, p.titulo, p.detalle, p.enlace, `${p.tipo}:${p.titulo}:${hoy.slice(0, 7)}`],
      );
    return camelLista(await this.db.many(`select * from notificaciones where empresa_id = $1 order by leida, creado_en desc limit 50`, [u.empresaId]));
  }

  @Post('leer')
  async leer(@Usuario() u: UsuarioSesion, @Body(new Validar(z.object({ ids: z.array(z.string().uuid()).optional() }))) d: { ids?: string[] }) {
    await this.db.exec(`update notificaciones set leida = true where empresa_id = $1 and ($2::uuid[] is null or id = any($2))`, [u.empresaId, d.ids ?? null]);
    return { ok: true };
  }
}
