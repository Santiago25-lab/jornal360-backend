import { Body, Controller, Delete, Get, Injectable, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuditoriaService } from '../../common/auditoria.service';
import { ErrorNegocio, Usuario, UsuarioSesion, Validar } from '../../common/comun';
import { camel, camelLista, fechaLocal, zFecha, zNumero } from '../../common/util';
import { Db } from '../../db/db.service';
import { FormatoArchivo, validarFormato } from '../../domain/archivos';
import { D, Decimal } from '../../domain/decimal';
import { festivosColombia } from '../../domain/festivos';
import { FUNCIONES_DISPONIBLES, normalizarId, ordenarPorDependencias, validarFormula } from '../../domain/formulas';
import { VARIABLES_SISTEMA, variablesConocidas } from '../../domain/nomina';
import { ParametrosEnMemoria } from '../../domain/parametros';
import { CONFIGURACION_INICIAL } from '../../seed/semilla';
import { configuracionCompleta, ContextoService, filaAConcepto } from './contexto.service';

// ---------- Utilidades ----------

/** Dígito de verificación del NIT (DIAN). */
export function digitoVerificacion(nit: string): string {
  const pesos = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  const d = nit.replace(/\D/g, '').split('').reverse();
  const s = d.reduce((a, n, i) => a + Number(n) * pesos[i], 0) % 11;
  return String(s > 1 ? 11 - s : s);
}

const zCalendario = z.object({
  diasLaborales: z.array(z.number().int().min(0).max(6)).min(1, 'Marque al menos un día laboral'),
  diaDescanso: z.number().int().min(0).max(6),
  sabadoHabilVacaciones: z.boolean(),
});

const ConfiguracionDto = z
  .object({
    calendario: zCalendario.partial(),
    horas: z
      .object({
        inicioNocturna: z.string().regex(/^\d{2}:\d{2}$/),
        finNocturna: z.string().regex(/^\d{2}:\d{2}$/),
        horasOrdinariasDiaSinTurno: z.number().min(0).max(24),
        toleranciaMinutos: z.number().int().min(0).max(120),
        minimoMinutosExtra: z.number().int().min(0).max(240),
      })
      .partial(),
    asistencia: z
      .object({
        activa: z.boolean(),
        qrSegundos: z.number().int().min(10).max(600),
        qrGracia: z.number().int().min(0).max(60),
        minutosDuplicado: z.number().int().min(0).max(120),
        permitirExcepcionKiosco: z.boolean(),
        intentosPin: z.number().int().min(1).max(10),
        nivelControl: z.enum(['basico', 'medio', 'alto']),
      })
      .partial(),
    aprobacion: z.object({ pasos: z.number().int().min(1).max(3), separarLiquidaAprueba: z.boolean(), umbralVariacion: z.number().min(0).max(10) }).partial(),
    avisos: z.object({ diasContratoPorVencer: z.number().int().min(1).max(365), diasPrima: z.number().int().min(1).max(60), diasCesantias: z.number().int().min(1).max(60), correo: z.boolean() }).partial(),
    seguridad: z.object({ intentosLogin: z.number().int().min(1).max(20), minutosBloqueo: z.number().int().min(1).max(1440), minutosSesion: z.number().int().min(5).max(1440) }).partial(),
    vacaciones: z.object({ diasPreaviso: z.number().int().min(0).max(90), maxPeriodosAcumulados: z.number().int().min(1).max(4) }).partial(),
    retiro: z.object({ diasPreavisoRenuncia: z.number().int().min(0).max(90), maxAniosFijo: z.number().int().min(1).max(10) }).partial(),
    campos: z.array(z.object({ codigo: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Use letras, números y guion bajo'), nombre: z.string().min(1), tipo: z.enum(['texto', 'numero', 'fecha']) })),
  })
  .partial();

const EmpresaDto = z
  .object({
    nit: z.string().trim().regex(/^\d{5,15}$/, 'El NIT debe tener solo números'),
    dv: z.string().trim().regex(/^\d$/).optional().nullable(),
    razonSocial: z.string().trim().min(1),
    tipoEmpleador: z.enum(['juridica', 'natural']),
    representanteLegal: z.string().optional().nullable(),
    actividadEconomica: z.string().optional().nullable(),
    exonerada: z.boolean(),
    direccion: z.string().optional().nullable(),
    ciudad: z.string().optional().nullable(),
    telefono: z.string().optional().nullable(),
    correo: z.string().email('Correo no válido').optional().nullable().or(z.literal('')),
    bancoPagador: z.string().optional().nullable(),
    cuentaPagadora: z.string().optional().nullable(),
    tipoCuentaPagadora: z.string().optional().nullable(),
    asistenteCompletado: z.boolean(),
    asistentePaso: z.number().int().min(0).max(20),
  })
  .partial();

const EMPRESA_COLS: Record<string, string> = {
  nit: 'nit',
  dv: 'dv',
  razonSocial: 'razon_social',
  tipoEmpleador: 'tipo_empleador',
  representanteLegal: 'representante_legal',
  actividadEconomica: 'actividad_economica',
  exonerada: 'exonerada',
  direccion: 'direccion',
  ciudad: 'ciudad',
  telefono: 'telefono',
  correo: 'correo',
  bancoPagador: 'banco_pagador',
  cuentaPagadora: 'cuenta_pagadora',
  tipoCuentaPagadora: 'tipo_cuenta_pagadora',
  asistenteCompletado: 'asistente_completado',
  asistentePaso: 'asistente_paso',
};

// ---------- Empresa ----------

@Injectable()
export class EmpresaService {
  constructor(
    private readonly db: Db,
    private readonly auditoria: AuditoriaService,
  ) {}

  async ver(u: UsuarioSesion) {
    const r = camel<any>(await this.db.one('select * from empresas where id = $1', [u.empresaId]));
    r.configuracion = configuracionCompleta(r.configuracion);
    r.dvCalculado = digitoVerificacion(r.nit);
    return r;
  }

  async editar(u: UsuarioSesion, d: z.infer<typeof EmpresaDto>) {
    const antes = await this.db.one('select * from empresas where id = $1', [u.empresaId]);
    if (d.nit && d.dv && digitoVerificacion(d.nit) !== d.dv)
      throw new ErrorNegocio(`El dígito de verificación no coincide con el NIT. Debería ser ${digitoVerificacion(d.nit)}`);
    if (d.nit && !d.dv) d.dv = digitoVerificacion(d.nit);
    const campos = Object.entries(EMPRESA_COLS).filter(([k]) => (d as any)[k] !== undefined);
    if (campos.length) {
      await this.db.exec(
        `update empresas set ${campos.map(([, c], i) => `${c} = $${i + 2}`).join(', ')}, actualizado_en = now() where id = $1`,
        [u.empresaId, ...campos.map(([k]) => ((d as any)[k] === '' ? null : (d as any)[k]))],
      );
    }
    const despues = await this.db.one('select * from empresas where id = $1', [u.empresaId]);
    await this.auditoria.registrar(u, 'editar', 'empresa', u.empresaId, antes, despues);
    return this.ver(u);
  }

  async editarConfiguracion(u: UsuarioSesion, d: z.infer<typeof ConfiguracionDto>) {
    const antes = configuracionCompleta((await this.db.one('select configuracion from empresas where id = $1', [u.empresaId])).configuracion);
    const nueva = configuracionCompleta(antes);
    for (const [k, v] of Object.entries(d)) (nueva as any)[k] = Array.isArray(v) ? v : { ...(nueva as any)[k], ...(v as object) };
    if (nueva.calendario.diasLaborales.includes(nueva.calendario.diaDescanso))
      throw new ErrorNegocio('El día de descanso obligatorio no puede estar marcado como día laboral');
    await this.db.exec('update empresas set configuracion = $2, actualizado_en = now() where id = $1', [u.empresaId, JSON.stringify(nueva)]);
    await this.auditoria.registrar(u, 'editar', 'configuracion', u.empresaId, antes, nueva);
    return nueva;
  }

  /** Plantillas de configuración por tipo de empresa (HU-64). */
  plantillas() {
    return PLANTILLAS.map(({ codigo, nombre, descripcion }) => ({ codigo, nombre, descripcion }));
  }

  async aplicarPlantilla(u: UsuarioSesion, codigo: string) {
    const p = PLANTILLAS.find((x) => x.codigo === codigo);
    if (!p) throw new ErrorNegocio('Plantilla no encontrada', 404);
    await this.editarConfiguracion(u, { calendario: p.calendario });
    for (const t of p.turnos)
      await this.db.exec(
        `insert into turnos (empresa_id, nombre, tipo, dias) select $1, $2, $3, $4 where not exists (select 1 from turnos where empresa_id = $1 and nombre = $2)`,
        [u.empresaId, t.nombre, t.tipo, JSON.stringify(t.dias)],
      );
    await this.auditoria.registrar(u, 'aplicar_plantilla', 'configuracion', u.empresaId, null, { plantilla: codigo });
    return { ok: true, plantilla: p.nombre };
  }
}

const franja = (inicio: string, fin: string) => [{ inicio, fin }];
const dias = (lista: number[], inicio: string, fin: string) => Object.fromEntries(lista.map((d) => [String(d), franja(inicio, fin)]));

const PLANTILLAS = [
  {
    codigo: 'comercio',
    nombre: 'Comercio',
    descripcion: 'Lunes a sábado, descanso el domingo, turno de 7 horas.',
    calendario: { diasLaborales: [1, 2, 3, 4, 5, 6], diaDescanso: 0, sabadoHabilVacaciones: true },
    turnos: [{ nombre: 'Comercio lunes a sábado (42 horas)', tipo: 'fijo', dias: dias([1, 2, 3, 4, 5, 6], '09:00', '16:00') }],
  },
  {
    codigo: 'oficina',
    nombre: 'Oficina',
    descripcion: 'Lunes a viernes, el sábado no cuenta para vacaciones.',
    calendario: { diasLaborales: [1, 2, 3, 4, 5], diaDescanso: 0, sabadoHabilVacaciones: false },
    turnos: [{ nombre: 'Oficina lunes a viernes (42 horas)', tipo: 'fijo', dias: dias([1, 2, 3, 4, 5], '07:00', '15:24') }],
  },
  {
    codigo: 'planta_24',
    nombre: 'Planta 24 horas',
    descripcion: 'Trabajo todos los días con tres turnos rotativos.',
    calendario: { diasLaborales: [1, 2, 3, 4, 5, 6], diaDescanso: 0, sabadoHabilVacaciones: true },
    turnos: [
      { nombre: 'Turno mañana (6:00 a 14:00)', tipo: 'rotativo', dias: dias([1, 2, 3, 4, 5], '06:00', '14:00') },
      { nombre: 'Turno tarde (14:00 a 22:00)', tipo: 'rotativo', dias: dias([1, 2, 3, 4, 5], '14:00', '22:00') },
      { nombre: 'Turno noche (22:00 a 6:00)', tipo: 'rotativo', dias: dias([1, 2, 3, 4, 5], '22:00', '06:00') },
    ],
  },
  {
    codigo: 'construccion',
    nombre: 'Construcción',
    descripcion: 'Lunes a sábado con jornada larga entre semana y media jornada el sábado.',
    calendario: { diasLaborales: [1, 2, 3, 4, 5, 6], diaDescanso: 0, sabadoHabilVacaciones: true },
    turnos: [{ nombre: 'Obra lunes a sábado (42 horas)', tipo: 'fijo', dias: { ...dias([1, 2, 3, 4, 5], '07:00', '14:48'), '6': franja('07:00', '10:00') } }],
  },
];

@Controller('empresa')
export class EmpresaController {
  constructor(private readonly s: EmpresaService) {}

  @Get()
  ver(@Usuario() u: UsuarioSesion) {
    return this.s.ver(u);
  }

  @Patch()
  editar(@Usuario() u: UsuarioSesion, @Body(new Validar(EmpresaDto)) d: z.infer<typeof EmpresaDto>) {
    return this.s.editar(u, d);
  }

  @Patch('configuracion')
  configuracion(@Usuario() u: UsuarioSesion, @Body(new Validar(ConfiguracionDto)) d: z.infer<typeof ConfiguracionDto>) {
    return this.s.editarConfiguracion(u, d);
  }

  @Get('configuracion/por-defecto')
  porDefecto() {
    return CONFIGURACION_INICIAL;
  }

  @Get('plantillas')
  plantillas() {
    return this.s.plantillas();
  }

  @Post('plantillas/:codigo')
  aplicar(@Usuario() u: UsuarioSesion, @Param('codigo') codigo: string) {
    return this.s.aplicarPlantilla(u, codigo);
  }

  @Get('nit/:nit/dv')
  dv(@Param('nit') nit: string) {
    return { nit, dv: digitoVerificacion(nit) };
  }
}

// ---------- Parámetros ----------

const VigenciaDto = z.object({ desde: zFecha, valor: zNumero, confirmar: z.boolean().optional() });
const ParametroDto = z.object({
  codigo: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Use letras, números y guion bajo'),
  nombre: z.string().trim().min(1),
  descripcion: z.string().optional().nullable(),
  categoria: z.string().min(1),
  tipo: z.enum(['dinero', 'porcentaje', 'numero', 'booleano', 'horas', 'dias']),
  desde: zFecha,
  valor: zNumero,
});

/** Valor legible para los mensajes: 0.005 en un porcentaje se muestra como 0,5 %. */
function mostrar(tipo: string, v: string | number): string {
  const n = D(v);
  const texto = (x: Decimal) => x.toFixed().replace('.', ',');
  if (tipo === 'porcentaje') return `${texto(n.mul(100))} %`;
  if (tipo === 'dinero') return `$ ${Number(n.toFixed(0)).toLocaleString('es-CO')}`;
  return texto(n);
}

/** Valor legal precargado vigente en una fecha (los de ley cambian por año o por la reforma). */
export function valorLegalEn(f: { valor_legal: string | null; vigencias_legales?: { desde: string; valor: string }[] | null }, fecha: string): string | null {
  const l = f.vigencias_legales;
  if (!l?.length) return f.valor_legal;
  const orden = [...l].sort((a, b) => a.desde.localeCompare(b.desde));
  return String(([...orden].reverse().find((v) => v.desde <= fecha) ?? orden[0]).valor);
}

@Injectable()
export class ParametrosService {
  constructor(
    private readonly db: Db,
    private readonly auditoria: AuditoriaService,
  ) {}

  async listar(u: UsuarioSesion, fecha = fechaLocal()) {
    const filas = await this.db.many(
      `select p.*, coalesce(json_agg(json_build_object('id', v.id, 'desde', v.desde, 'valor', v.valor) order by v.desde) filter (where v.id is not null), '[]') as vigencias
       from parametros p left join parametros_vigencias v on v.parametro_id = p.id
       where p.empresa_id = $1 group by p.id order by p.categoria, p.nombre`,
      [u.empresaId],
    );
    return filas.map((f) => {
      const vig = (f.vigencias as { desde: string; valor: string | number }[]).map((v) => ({ ...v, valor: String(v.valor) }));
      const actual = [...vig].reverse().find((v) => v.desde <= fecha) ?? vig[0];
      const valorActual = actual ? String(actual.valor) : null;
      const legal = valorLegalEn(f, fecha);
      return {
        ...camel<any>({ ...f, vigencias: undefined, vigencias_legales: undefined }),
        vigencias: vig,
        valorActual,
        valorLegal: legal,
        distintoDeLegal: legal !== null && valorActual !== null && !D(valorActual).eq(D(legal)),
      };
    });
  }

  private async parametro(u: UsuarioSesion, codigo: string) {
    const p = await this.db.maybe('select * from parametros where empresa_id = $1 and codigo = $2', [u.empresaId, normalizarId(codigo)]);
    if (!p) throw new ErrorNegocio('Parámetro no encontrado', 404);
    return p;
  }

  /** Periodos ya cerrados que usaron el parámetro desde esa fecha (HU-06). */
  private async periodosAfectados(u: UsuarioSesion, desde: string) {
    return camelLista(
      await this.db.many(`select id, nombre, desde, hasta from periodos where empresa_id = $1 and estado = 'cerrado' and hasta >= $2 order by desde`, [u.empresaId, desde]),
    );
  }

  async guardarVigencia(u: UsuarioSesion, codigo: string, d: z.infer<typeof VigenciaDto>) {
    const p = await this.parametro(u, codigo);
    const legal = valorLegalEn(p, d.desde);
    if (legal !== null && D(d.valor).lt(D(legal)) && !d.confirmar && p.tipo !== 'booleano')
      throw new ErrorNegocio(
        `El valor ${mostrar(p.tipo, d.valor)} es menor que el valor legal precargado (${mostrar(p.tipo, legal)}). Confirme si desea guardarlo de todas formas`,
        409,
        { requiereConfirmacion: true },
      );
    const antes = await this.db.maybe('select * from parametros_vigencias where parametro_id = $1 and desde = $2', [p.id, d.desde]);
    const r = await this.db.one(
      `insert into parametros_vigencias (parametro_id, desde, valor, creado_por) values ($1, $2, $3, $4)
       on conflict (parametro_id, desde) do update set valor = excluded.valor, creado_por = excluded.creado_por, creado_en = now() returning *`,
      [p.id, d.desde, d.valor, u.id],
    );
    await this.auditoria.registrar(u, antes ? 'editar' : 'crear', 'parametro', p.codigo, antes, r, {
      motivo: legal !== null && D(d.valor).lt(D(legal)) ? 'Valor menor al legal, confirmado por el usuario' : undefined,
    });
    return { vigencia: camel(r), periodosAfectados: await this.periodosAfectados(u, d.desde) };
  }

  async borrarVigencia(u: UsuarioSesion, codigo: string, id: string) {
    const p = await this.parametro(u, codigo);
    const n = await this.db.one<{ n: string }>('select count(*)::text as n from parametros_vigencias where parametro_id = $1', [p.id]);
    if (n.n === '1') throw new ErrorNegocio('El parámetro debe tener al menos un valor');
    const antes = await this.db.maybe('delete from parametros_vigencias where id = $1 and parametro_id = $2 returning *', [id, p.id]);
    if (!antes) throw new ErrorNegocio('Vigencia no encontrada', 404);
    await this.auditoria.registrar(u, 'borrar', 'parametro', p.codigo, antes, null);
    return { ok: true };
  }

  async restaurarLegal(u: UsuarioSesion, codigo: string, desde: string) {
    const p = await this.parametro(u, codigo);
    const legal = valorLegalEn(p, desde);
    if (legal === null) throw new ErrorNegocio('Este parámetro no tiene valor legal precargado');
    return this.guardarVigencia(u, codigo, { desde, valor: legal, confirmar: true });
  }

  async crear(u: UsuarioSesion, d: z.infer<typeof ParametroDto>) {
    const codigo = normalizarId(d.codigo);
    if (VARIABLES_SISTEMA.some((v) => v.codigo === codigo)) throw new ErrorNegocio(`${codigo} es una variable del sistema; use otro código`);
    const r = await this.db.tx(async (c) => {
      const p = await this.db.one(
        'insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo) values ($1, $2, $3, $4, $5, $6) returning *',
        [u.empresaId, codigo, d.nombre, d.descripcion ?? null, d.categoria, d.tipo],
        c,
      );
      await this.db.exec('insert into parametros_vigencias (parametro_id, desde, valor, creado_por) values ($1, $2, $3, $4)', [p.id, d.desde, d.valor, u.id], c);
      return p;
    });
    await this.auditoria.registrar(u, 'crear', 'parametro', codigo, null, d);
    return camel(r);
  }

  async borrar(u: UsuarioSesion, codigo: string) {
    const p = await this.parametro(u, codigo);
    if (p.valor_legal !== null) throw new ErrorNegocio('Los parámetros legales no se borran; cambie su valor o restáurelo');
    await this.db.exec('delete from parametros where id = $1', [p.id]);
    await this.auditoria.registrar(u, 'borrar', 'parametro', p.codigo, p, null);
    return { ok: true };
  }
}

@Controller('parametros')
export class ParametrosController {
  constructor(private readonly s: ParametrosService) {}

  @Get()
  listar(@Usuario() u: UsuarioSesion, @Query('fecha') fecha?: string) {
    return this.s.listar(u, fecha);
  }

  @Post()
  crear(@Usuario() u: UsuarioSesion, @Body(new Validar(ParametroDto)) d: z.infer<typeof ParametroDto>) {
    return this.s.crear(u, d);
  }

  @Delete(':codigo')
  borrar(@Usuario() u: UsuarioSesion, @Param('codigo') codigo: string) {
    return this.s.borrar(u, codigo);
  }

  @Post(':codigo/vigencias')
  vigencia(@Usuario() u: UsuarioSesion, @Param('codigo') codigo: string, @Body(new Validar(VigenciaDto)) d: z.infer<typeof VigenciaDto>) {
    return this.s.guardarVigencia(u, codigo, d);
  }

  @Delete(':codigo/vigencias/:id')
  borrarVigencia(@Usuario() u: UsuarioSesion, @Param('codigo') codigo: string, @Param('id') id: string) {
    return this.s.borrarVigencia(u, codigo, id);
  }

  @Post(':codigo/restaurar')
  restaurar(@Usuario() u: UsuarioSesion, @Param('codigo') codigo: string, @Body(new Validar(z.object({ desde: zFecha }))) d: { desde: string }) {
    return this.s.restaurarLegal(u, codigo, d.desde);
  }
}

// ---------- Tablas ----------

const FilaDto = z.object({ desde: zNumero, hasta: zNumero.nullable(), valores: z.record(zNumero) });
const TablaDto = z.object({ nombre: z.string().min(1).optional(), descripcion: z.string().optional(), filas: z.array(FilaDto).min(1) });

@Controller('tablas')
export class TablasController {
  constructor(
    private readonly db: Db,
    private readonly auditoria: AuditoriaService,
  ) {}

  @Get()
  async listar(@Usuario() u: UsuarioSesion) {
    return camelLista(await this.db.many('select * from tablas_parametro where empresa_id = $1 order by nombre', [u.empresaId]));
  }

  @Put(':codigo')
  async guardar(@Usuario() u: UsuarioSesion, @Param('codigo') codigo: string, @Body(new Validar(TablaDto)) d: z.infer<typeof TablaDto>) {
    const t = await this.db.maybe('select * from tablas_parametro where empresa_id = $1 and codigo = $2', [u.empresaId, normalizarId(codigo)]);
    if (!t) throw new ErrorNegocio('Tabla no encontrada', 404);
    const filas = [...d.filas].sort((a, b) => Number(a.desde) - Number(b.desde));
    for (let i = 0; i < filas.length; i++) {
      const f = filas[i];
      if (f.hasta !== null && Number(f.hasta) <= Number(f.desde)) throw new ErrorNegocio(`Fila ${i + 1}: "hasta" debe ser mayor que "desde"`);
      if (i > 0 && filas[i - 1].hasta !== null && Number(filas[i - 1].hasta) > Number(f.desde)) throw new ErrorNegocio(`Las filas ${i} y ${i + 1} se cruzan`);
      for (const col of t.columnas) if (f.valores[col] === undefined) throw new ErrorNegocio(`Fila ${i + 1}: falta la columna ${col}`);
    }
    const r = await this.db.one('update tablas_parametro set filas = $2, nombre = coalesce($3, nombre), descripcion = coalesce($4, descripcion) where id = $1 returning *', [
      t.id,
      JSON.stringify(filas),
      d.nombre ?? null,
      d.descripcion ?? null,
    ]);
    await this.auditoria.registrar(u, 'editar', 'tabla', t.codigo, t, r);
    return camel(r);
  }

  @Post(':codigo/restaurar')
  async restaurar(@Usuario() u: UsuarioSesion, @Param('codigo') codigo: string) {
    const t = await this.db.maybe('select * from tablas_parametro where empresa_id = $1 and codigo = $2', [u.empresaId, normalizarId(codigo)]);
    if (!t?.filas_legales) throw new ErrorNegocio('Esta tabla no tiene valores legales precargados');
    const r = await this.db.one('update tablas_parametro set filas = filas_legales where id = $1 returning *', [t.id]);
    await this.auditoria.registrar(u, 'restaurar', 'tabla', t.codigo, t, r);
    return camel(r);
  }
}

// ---------- Festivos ----------

@Controller('festivos')
export class FestivosController {
  constructor(
    private readonly db: Db,
    private readonly auditoria: AuditoriaService,
  ) {}

  @Get()
  async listar(@Usuario() u: UsuarioSesion, @Query('anio') anio?: string) {
    const a = Number(anio ?? fechaLocal().slice(0, 4));
    return camelLista(
      await this.db.many(`select id, to_char(fecha, 'YYYY-MM-DD') as fecha, nombre from festivos where empresa_id = $1 and extract(year from fecha) = $2 order by fecha`, [u.empresaId, a]),
    );
  }

  @Post('generar/:anio')
  async generar(@Usuario() u: UsuarioSesion, @Param('anio') anio: string) {
    const a = Number(anio);
    if (!Number.isInteger(a) || a < 1990 || a > 2100) throw new ErrorNegocio('Año no válido');
    let n = 0;
    for (const f of festivosColombia(a))
      n += await this.db.exec('insert into festivos (empresa_id, fecha, nombre) values ($1, $2, $3) on conflict (empresa_id, fecha) do nothing', [u.empresaId, f.fecha, f.nombre]);
    await this.auditoria.registrar(u, 'generar', 'festivos', String(a), null, { agregados: n });
    return { agregados: n, festivos: await this.listar(u, String(a)) };
  }

  @Post()
  async crear(@Usuario() u: UsuarioSesion, @Body(new Validar(z.object({ fecha: zFecha, nombre: z.string().min(1) }))) d: { fecha: string; nombre: string }) {
    const r = await this.db.one(
      'insert into festivos (empresa_id, fecha, nombre) values ($1, $2, $3) on conflict (empresa_id, fecha) do update set nombre = excluded.nombre returning *',
      [u.empresaId, d.fecha, d.nombre],
    );
    await this.auditoria.registrar(u, 'crear', 'festivo', r.id, null, r);
    return camel(r);
  }

  @Patch(':id')
  async mover(@Usuario() u: UsuarioSesion, @Param('id') id: string, @Body(new Validar(z.object({ fecha: zFecha.optional(), nombre: z.string().min(1).optional() }))) d: { fecha?: string; nombre?: string }) {
    const antes = await this.db.maybe('select * from festivos where id = $1 and empresa_id = $2', [id, u.empresaId]);
    if (!antes) throw new ErrorNegocio('Festivo no encontrado', 404);
    const r = await this.db.one('update festivos set fecha = coalesce($2, fecha), nombre = coalesce($3, nombre) where id = $1 returning *', [id, d.fecha ?? null, d.nombre ?? null]);
    await this.auditoria.registrar(u, 'editar', 'festivo', id, antes, r);
    return camel(r);
  }

  @Delete(':id')
  async borrar(@Usuario() u: UsuarioSesion, @Param('id') id: string) {
    const antes = await this.db.maybe('delete from festivos where id = $1 and empresa_id = $2 returning *', [id, u.empresaId]);
    if (!antes) throw new ErrorNegocio('Festivo no encontrado', 404);
    await this.auditoria.registrar(u, 'borrar', 'festivo', id, antes, null);
    return { ok: true };
  }
}

// ---------- Conceptos ----------

const zBool = z.boolean();
const ConceptoDto = z.object({
  codigo: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Use letras, números y guion bajo, sin espacios'),
  nombre: z.string().trim().min(1, 'Escriba el nombre'),
  descripcion: z.string().optional().nullable(),
  tipo: z.enum(['devengo', 'deduccion', 'aporte_empleador', 'provision']),
  categoria: z.enum(['ley', 'retencion', 'embargo', 'libranza', 'otra']).optional().nullable(),
  formula: z.string().trim().min(1, 'Escriba la fórmula'),
  salarial: zBool.optional(),
  baseIbc: zBool.optional(),
  baseArl: zBool.optional(),
  baseParafiscales: zBool.optional(),
  basePrestaciones: zBool.optional(),
  baseVacaciones: zBool.optional(),
  baseRetencion: zBool.optional(),
  cuenta40: zBool.optional(),
  porHoras: zBool.optional(),
  requiereNovedad: zBool.optional(),
  orden: z.number().int().min(0).max(9999).optional(),
  redondeo: z.enum(['ninguno', 'peso', 'peso_arriba', 'centena', 'centena_arriba', 'mil']).optional(),
  baseLegal: z.string().optional().nullable(),
  cuentaDebito: z.string().optional().nullable(),
  cuentaCredito: z.string().optional().nullable(),
  terceroCredito: z.enum(['empleado', 'eps', 'afp', 'arl', 'ccf', 'icbf', 'sena', 'dian', 'cesantias', 'otra']).optional().nullable(),
  aplicaA: z.enum(['todos', 'asignados']).optional(),
  estado: z.enum(['activo', 'borrador', 'inactivo']).optional(),
});
const ConceptoEditarDto = ConceptoDto.omit({ codigo: true }).partial();
const AsignacionDto = z.object({
  tipoObjetivo: z.enum(['empleado', 'cargo', 'centro_costo', 'area', 'sede', 'grupo']),
  objetivo: z.string().min(1),
  desde: zFecha,
  hasta: zFecha.optional().nullable(),
  valor: zNumero.optional().nullable(),
});

const CONCEPTO_COLS: Record<string, string> = {
  nombre: 'nombre',
  descripcion: 'descripcion',
  tipo: 'tipo',
  categoria: 'categoria',
  formula: 'formula',
  salarial: 'salarial',
  baseIbc: 'base_ibc',
  baseArl: 'base_arl',
  baseParafiscales: 'base_parafiscales',
  basePrestaciones: 'base_prestaciones',
  baseVacaciones: 'base_vacaciones',
  baseRetencion: 'base_retencion',
  cuenta40: 'cuenta40',
  porHoras: 'por_horas',
  requiereNovedad: 'requiere_novedad',
  orden: 'orden',
  redondeo: 'redondeo',
  baseLegal: 'base_legal',
  cuentaDebito: 'cuenta_debito',
  cuentaCredito: 'cuenta_credito',
  terceroCredito: 'tercero_credito',
  aplicaA: 'aplica_a',
  estado: 'estado',
};

/** Plantillas de fórmula para quien no quiere escribirlas (HU-63). */
export const PLANTILLAS_FORMULA = [
  { codigo: 'valor_novedad', nombre: 'Valor que registro en cada periodo', formula: 'VALOR_NOVEDAD', requiereNovedad: true },
  { codigo: 'valor_fijo', nombre: 'Valor fijo mensual', formula: '100000 / DIAS_MES * DIAS_SALARIO', ayuda: 'Cambie 100000 por el valor mensual; se paga en proporción a los días' },
  { codigo: 'porcentaje_salario', nombre: 'Porcentaje del salario', formula: 'SALARIO * 0,10 / DIAS_MES * DIAS_SALARIO', ayuda: 'Cambie 0,10 por el porcentaje (0,10 = 10%)' },
  { codigo: 'valor_por_hora', nombre: 'Valor por hora registrada', formula: 'CANTIDAD_NOVEDAD * VALOR_HORA', requiereNovedad: true },
  { codigo: 'antiguedad', nombre: 'Bono por antigüedad', formula: 'SI(ANTIGUEDAD_ANOS >= 5; SALARIO * 0,10; 0)' },
];

@Injectable()
export class ConceptosService {
  constructor(
    private readonly db: Db,
    private readonly auditoria: AuditoriaService,
    private readonly contexto: ContextoService,
  ) {}

  async listar(u: UsuarioSesion) {
    const filas = await this.db.many('select * from conceptos where empresa_id = $1 order by orden, nombre', [u.empresaId]);
    return filas.map((f) => ({ ...filaAConcepto(f), distintoDeLegal: esDistintoDeLegal(f) }));
  }

  async ver(u: UsuarioSesion, codigo: string) {
    const f = await this.db.maybe('select * from conceptos where empresa_id = $1 and codigo = $2', [u.empresaId, normalizarId(codigo)]);
    if (!f) throw new ErrorNegocio('Concepto no encontrado', 404);
    const versiones = camelLista(await this.db.many('select * from conceptos_versiones where concepto_id = $1 order by version desc', [f.id]));
    const asignaciones = camelLista(await this.db.many('select * from conceptos_asignaciones where concepto_id = $1 order by desde', [f.id]));
    return { ...filaAConcepto(f), definicionLegal: f.definicion_legal, distintoDeLegal: esDistintoDeLegal(f), versiones, asignaciones };
  }

  /** Variables y funciones disponibles para escribir fórmulas. */
  async variables(u: UsuarioSesion) {
    const ctx = await this.contexto.cargar(u.empresaId);
    const campos = ctx.configuracion.campos.filter((c) => c.tipo === 'numero').map((c) => ({ codigo: normalizarId(c.codigo), descripcion: `Campo del empleado: ${c.nombre}` }));
    const params = await this.db.many('select codigo, nombre from parametros where empresa_id = $1 order by codigo', [u.empresaId]);
    const conceptos = await this.db.many('select codigo, nombre from conceptos where empresa_id = $1 order by orden', [u.empresaId]);
    return {
      sistema: VARIABLES_SISTEMA,
      parametros: params.map((p) => ({ codigo: p.codigo, descripcion: p.nombre })),
      conceptos: conceptos.map((c) => ({ codigo: c.codigo, descripcion: c.nombre })),
      campos,
      tablas: ctx.tablas.codigos(),
      funciones: FUNCIONES_DISPONIBLES,
      plantillas: PLANTILLAS_FORMULA,
    };
  }

  /** Valida sintaxis, variables, tablas y referencias circulares con todo el catálogo. */
  async validar(u: UsuarioSesion, codigo: string, formula: string): Promise<string[]> {
    const ctx = await this.contexto.cargar(u.empresaId, { incluirBorradores: [normalizarId(codigo)] });
    const campos = ctx.configuracion.campos.map((c) => c.codigo);
    const conocidas = variablesConocidas(ctx, [...campos, codigo]);
    const errores = validarFormula(formula, conocidas, new Set(ctx.tablas.codigos()));
    if (errores.length) return errores;
    const todos = ctx.conceptos.filter((c) => c.codigo !== normalizarId(codigo)).map((c) => ({ codigo: c.codigo, formula: c.formula }));
    todos.push({ codigo: normalizarId(codigo), formula });
    try {
      ordenarPorDependencias(todos);
    } catch (e) {
      return [(e as Error).message];
    }
    return [];
  }

  async crear(u: UsuarioSesion, d: z.infer<typeof ConceptoDto>) {
    const codigo = normalizarId(d.codigo);
    if (VARIABLES_SISTEMA.some((v) => v.codigo === codigo) || (await this.db.maybe('select 1 from parametros where empresa_id = $1 and codigo = $2', [u.empresaId, codigo])))
      throw new ErrorNegocio(`El código ${codigo} ya lo usa una variable o parámetro; elija otro`);
    const errores = await this.validar(u, codigo, d.formula);
    if (errores.length) throw new ErrorNegocio('La fórmula tiene errores', 400, { errores });
    const campos = Object.entries(CONCEPTO_COLS).filter(([k]) => (d as any)[k] !== undefined);
    const r = await this.db.one(
      `insert into conceptos (empresa_id, codigo${campos.map(([, c]) => ', ' + c).join('')}) values ($1, $2${campos.map((_, i) => `, $${i + 3}`).join('')}) returning *`,
      [u.empresaId, codigo, ...campos.map(([k]) => (d as any)[k])],
    );
    await this.db.exec('insert into conceptos_versiones (concepto_id, version, datos, creado_por, creado_por_nombre) values ($1, 1, $2, $3, $4)', [r.id, JSON.stringify(filaAConcepto(r)), u.id, u.nombre]);
    await this.auditoria.registrar(u, 'crear', 'concepto', codigo, null, r);
    return filaAConcepto(r);
  }

  async editar(u: UsuarioSesion, codigo: string, d: z.infer<typeof ConceptoEditarDto>) {
    const antes = await this.db.maybe('select * from conceptos where empresa_id = $1 and codigo = $2', [u.empresaId, normalizarId(codigo)]);
    if (!antes) throw new ErrorNegocio('Concepto no encontrado', 404);
    if (d.formula !== undefined) {
      const errores = await this.validar(u, antes.codigo, d.formula);
      if (errores.length) throw new ErrorNegocio('La fórmula tiene errores', 400, { errores });
    }
    const campos = Object.entries(CONCEPTO_COLS).filter(([k]) => (d as any)[k] !== undefined);
    if (!campos.length) return filaAConcepto(antes);
    const r = await this.db.tx(async (c) => {
      const nuevo = await this.db.one(
        `update conceptos set ${campos.map(([, col], i) => `${col} = $${i + 2}`).join(', ')}, version = version + 1, actualizado_en = now() where id = $1 returning *`,
        [antes.id, ...campos.map(([k]) => (d as any)[k])],
        c,
      );
      await this.db.exec(
        'insert into conceptos_versiones (concepto_id, version, datos, creado_por, creado_por_nombre) values ($1, $2, $3, $4, $5)',
        [nuevo.id, nuevo.version, JSON.stringify(filaAConcepto(nuevo)), u.id, u.nombre],
        c,
      );
      return nuevo;
    });
    await this.auditoria.registrar(u, 'editar', 'concepto', antes.codigo, antes, r);
    return filaAConcepto(r);
  }

  async restaurar(u: UsuarioSesion, codigo: string) {
    const c = await this.db.maybe('select * from conceptos where empresa_id = $1 and codigo = $2', [u.empresaId, normalizarId(codigo)]);
    if (!c?.definicion_legal) throw new ErrorNegocio('Este concepto no tiene definición legal precargada');
    const l = c.definicion_legal;
    return this.editar(u, codigo, {
      formula: l.formula,
      salarial: l.salarial,
      baseIbc: l.baseIbc,
      baseArl: l.baseArl,
      baseParafiscales: l.baseParafiscales,
      basePrestaciones: l.basePrestaciones,
      baseVacaciones: l.baseVacaciones,
      baseRetencion: l.baseRetencion,
      cuenta40: l.cuenta40,
      estado: 'activo',
    });
  }

  async borrar(u: UsuarioSesion, codigo: string) {
    const c = await this.db.maybe('select * from conceptos where empresa_id = $1 and codigo = $2', [u.empresaId, normalizarId(codigo)]);
    if (!c) throw new ErrorNegocio('Concepto no encontrado', 404);
    const usado = await this.db.maybe('select 1 from liquidacion_lineas where empresa_id = $1 and concepto = $2 limit 1', [u.empresaId, c.codigo]);
    if (c.es_legal || usado) {
      await this.editar(u, codigo, { estado: 'inactivo' });
      return { ok: true, borrado: false, mensaje: 'El concepto es legal o ya se usó en nóminas: se inactivó en lugar de borrarse' };
    }
    await this.db.exec('delete from conceptos where id = $1', [c.id]);
    await this.auditoria.registrar(u, 'borrar', 'concepto', c.codigo, c, null);
    return { ok: true, borrado: true };
  }

  async asignar(u: UsuarioSesion, codigo: string, d: z.infer<typeof AsignacionDto>) {
    const c = await this.db.maybe('select id from conceptos where empresa_id = $1 and codigo = $2', [u.empresaId, normalizarId(codigo)]);
    if (!c) throw new ErrorNegocio('Concepto no encontrado', 404);
    const r = await this.db.one(
      'insert into conceptos_asignaciones (empresa_id, concepto_id, tipo_objetivo, objetivo, desde, hasta, valor) values ($1, $2, $3, $4, $5, $6, $7) returning *',
      [u.empresaId, c.id, d.tipoObjetivo, d.objetivo, d.desde, d.hasta ?? null, d.valor ?? null],
    );
    await this.db.exec(`update conceptos set aplica_a = 'asignados' where id = $1`, [c.id]);
    await this.auditoria.registrar(u, 'asignar', 'concepto', normalizarId(codigo), null, r);
    return camel(r);
  }

  async quitarAsignacion(u: UsuarioSesion, id: string) {
    const r = await this.db.maybe('delete from conceptos_asignaciones where id = $1 and empresa_id = $2 returning *', [id, u.empresaId]);
    if (!r) throw new ErrorNegocio('Asignación no encontrada', 404);
    await this.auditoria.registrar(u, 'quitar_asignacion', 'concepto', r.concepto_id, r, null);
    return { ok: true };
  }
}

function esDistintoDeLegal(f: any): boolean {
  const l = f.definicion_legal;
  if (!l) return false;
  return (
    l.formula !== f.formula ||
    l.salarial !== f.salarial ||
    l.baseIbc !== f.base_ibc ||
    l.baseArl !== f.base_arl ||
    l.baseParafiscales !== f.base_parafiscales ||
    l.basePrestaciones !== f.base_prestaciones ||
    l.baseVacaciones !== f.base_vacaciones ||
    l.baseRetencion !== f.base_retencion ||
    l.cuenta40 !== f.cuenta40 ||
    f.estado !== 'activo'
  );
}

@Controller('conceptos')
export class ConceptosController {
  constructor(private readonly s: ConceptosService) {}

  @Get()
  listar(@Usuario() u: UsuarioSesion) {
    return this.s.listar(u);
  }

  @Get('variables')
  variables(@Usuario() u: UsuarioSesion) {
    return this.s.variables(u);
  }

  @Post('validar')
  async validar(@Usuario() u: UsuarioSesion, @Body(new Validar(z.object({ codigo: z.string().default('NUEVO'), formula: z.string() }))) d: { codigo: string; formula: string }) {
    const errores = await this.s.validar(u, d.codigo, d.formula);
    return { valida: errores.length === 0, errores };
  }

  @Get(':codigo')
  ver(@Usuario() u: UsuarioSesion, @Param('codigo') codigo: string) {
    return this.s.ver(u, codigo);
  }

  @Post()
  crear(@Usuario() u: UsuarioSesion, @Body(new Validar(ConceptoDto)) d: z.infer<typeof ConceptoDto>) {
    return this.s.crear(u, d);
  }

  @Patch(':codigo')
  editar(@Usuario() u: UsuarioSesion, @Param('codigo') codigo: string, @Body(new Validar(ConceptoEditarDto)) d: z.infer<typeof ConceptoEditarDto>) {
    return this.s.editar(u, codigo, d);
  }

  @Post(':codigo/restaurar')
  restaurar(@Usuario() u: UsuarioSesion, @Param('codigo') codigo: string) {
    return this.s.restaurar(u, codigo);
  }

  @Delete(':codigo')
  borrar(@Usuario() u: UsuarioSesion, @Param('codigo') codigo: string) {
    return this.s.borrar(u, codigo);
  }

  @Post(':codigo/asignaciones')
  asignar(@Usuario() u: UsuarioSesion, @Param('codigo') codigo: string, @Body(new Validar(AsignacionDto)) d: z.infer<typeof AsignacionDto>) {
    return this.s.asignar(u, codigo, d);
  }

  @Delete('asignaciones/:id')
  quitar(@Usuario() u: UsuarioSesion, @Param('id') id: string) {
    return this.s.quitarAsignacion(u, id);
  }
}

// ---------- Formatos de archivo (bancos y contabilidad) ----------

const FormatoDto = z.object({
  clase: z.enum(['banco', 'contable']),
  codigo: z.string().trim().regex(/^[A-Za-z0-9_]+$/),
  nombre: z.string().trim().min(1),
  definicion: z.any(),
  activo: z.boolean().optional(),
});

@Controller('formatos')
export class FormatosController {
  constructor(
    private readonly db: Db,
    private readonly auditoria: AuditoriaService,
  ) {}

  @Get()
  async listar(@Usuario() u: UsuarioSesion, @Query('clase') clase?: string) {
    return camelLista(
      await this.db.many(`select * from formatos_archivo where empresa_id = $1 and ($2::text is null or clase = $2) order by clase, nombre`, [u.empresaId, clase ?? null]),
    );
  }

  @Post()
  async guardar(@Usuario() u: UsuarioSesion, @Body(new Validar(FormatoDto)) d: z.infer<typeof FormatoDto>) {
    const def: FormatoArchivo = { ...d.definicion, codigo: d.codigo, nombre: d.nombre };
    const errores = validarFormato(def);
    if (errores.length) throw new ErrorNegocio('El formato tiene errores', 400, { errores });
    const r = await this.db.one(
      `insert into formatos_archivo (empresa_id, clase, codigo, nombre, definicion, activo) values ($1, $2, $3, $4, $5, $6)
       on conflict (empresa_id, clase, codigo) do update set nombre = excluded.nombre, definicion = excluded.definicion, activo = excluded.activo returning *`,
      [u.empresaId, d.clase, d.codigo, d.nombre, JSON.stringify(def), d.activo ?? true],
    );
    await this.auditoria.registrar(u, 'guardar', 'formato', `${d.clase}:${d.codigo}`, null, r);
    return camel(r);
  }

  @Delete(':id')
  async borrar(@Usuario() u: UsuarioSesion, @Param('id') id: string) {
    const r = await this.db.maybe('delete from formatos_archivo where id = $1 and empresa_id = $2 returning *', [id, u.empresaId]);
    if (!r) throw new ErrorNegocio('Formato no encontrado', 404);
    await this.auditoria.registrar(u, 'borrar', 'formato', id, r, null);
    return { ok: true };
  }
}

// ---------- Exportar e importar configuración (HU-64) ----------

@Injectable()
export class RespaldoService {
  constructor(
    private readonly db: Db,
    private readonly auditoria: AuditoriaService,
  ) {}

  async exportar(u: UsuarioSesion) {
    const e = await this.db.one('select configuracion, exonerada from empresas where id = $1', [u.empresaId]);
    const parametros = await this.db.many(
      `select p.codigo, p.nombre, p.descripcion, p.categoria, p.tipo, p.base_legal, p.valor_legal, p.vigencias_legales,
              json_agg(json_build_object('desde', v.desde, 'valor', v.valor) order by v.desde) as vigencias
       from parametros p join parametros_vigencias v on v.parametro_id = p.id where p.empresa_id = $1 group by p.id order by p.codigo`,
      [u.empresaId],
    );
    const strip = (rows: any[]) => rows.map(({ id, empresa_id, creado_en, actualizado_en, ...r }) => r);
    return {
      version: 1,
      generado: new Date().toISOString(),
      configuracion: configuracionCompleta(e.configuracion),
      exonerada: e.exonerada,
      parametros,
      tablas: strip(await this.db.many('select * from tablas_parametro where empresa_id = $1', [u.empresaId])),
      conceptos: strip(await this.db.many('select * from conceptos where empresa_id = $1', [u.empresaId])),
      festivos: await this.db.many(`select to_char(fecha, 'YYYY-MM-DD') as fecha, nombre from festivos where empresa_id = $1 order by fecha`, [u.empresaId]),
      turnos: strip(await this.db.many('select * from turnos where empresa_id = $1', [u.empresaId])),
      formatos: strip(await this.db.many('select * from formatos_archivo where empresa_id = $1', [u.empresaId])),
    };
  }

  /** Muestra qué cambiaría (aplicar = false) o lo aplica (aplicar = true). */
  async importar(u: UsuarioSesion, datos: any, aplicar: boolean) {
    if (!datos || datos.version !== 1) throw new ErrorNegocio('El archivo no es una configuración de Jornal 360');
    const actual = await this.exportar(u);
    const cambios: string[] = [];
    const porCodigo = (l: any[]) => new Map(l.map((x) => [x.codigo, x]));
    const pAct = porCodigo(actual.parametros);
    for (const p of datos.parametros ?? []) {
      const a = pAct.get(p.codigo);
      if (!a) cambios.push(`Parámetro nuevo: ${p.codigo}`);
      else if (JSON.stringify(a.vigencias.map((v: any) => [v.desde, String(v.valor)])) !== JSON.stringify(p.vigencias.map((v: any) => [v.desde, String(v.valor)])))
        cambios.push(`Cambian los valores de ${p.codigo}`);
    }
    const cAct = porCodigo(actual.conceptos);
    for (const c of datos.conceptos ?? []) {
      const a = cAct.get(c.codigo);
      if (!a) cambios.push(`Concepto nuevo: ${c.codigo}`);
      else if (a.formula !== c.formula || a.estado !== c.estado) cambios.push(`Cambia el concepto ${c.codigo}`);
    }
    const tAct = porCodigo(actual.tablas);
    for (const t of datos.tablas ?? []) if (JSON.stringify(tAct.get(t.codigo)?.filas) !== JSON.stringify(t.filas)) cambios.push(`Cambia la tabla ${t.codigo}`);
    if (JSON.stringify(actual.configuracion) !== JSON.stringify(configuracionCompleta(datos.configuracion))) cambios.push('Cambia la configuración general (calendario, asistencia, avisos)');
    if (!aplicar) return { cambios };

    await this.db.tx(async (cl) => {
      await this.db.exec('update empresas set configuracion = $2, exonerada = coalesce($3, exonerada) where id = $1', [u.empresaId, JSON.stringify(configuracionCompleta(datos.configuracion)), datos.exonerada ?? null], cl);
      for (const p of datos.parametros ?? []) {
        const r = await this.db.one(
          `insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           on conflict (empresa_id, codigo) do update set nombre = excluded.nombre returning id`,
          [u.empresaId, p.codigo, p.nombre, p.descripcion, p.categoria, p.tipo, p.base_legal, p.valor_legal, p.vigencias_legales ? JSON.stringify(p.vigencias_legales) : null],
          cl,
        );
        await this.db.exec('delete from parametros_vigencias where parametro_id = $1', [r.id], cl);
        for (const v of p.vigencias) await this.db.exec('insert into parametros_vigencias (parametro_id, desde, valor, creado_por) values ($1, $2, $3, $4)', [r.id, v.desde, v.valor, u.id], cl);
      }
      for (const t of datos.tablas ?? [])
        await this.db.exec(
          `insert into tablas_parametro (empresa_id, codigo, nombre, descripcion, columnas, filas, filas_legales) values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (empresa_id, codigo) do update set filas = excluded.filas, nombre = excluded.nombre, descripcion = excluded.descripcion`,
          [u.empresaId, t.codigo, t.nombre, t.descripcion, JSON.stringify(t.columnas), JSON.stringify(t.filas), t.filas_legales ? JSON.stringify(t.filas_legales) : null],
          cl,
        );
      for (const c of datos.conceptos ?? []) {
        const cols = ['nombre', 'descripcion', 'tipo', 'categoria', 'formula', 'salarial', 'base_ibc', 'base_arl', 'base_parafiscales', 'base_prestaciones', 'base_vacaciones', 'base_retencion', 'cuenta40', 'por_horas', 'requiere_novedad', 'orden', 'redondeo', 'es_legal', 'base_legal', 'cuenta_debito', 'cuenta_credito', 'tercero_credito', 'aplica_a', 'estado'];
        await this.db.exec(
          `insert into conceptos (empresa_id, codigo, ${cols.join(', ')}, definicion_legal) values ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}, $${cols.length + 3})
           on conflict (empresa_id, codigo) do update set ${cols.map((col) => `${col} = excluded.${col}`).join(', ')}, version = conceptos.version + 1`,
          [u.empresaId, c.codigo, ...cols.map((col) => c[col]), c.definicion_legal ? JSON.stringify(c.definicion_legal) : null],
          cl,
        );
      }
      for (const f of datos.festivos ?? [])
        await this.db.exec('insert into festivos (empresa_id, fecha, nombre) values ($1, $2, $3) on conflict (empresa_id, fecha) do update set nombre = excluded.nombre', [u.empresaId, f.fecha, f.nombre], cl);
      for (const f of datos.formatos ?? [])
        await this.db.exec(
          `insert into formatos_archivo (empresa_id, clase, codigo, nombre, definicion, activo) values ($1, $2, $3, $4, $5, $6)
           on conflict (empresa_id, clase, codigo) do update set nombre = excluded.nombre, definicion = excluded.definicion, activo = excluded.activo`,
          [u.empresaId, f.clase, f.codigo, f.nombre, JSON.stringify(f.definicion), f.activo],
          cl,
        );
    });
    await this.auditoria.registrar(u, 'importar', 'configuracion', u.empresaId, null, { cambios });
    return { cambios, aplicado: true };
  }
}

@Controller('respaldo')
export class RespaldoController {
  constructor(private readonly s: RespaldoService) {}

  @Get('exportar')
  exportar(@Usuario() u: UsuarioSesion) {
    return this.s.exportar(u);
  }

  @Post('importar')
  importar(@Usuario() u: UsuarioSesion, @Body() d: { datos: unknown; aplicar?: boolean }) {
    return this.s.importar(u, d?.datos, !!d?.aplicar);
  }
}

/** Para pruebas: parámetros como fuente del motor. */
export const fuenteDesdeVigencias = (v: { codigo: string; desde: string; valor: string }[]) => new ParametrosEnMemoria(v);
