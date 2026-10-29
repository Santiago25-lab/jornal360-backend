import { Body, Controller, Delete, Get, Injectable, Param, Patch, Post, Put, Res } from '@nestjs/common';
import { Response } from 'express';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { AuditoriaService } from '../../common/auditoria.service';
import { ErrorNegocio, Usuario, UsuarioSesion, Validar } from '../../common/comun';
import { crearPdf, encabezado, tabla } from '../../common/pdf';
import { camel, camelLista, pesos, zFecha } from '../../common/util';
import { Db } from '../../db/db.service';
import { D, sum } from '../../domain/decimal';
import {
  aFecha,
  camposDe,
  contextoLibre,
  EmpleadoLibre,
  liquidarLibre,
  listaParametros,
  NOMBRE_TIPO,
  Regimen,
  TipoLiquidacion,
  validarEmpleado,
} from '../../domain/liquidador';

const TIPOS = ['nomina', 'prima', 'cesantias', 'vacaciones', 'retiro'] as const;
const zValor = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const CabeceraDto = z.object({
  nombre: z.string().trim().min(1, 'Escriba un nombre para la liquidación'),
  clienteRazonSocial: z.string().trim().optional().nullable(),
  clienteNit: z.string().trim().optional().nullable(),
  tipo: z.enum(TIPOS),
  regimen: z.enum(['privado', 'publico']),
  desde: zFecha,
  hasta: zFecha,
  fechaPago: zFecha.optional().nullable(),
  exonerada: z.boolean().optional(),
  opciones: z.object({ clasePrima: z.enum(['servicios', 'navidad']).optional() }).optional(),
});
const EditarDto = CabeceraDto.omit({ tipo: true }).partial().extend({ parametros: z.record(z.string().regex(/^-?\d+(\.\d+)?$/, 'Valor numérico no válido')).optional() });

const COLUMNAS: Record<string, string> = {
  nombre: 'nombre',
  clienteRazonSocial: 'cliente_razon_social',
  clienteNit: 'cliente_nit',
  regimen: 'regimen',
  desde: 'desde',
  hasta: 'hasta',
  fechaPago: 'fecha_pago',
  exonerada: 'exonerada',
  opciones: 'opciones',
  parametros: 'parametros',
};

@Injectable()
export class LiquidadorService {
  constructor(
    private readonly db: Db,
    private readonly auditoria: AuditoriaService,
  ) {}

  async listar(u: UsuarioSesion) {
    return camelLista(
      await this.db.many(
        `select l.id, l.nombre, l.cliente_razon_social, l.cliente_nit, l.tipo, l.regimen, l.desde, l.hasta, l.estado, l.totales, l.creado_en, l.actualizado_en,
                (select count(*)::int from liquidaciones_libres_empleados x where x.liquidacion_id = l.id) as empleados
         from liquidaciones_libres l where l.empresa_id = $1 order by l.actualizado_en desc`,
        [u.empresaId],
      ),
    );
  }

  private async cabecera(u: UsuarioSesion, id: string) {
    const l = await this.db.maybe('select * from liquidaciones_libres where id = $1 and empresa_id = $2', [id, u.empresaId]);
    if (!l) throw new ErrorNegocio('Liquidación no encontrada', 404);
    return l;
  }

  async ver(u: UsuarioSesion, id: string) {
    const l = await this.cabecera(u, id);
    const empleados = await this.db.many('select id, orden, datos, resultado from liquidaciones_libres_empleados where liquidacion_id = $1 order by orden', [id]);
    return { ...camel<any>(l), empleados: empleados.map((e) => ({ id: e.id, datos: e.datos, resultado: e.resultado })), campos: camposDe(l.tipo) };
  }

  async crear(u: UsuarioSesion, d: z.infer<typeof CabeceraDto>) {
    if (d.hasta < d.desde) throw new ErrorNegocio('La fecha final es anterior a la inicial');
    const r = await this.db.one(
      `insert into liquidaciones_libres (empresa_id, nombre, cliente_razon_social, cliente_nit, tipo, regimen, desde, hasta, fecha_pago, exonerada, opciones, creado_por)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
      [u.empresaId, d.nombre, d.clienteRazonSocial || null, d.clienteNit || null, d.tipo, d.regimen, d.desde, d.hasta, d.fechaPago || null, d.regimen === 'publico' ? false : (d.exonerada ?? true), JSON.stringify(d.opciones ?? {}), u.id],
    );
    await this.auditoria.registrar(u, 'crear', 'liquidacion_libre', r.id, null, d);
    return this.ver(u, r.id);
  }

  async editar(u: UsuarioSesion, id: string, d: z.infer<typeof EditarDto>) {
    const antes = await this.cabecera(u, id);
    const campos = Object.entries(COLUMNAS).filter(([k]) => (d as any)[k] !== undefined);
    if (campos.length) {
      const valores = campos.map(([k]) => {
        const v = (d as any)[k];
        return k === 'opciones' || k === 'parametros' ? JSON.stringify(v) : v === '' ? null : v;
      });
      // Cualquier cambio en la cabecera o los valores deja la liquidación por recalcular.
      await this.db.exec(`update liquidaciones_libres set ${campos.map(([, c], i) => `${c} = $${i + 2}`).join(', ')}, estado = 'borrador', actualizado_en = now() where id = $1`, [id, ...valores]);
    }
    await this.auditoria.registrar(u, 'editar', 'liquidacion_libre', id, { parametros: antes.parametros }, d);
    return this.ver(u, id);
  }

  async borrar(u: UsuarioSesion, id: string) {
    const l = await this.cabecera(u, id);
    await this.db.exec('delete from liquidaciones_libres where id = $1', [id]);
    await this.auditoria.registrar(u, 'borrar', 'liquidacion_libre', id, { nombre: l.nombre }, null);
    return { ok: true };
  }

  /** Reemplaza la tabla de empleados tal como quedó en pantalla. */
  async guardarEmpleados(u: UsuarioSesion, id: string, filas: EmpleadoLibre[]) {
    await this.cabecera(u, id);
    await this.db.tx(async (c) => {
      await this.db.exec('delete from liquidaciones_libres_empleados where liquidacion_id = $1', [id], c);
      for (let i = 0; i < filas.length; i++) await this.db.exec('insert into liquidaciones_libres_empleados (liquidacion_id, orden, datos) values ($1, $2, $3)', [id, i, JSON.stringify(filas[i])], c);
      await this.db.exec(`update liquidaciones_libres set estado = 'borrador', actualizado_en = now() where id = $1`, [id], c);
    });
    return this.ver(u, id);
  }

  async parametros(u: UsuarioSesion, id: string) {
    const l = await this.cabecera(u, id);
    return listaParametros(l.regimen, l.parametros ?? {}, l.hasta);
  }

  async liquidar(u: UsuarioSesion, id: string) {
    const l = await this.cabecera(u, id);
    const empleados = await this.db.many('select id, datos from liquidaciones_libres_empleados where liquidacion_id = $1 order by orden', [id]);
    if (!empleados.length) throw new ErrorNegocio('Agregue al menos un empleado');
    const errores: string[] = [];
    empleados.forEach((e, i) => validarEmpleado(l.tipo, e.datos).forEach((m) => errores.push(`Fila ${i + 1} (${e.datos.nombre || 'sin nombre'}): ${m}`)));
    if (errores.length) throw new ErrorNegocio('Hay datos por corregir antes de liquidar', 400, { errores });
    const ctx = contextoLibre(l.regimen as Regimen, l.parametros ?? {}, l.exonerada);
    const opciones = { tipo: l.tipo as TipoLiquidacion, regimen: l.regimen as Regimen, desde: l.desde, hasta: l.hasta, clasePrima: l.opciones?.clasePrima };
    const resultados = empleados.map((e) => ({ id: e.id, r: liquidarLibre(opciones, e.datos, ctx, e.id) }));
    const t = (k: keyof (typeof resultados)[number]['r']['totales']) => sum(resultados.map((x) => x.r.totales[k])).toFixed();
    const totales = { empleados: resultados.length, devengos: t('devengos'), deducciones: t('deducciones'), neto: t('neto'), aportesEmpleador: t('aportesEmpleador'), provisiones: t('provisiones'), costoTotal: t('costoTotal') };
    await this.db.tx(async (c) => {
      for (const x of resultados) await this.db.exec('update liquidaciones_libres_empleados set resultado = $2 where id = $1', [x.id, JSON.stringify(x.r)], c);
      await this.db.exec(`update liquidaciones_libres set estado = 'liquidada', totales = $2, liquidado_en = now(), actualizado_en = now() where id = $1`, [id, JSON.stringify(totales)], c);
    });
    await this.auditoria.registrar(u, 'liquidar', 'liquidacion_libre', id, null, totales);
    return this.ver(u, id);
  }

  /** Copia la liquidación (empleados y valores) para otro periodo, por ejemplo el mes siguiente. */
  async copiar(u: UsuarioSesion, id: string, d: { nombre: string; desde: string; hasta: string; fechaPago?: string | null }) {
    const l = await this.cabecera(u, id);
    const nueva = await this.db.tx(async (c) => {
      const r = await this.db.one(
        `insert into liquidaciones_libres (empresa_id, nombre, cliente_razon_social, cliente_nit, tipo, regimen, desde, hasta, fecha_pago, exonerada, opciones, parametros, creado_por)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
        [u.empresaId, d.nombre, l.cliente_razon_social, l.cliente_nit, l.tipo, l.regimen, d.desde, d.hasta, d.fechaPago || null, l.exonerada, JSON.stringify(l.opciones ?? {}), JSON.stringify(l.parametros ?? {}), u.id],
        c,
      );
      await this.db.exec(
        'insert into liquidaciones_libres_empleados (liquidacion_id, orden, datos) select $2, orden, datos from liquidaciones_libres_empleados where liquidacion_id = $1',
        [id, r.id],
        c,
      );
      return r;
    });
    await this.auditoria.registrar(u, 'copiar', 'liquidacion_libre', nueva.id, { origen: id }, d);
    return this.ver(u, nueva.id);
  }

  // ---------- Excel ----------

  async plantilla(tipo: TipoLiquidacion) {
    const campos = camposDe(tipo);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Empleados');
    ws.columns = campos.map((c) => ({ header: c.clave, width: Math.max(14, c.clave.length + 4) }));
    ws.getRow(1).font = { bold: true };
    const ejemplo: Record<string, unknown> = { documento: '1085000001', nombre: 'Laura Rosero', cargo: 'Auxiliar', salario: 2000000, tipo_contrato: 'indefinido', fecha_ingreso: '2024-02-01', clase_riesgo: 1, auxilio: 'ley', fecha_retiro: '2026-12-31' };
    ws.addRow(campos.map((c) => ejemplo[c.clave] ?? ''));
    const ayuda = wb.addWorksheet('Qué va en cada columna');
    ayuda.columns = [
      { header: 'columna', width: 28 },
      { header: 'qué es', width: 44 },
      { header: 'obligatoria', width: 12 },
      { header: 'valores o ayuda', width: 60 },
    ];
    ayuda.getRow(1).font = { bold: true };
    for (const c of campos)
      ayuda.addRow([c.clave, c.titulo, c.obligatorio ? 'sí' : '', c.opciones ? c.opciones.map((o) => o.valor).join(', ') : c.tipo === 'si_no' ? 'sí o no' : c.tipo === 'fecha' ? 'AAAA-MM-DD' : (c.ayuda ?? '')]);
    return { nombre: `plantilla-${tipo}.xlsx`, archivoBase64: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64') };
  }

  /** Revisa (confirmar = false) o agrega (confirmar = true) las filas del Excel. Un documento repetido reemplaza su fila. */
  async importar(u: UsuarioSesion, id: string, d: { archivoBase64: string; confirmar: boolean }) {
    const l = await this.cabecera(u, id);
    const campos = camposDe(l.tipo);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(d.archivoBase64, 'base64') as any);
    const ws = wb.worksheets[0];
    if (!ws) throw new ErrorNegocio('El archivo no tiene hojas');
    const encabezados: string[] = [];
    ws.getRow(1).eachCell((cel, i) => (encabezados[i] = String(cel.value ?? '').trim().toLowerCase()));
    const conocidas = new Map(campos.map((c) => [c.clave.toLowerCase(), c.clave]));
    const errores: { fila: number; mensaje: string }[] = [];
    const validas: EmpleadoLibre[] = [];
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const fila: EmpleadoLibre = {};
      row.eachCell((cel, i) => {
        const clave = conocidas.get(encabezados[i]);
        if (!clave) return;
        const v = cel.value as any;
        fila[clave] = v instanceof Date ? v.toISOString().slice(0, 10) : v === null || v === undefined ? '' : typeof v === 'number' ? v : String(v?.result ?? v?.text ?? v).trim();
      });
      if (!Object.values(fila).some((v) => v !== '' && v !== null && v !== undefined)) return;
      for (const c of campos) if (c.tipo === 'fecha' && fila[c.clave]) fila[c.clave] = aFecha(fila[c.clave]) ?? fila[c.clave];
      const e = validarEmpleado(l.tipo, fila);
      if (e.length) errores.push({ fila: n, mensaje: e.join('; ') });
      else validas.push(fila);
    });
    if (!d.confirmar) return { validas: validas.length, errores };
    const actuales = (await this.db.many('select datos from liquidaciones_libres_empleados where liquidacion_id = $1 order by orden', [id])).map((x) => x.datos as EmpleadoLibre);
    const porDoc = new Map(validas.map((v) => [String(v.documento), v]));
    const todas = [...actuales.filter((a) => !porDoc.has(String(a.documento))), ...validas];
    await this.guardarEmpleados(u, id, todas);
    await this.auditoria.registrar(u, 'importar', 'liquidacion_libre', id, null, { importadas: validas.length });
    return { importadas: validas.length, errores };
  }

  async excel(u: UsuarioSesion, id: string) {
    const l = await this.ver(u, id);
    if (l.estado !== 'liquidada') throw new ErrorNegocio('Liquide primero para descargar el resultado');
    const wb = new ExcelJS.Workbook();
    const res = wb.addWorksheet('Resumen');
    res.columns = ['documento', 'empleado', 'cargo', 'devengos', 'deducciones', 'neto a pagar', 'aportes empleador', 'provisiones', 'costo total'].map((h) => ({ header: h, width: 18 }));
    const det = wb.addWorksheet('Detalle');
    det.columns = ['documento', 'empleado', 'concepto', 'código', 'tipo', 'cantidad', 'valor'].map((h) => ({ header: h, width: 20 }));
    const porConcepto = new Map<string, { nombre: string; tipo: string; total: any }>();
    for (const e of l.empleados) {
      const r = e.resultado;
      if (!r) continue;
      res.addRow([e.datos.documento, e.datos.nombre, e.datos.cargo ?? '', ...['devengos', 'deducciones', 'neto', 'aportesEmpleador', 'provisiones', 'costoTotal'].map((k) => Number(r.totales[k]))]);
      for (const x of r.lineas) {
        det.addRow([e.datos.documento, e.datos.nombre, x.nombre, x.concepto, x.tipo, x.cantidad ? Number(x.cantidad) : '', Number(x.valor)]);
        const c = porConcepto.get(x.concepto) ?? { nombre: x.nombre, tipo: x.tipo, total: D(0) };
        c.total = c.total.plus(D(x.valor));
        porConcepto.set(x.concepto, c);
      }
    }
    const tot = wb.addWorksheet('Totales por concepto');
    tot.columns = ['concepto', 'código', 'tipo', 'total'].map((h) => ({ header: h, width: 26 }));
    for (const [codigo, c] of porConcepto) tot.addRow([c.nombre, codigo, c.tipo, Number(c.total.toFixed())]);
    for (const ws of [res, det, tot]) ws.getRow(1).font = { bold: true };
    return { nombre: `${l.nombre.toLowerCase().replace(/\s+/g, '-')}.xlsx`, archivoBase64: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64') };
  }

  async pdf(u: UsuarioSesion, id: string, empleadoId: string): Promise<Buffer> {
    const l = await this.cabecera(u, id);
    const e = await this.db.maybe('select datos, resultado from liquidaciones_libres_empleados where id = $1 and liquidacion_id = $2', [empleadoId, id]);
    if (!e?.resultado) throw new ErrorNegocio('Liquide primero para descargar el desprendible', 404);
    const empresa = await this.db.one('select razon_social, nit, dv from empresas where id = $1', [u.empresaId]);
    const emisor = l.cliente_razon_social ? { razon_social: l.cliente_razon_social, nit: l.cliente_nit ?? '' } : empresa;
    const r = e.resultado;
    const titulo = l.tipo === 'nomina' ? 'COMPROBANTE DE PAGO DE NÓMINA' : l.tipo === 'retiro' ? 'LIQUIDACIÓN DEL CONTRATO DE TRABAJO' : `LIQUIDACIÓN DE ${NOMBRE_TIPO[l.tipo as TipoLiquidacion].toUpperCase()}`;
    const filas = (tipo: string) => r.lineas.filter((x: any) => x.tipo === tipo).map((x: any) => [x.nombre, x.cantidad ?? '', pesos(x.valor)]);
    return crearPdf((doc) => {
      encabezado(doc, emisor, titulo);
      doc.text(`Empleado: ${e.datos.nombre}    Documento: ${e.datos.documento}`);
      doc.text(`Cargo: ${e.datos.cargo ?? ''}    Periodo: ${l.desde} a ${l.hasta}${l.fecha_pago ? `    Pago: ${l.fecha_pago}` : ''}`);
      doc.moveDown(0.8);
      const cols = [
        { titulo: 'Concepto', ancho: 300 },
        { titulo: 'Cantidad', ancho: 80, derecha: true },
        { titulo: 'Valor', ancho: 130, derecha: true },
      ];
      doc.font('Helvetica-Bold').text('Devengos');
      tabla(doc, cols, filas('devengo'));
      if (filas('deduccion').length) {
        doc.font('Helvetica-Bold').text('Deducciones');
        tabla(doc, cols, filas('deduccion'));
      }
      doc.font('Helvetica-Bold').fontSize(12).text(`NETO A PAGAR: ${pesos(r.totales.neto)}`);
      doc.moveDown(3).font('Helvetica').fontSize(10).text('______________________________                ______________________________');
      doc.text('Firma del empleador                                              Firma del trabajador');
    });
  }
}

const EmpleadosDto = z.object({ empleados: z.array(z.record(zValor)).max(2000) });

@Controller('liquidador')
export class LiquidadorController {
  constructor(private readonly s: LiquidadorService) {}

  @Get()
  listar(@Usuario() u: UsuarioSesion) {
    return this.s.listar(u);
  }

  @Get('plantilla/:tipo')
  plantilla(@Param('tipo') tipo: string) {
    if (!(TIPOS as readonly string[]).includes(tipo)) throw new ErrorNegocio('Tipo de liquidación no válido');
    return this.s.plantilla(tipo as TipoLiquidacion);
  }

  @Post()
  crear(@Usuario() u: UsuarioSesion, @Body(new Validar(CabeceraDto)) d: z.infer<typeof CabeceraDto>) {
    return this.s.crear(u, d);
  }

  @Get(':id')
  ver(@Usuario() u: UsuarioSesion, @Param('id') id: string) {
    return this.s.ver(u, id);
  }

  @Patch(':id')
  editar(@Usuario() u: UsuarioSesion, @Param('id') id: string, @Body(new Validar(EditarDto)) d: z.infer<typeof EditarDto>) {
    return this.s.editar(u, id, d);
  }

  @Delete(':id')
  borrar(@Usuario() u: UsuarioSesion, @Param('id') id: string) {
    return this.s.borrar(u, id);
  }

  @Put(':id/empleados')
  empleados(@Usuario() u: UsuarioSesion, @Param('id') id: string, @Body(new Validar(EmpleadosDto)) d: { empleados: EmpleadoLibre[] }) {
    return this.s.guardarEmpleados(u, id, d.empleados);
  }

  @Get(':id/parametros')
  parametros(@Usuario() u: UsuarioSesion, @Param('id') id: string) {
    return this.s.parametros(u, id);
  }

  @Post(':id/liquidar')
  liquidar(@Usuario() u: UsuarioSesion, @Param('id') id: string) {
    return this.s.liquidar(u, id);
  }

  @Post(':id/copiar')
  copiar(@Usuario() u: UsuarioSesion, @Param('id') id: string, @Body(new Validar(z.object({ nombre: z.string().trim().min(1), desde: zFecha, hasta: zFecha, fechaPago: zFecha.optional().nullable() }))) d: any) {
    return this.s.copiar(u, id, d);
  }

  @Post(':id/importar')
  importar(@Usuario() u: UsuarioSesion, @Param('id') id: string, @Body(new Validar(z.object({ archivoBase64: z.string().min(10), confirmar: z.boolean().default(false) }))) d: any) {
    return this.s.importar(u, id, d);
  }

  @Get(':id/excel')
  excel(@Usuario() u: UsuarioSesion, @Param('id') id: string) {
    return this.s.excel(u, id);
  }

  @Get(':id/empleados/:empleadoId/pdf')
  async pdf(@Usuario() u: UsuarioSesion, @Param('id') id: string, @Param('empleadoId') empleadoId: string, @Res() res: Response) {
    const pdf = await this.s.pdf(u, id, empleadoId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="desprendible.pdf"');
    res.send(pdf);
  }
}
