import { Body, Controller, Delete, Get, Injectable, Param, Patch, Post, Query, Res } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { Response } from 'express';
import { z } from 'zod';
import { AuditoriaService } from '../../common/auditoria.service';
import { ErrorNegocio, Usuario, UsuarioSesion, Validar } from '../../common/comun';
import { crearPdf, encabezado } from '../../common/pdf';
import { camel, camelLista, fechaLocal, nombreCompleto, pesos, zFecha, zNumero } from '../../common/util';
import { Db, Ejecutor } from '../../db/db.service';
import { D } from '../../domain/decimal';
import { diasComerciales, diferenciaDias, sumarDias, sumarMeses } from '../../domain/fechas';
import { pinCuatroDigitos } from '../../domain/qr';
import { ContextoService } from '../configuracion/contexto.service';

const zTexto = z.string().trim().optional().nullable();
const zId = z.string().uuid().optional().nullable();

const EmpleadoDto = z.object({
  tipoDocumento: z.enum(['CC', 'CE', 'TI', 'PA', 'PEP', 'PPT', 'NIT']).default('CC'),
  numeroDocumento: z.string().trim().regex(/^[0-9A-Za-z-]{3,20}$/, 'Documento no válido'),
  nombres: z.string().trim().min(1, 'Escriba los nombres'),
  apellidos: z.string().trim().min(1, 'Escriba los apellidos'),
  fechaNacimiento: zFecha.optional().nullable(),
  genero: zTexto,
  correo: z.string().trim().email('Correo no válido').optional().nullable().or(z.literal('')),
  telefono: zTexto,
  direccion: zTexto,
  ciudad: zTexto,
  banco: zTexto,
  codigoBanco: zTexto,
  tipoCuenta: zTexto,
  numeroCuenta: zTexto,
  epsId: zId,
  afpId: zId,
  cesantiasId: zId,
  ccfId: zId,
  esPensionado: z.boolean().optional(),
  procedimientoRetencion: z.union([z.literal(1), z.literal(2)]).optional(),
  porcentajeProc2: zNumero.optional().nullable(),
  tieneDependiente: z.boolean().optional(),
  dependientesAdicionales: z.number().int().min(0).max(4).optional(),
  interesesVivienda: zNumero.optional(),
  medicinaPrepagada: zNumero.optional(),
  aportesVoluntarios: zNumero.optional(),
  soportesRetencionHasta: zFecha.optional().nullable(),
  sedeId: zId,
  areaId: zId,
  centroCostoId: zId,
  grupoPagoId: zId,
  turnoId: zId,
  cargo: zTexto,
  marcaEnKiosco: z.boolean().optional(),
  kioscoId: zId,
  camposAdicionales: z.record(z.union([z.string(), z.number(), z.null()])).optional(),
  aceptaTratamientoDatos: z.boolean().optional(),
});

const EMPLEADO_COLS: Record<string, string> = {
  tipoDocumento: 'tipo_documento',
  numeroDocumento: 'numero_documento',
  nombres: 'nombres',
  apellidos: 'apellidos',
  fechaNacimiento: 'fecha_nacimiento',
  genero: 'genero',
  correo: 'correo',
  telefono: 'telefono',
  direccion: 'direccion',
  ciudad: 'ciudad',
  banco: 'banco',
  codigoBanco: 'codigo_banco',
  tipoCuenta: 'tipo_cuenta',
  numeroCuenta: 'numero_cuenta',
  epsId: 'eps_id',
  afpId: 'afp_id',
  cesantiasId: 'cesantias_id',
  ccfId: 'ccf_id',
  esPensionado: 'es_pensionado',
  procedimientoRetencion: 'procedimiento_retencion',
  porcentajeProc2: 'porcentaje_proc2',
  tieneDependiente: 'tiene_dependiente',
  dependientesAdicionales: 'dependientes_adicionales',
  interesesVivienda: 'intereses_vivienda',
  medicinaPrepagada: 'medicina_prepagada',
  aportesVoluntarios: 'aportes_voluntarios',
  soportesRetencionHasta: 'soportes_retencion_hasta',
  sedeId: 'sede_id',
  areaId: 'area_id',
  centroCostoId: 'centro_costo_id',
  grupoPagoId: 'grupo_pago_id',
  turnoId: 'turno_id',
  cargo: 'cargo',
  marcaEnKiosco: 'marca_en_kiosco',
  kioscoId: 'kiosco_id',
  camposAdicionales: 'campos_adicionales',
};

const ContratoDto = z.object({
  tipo: z.enum(['indefinido', 'fijo', 'obra_labor', 'ocasional', 'aprendizaje', 'integral', 'tiempo_parcial']),
  fechaInicio: zFecha,
  fechaFin: zFecha.optional().nullable(),
  descripcionObra: zTexto,
  cargo: zTexto,
  salario: zNumero.optional(),
  tipoSalario: z.enum(['fijo', 'variable', 'integral']).optional(),
  factorPrestacional: zNumero.optional().nullable(),
  faseAprendiz: z.enum(['lectiva', 'practica', 'dual_1', 'dual_2', 'universitario']).optional().nullable(),
  auxilioTransporte: z.enum(['ley', 'siempre', 'nunca']).optional(),
  horasSemanales: zNumero.optional().nullable(),
  claseRiesgo: z.number().int().min(1).max(5).optional(),
  confirmar: z.boolean().optional(),
});

const CambioSalarioDto = z.object({ desde: zFecha, salario: zNumero, cargo: zTexto, motivo: zTexto, confirmar: z.boolean().optional() });
const AfiliacionDto = z.object({ tipo: z.enum(['eps', 'afp', 'cesantias', 'ccf']), entidadId: z.string().uuid(), desde: zFecha });

@Injectable()
export class EmpleadosService {
  constructor(
    private readonly db: Db,
    private readonly auditoria: AuditoriaService,
    private readonly contexto: ContextoService,
  ) {}

  async listar(u: UsuarioSesion, q: { buscar?: string; estado?: string; sedeId?: string; centroCostoId?: string; grupoPagoId?: string }) {
    const filas = await this.db.many(
      `select e.*, s.nombre as sede, cc.nombre as centro_costo, g.nombre as grupo_pago,
              c.id as contrato_id, c.tipo as tipo_contrato, c.fecha_inicio, c.fecha_fin,
              (select h.salario from historial_salarial h where h.contrato_id = c.id and h.desde <= current_date order by h.desde desc limit 1) as salario,
              exists (select 1 from dispositivos d where d.empleado_id = e.id and d.activo) as celular_vinculado
       from empleados e
       left join sedes s on s.id = e.sede_id
       left join centros_costo cc on cc.id = e.centro_costo_id
       left join grupos_pago g on g.id = e.grupo_pago_id
       left join lateral (select * from contratos c where c.empleado_id = e.id order by (c.estado = 'activo') desc, c.fecha_inicio desc limit 1) c on true
       where e.empresa_id = $1
         and ($2::text is null or (e.nombres || ' ' || e.apellidos || ' ' || e.numero_documento || ' ' || coalesce(e.cargo, '')) ilike '%' || $2 || '%')
         and ($3::text is null or e.estado = $3)
         and ($4::uuid is null or e.sede_id = $4)
         and ($5::uuid is null or e.centro_costo_id = $5)
         and ($6::uuid is null or e.grupo_pago_id = $6)
       order by e.apellidos, e.nombres`,
      [u.empresaId, q.buscar || null, q.estado || null, q.sedeId || null, q.centroCostoId || null, q.grupoPagoId || null],
    );
    return filas.map((f) => {
      const { pin_hash, ...resto } = f;
      return { ...camel<any>(resto), tienePin: !!pin_hash };
    });
  }

  async ver(u: UsuarioSesion, id: string) {
    const e = await this.db.maybe('select * from empleados where id = $1 and empresa_id = $2', [id, u.empresaId]);
    if (!e) throw new ErrorNegocio('Empleado no encontrado', 404);
    const contratos = await this.db.many('select * from contratos where empleado_id = $1 order by fecha_inicio desc', [id]);
    const historial = await this.db.many(
      'select h.* from historial_salarial h join contratos c on c.id = h.contrato_id where c.empleado_id = $1 order by h.desde desc',
      [id],
    );
    const afiliaciones = await this.db.many(
      'select a.*, en.nombre as entidad from afiliaciones_historial a left join entidades en on en.id = a.entidad_id where a.empleado_id = $1 order by a.desde desc',
      [id],
    );
    const { pin_hash, ...resto } = e;
    return {
      ...camel<any>(resto),
      tienePin: !!pin_hash,
      contratos: camelLista(contratos),
      historialSalarial: camelLista(historial),
      afiliaciones: camelLista(afiliaciones),
    };
  }

  async crear(u: UsuarioSesion, d: z.infer<typeof EmpleadoDto>) {
    // Sin grupo de pago el empleado no entraría en ningún periodo: se usa el primero activo de la empresa.
    if (!d.grupoPagoId) d.grupoPagoId = (await this.db.maybe('select id from grupos_pago where empresa_id = $1 and activo order by nombre limit 1', [u.empresaId]))?.id ?? null;
    const campos = Object.entries(EMPLEADO_COLS).filter(([k]) => (d as any)[k] !== undefined);
    const r = await this.db.one(
      `insert into empleados (empresa_id${campos.map(([, c]) => ', ' + c).join('')}, autorizacion_datos_en)
       values ($1${campos.map((_, i) => `, $${i + 2}`).join('')}, $${campos.length + 2}) returning id`,
      [u.empresaId, ...campos.map(([k]) => valor((d as any)[k])), d.aceptaTratamientoDatos ? new Date() : null],
    );
    for (const t of ['eps', 'afp', 'cesantias', 'ccf'] as const) {
      const ent = (d as any)[`${t}Id`];
      if (ent) await this.db.exec('insert into afiliaciones_historial (empleado_id, tipo, entidad_id, desde) values ($1, $2, $3, current_date)', [r.id, t, ent]);
    }
    const nuevo = await this.ver(u, r.id);
    await this.auditoria.registrar(u, 'crear', 'empleado', r.id, null, nuevo);
    return nuevo;
  }

  async editar(u: UsuarioSesion, id: string, d: Partial<z.infer<typeof EmpleadoDto>>) {
    const antes = await this.db.maybe('select * from empleados where id = $1 and empresa_id = $2', [id, u.empresaId]);
    if (!antes) throw new ErrorNegocio('Empleado no encontrado', 404);
    const campos = Object.entries(EMPLEADO_COLS).filter(([k]) => (d as any)[k] !== undefined);
    if (campos.length)
      await this.db.exec(`update empleados set ${campos.map(([, c], i) => `${c} = $${i + 2}`).join(', ')}, actualizado_en = now() where id = $1`, [
        id,
        ...campos.map(([k]) => valor((d as any)[k])),
      ]);
    if (d.aceptaTratamientoDatos && !antes.autorizacion_datos_en) await this.db.exec('update empleados set autorizacion_datos_en = now() where id = $1', [id]);
    const despues = await this.ver(u, id);
    await this.auditoria.registrar(u, 'editar', 'empleado', id, antes, despues);
    return despues;
  }

  async borrar(u: UsuarioSesion, id: string) {
    const antes = await this.db.maybe('select * from empleados where id = $1 and empresa_id = $2', [id, u.empresaId]);
    if (!antes) throw new ErrorNegocio('Empleado no encontrado', 404);
    const liquidado = await this.db.maybe('select 1 from liquidaciones where empleado_id = $1 limit 1', [id]);
    if (liquidado) throw new ErrorNegocio('El empleado ya tiene nóminas liquidadas; regístrele un retiro en lugar de borrarlo');
    await this.db.exec('delete from empleados where id = $1', [id]);
    await this.auditoria.registrar(u, 'borrar', 'empleado', id, antes, null);
    return { ok: true };
  }

  // ---------- Contratos ----------

  async crearContrato(u: UsuarioSesion, empleadoId: string, d: z.infer<typeof ContratoDto>) {
    await this.ver(u, empleadoId);
    const ctx = await this.contexto.cargar(u.empresaId);
    const smmlv = ctx.parametros.valor('SMMLV', d.fechaInicio) ?? D(0);
    const advertencias: string[] = [];
    const activo = await this.db.maybe(`select id from contratos where empleado_id = $1 and estado = 'activo'`, [empleadoId]);
    if (activo) throw new ErrorNegocio('El empleado ya tiene un contrato activo. Termínelo antes de crear otro');
    if ((d.tipo === 'fijo' || d.tipo === 'aprendizaje') && !d.fechaFin) throw new ErrorNegocio('El contrato a término fijo necesita fecha de terminación');
    if (d.tipo === 'obra_labor' && !d.descripcionObra) throw new ErrorNegocio('Describa la obra o labor contratada (CST art. 46)');
    if (d.fechaFin && d.fechaFin < d.fechaInicio) throw new ErrorNegocio('La fecha de terminación es anterior al inicio');
    if (d.tipo === 'fijo' && d.fechaFin) {
      const maxAnios = ctx.configuracion.retiro.maxAniosFijo;
      if (d.fechaFin > sumarDias(sumarMeses(d.fechaInicio, 12 * maxAnios), -1))
        throw new ErrorNegocio(`El contrato a término fijo no puede superar ${maxAnios} años (CST art. 46)`);
    }
    if (d.tipo === 'aprendizaje' && !d.faseAprendiz) throw new ErrorNegocio('Indique la fase del aprendiz');
    const integral = d.tipo === 'integral' || d.tipoSalario === 'integral';
    const salario = d.salario !== undefined ? D(d.salario) : d.tipo === 'aprendizaje' ? D(0) : null;
    if (salario === null) throw new ErrorNegocio('Escriba el salario');
    if (integral) {
      const min = (ctx.parametros.valor('INTEGRAL_MIN_SMMLV', d.fechaInicio) ?? D(10)).mul(smmlv).mul(D(1).plus(ctx.parametros.valor('INTEGRAL_FACTOR_MIN', d.fechaInicio) ?? D('0.3')));
      if (salario.lt(min)) advertencias.push(`El salario integral es menor que el mínimo configurado (${pesos(min.toFixed(0))})`);
    } else if (d.tipo !== 'aprendizaje' && d.tipo !== 'tiempo_parcial' && salario.lt(smmlv))
      advertencias.push(`El salario es menor que el salario mínimo (${pesos(smmlv.toFixed(0))})`);
    if (advertencias.length && !d.confirmar) throw new ErrorNegocio(advertencias.join('. '), 409, { requiereConfirmacion: true, advertencias });

    const r = await this.db.tx(async (c) => {
      const ct = await this.db.one(
        `insert into contratos (empresa_id, empleado_id, tipo, fecha_inicio, fecha_fin, fecha_fin_pactada, descripcion_obra, cargo, tipo_salario, salario_integral,
           factor_prestacional, fase_aprendiz, auxilio_transporte, horas_semanales, clase_riesgo)
         values ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning *`,
        [
          u.empresaId,
          empleadoId,
          d.tipo,
          d.fechaInicio,
          d.fechaFin ?? null,
          d.descripcionObra ?? null,
          d.cargo ?? null,
          integral ? 'integral' : (d.tipoSalario ?? 'fijo'),
          integral,
          d.factorPrestacional ?? (integral ? '0.30' : null),
          d.faseAprendiz ?? null,
          d.auxilioTransporte ?? 'ley',
          d.horasSemanales ?? null,
          d.claseRiesgo ?? 1,
        ],
        c,
      );
      await this.db.exec('insert into historial_salarial (contrato_id, desde, salario, cargo, motivo, creado_por) values ($1, $2, $3, $4, $5, $6)', [
        ct.id,
        d.fechaInicio,
        salario.toFixed(),
        d.cargo ?? null,
        'Salario inicial',
        u.id,
      ], c);
      if (d.cargo) await this.db.exec('update empleados set cargo = $2 where id = $1', [empleadoId, d.cargo], c);
      await this.db.exec(`update empleados set estado = 'activo' where id = $1`, [empleadoId], c);
      return ct;
    });
    await this.auditoria.registrar(u, 'crear', 'contrato', r.id, null, r, { motivo: advertencias.length ? `Confirmado con advertencias: ${advertencias.join('; ')}` : undefined });
    return { ...camel(r), advertencias };
  }

  async editarContrato(u: UsuarioSesion, contratoId: string, d: Partial<z.infer<typeof ContratoDto>> & { prorrogas?: number }) {
    const antes = await this.db.maybe('select * from contratos where id = $1 and empresa_id = $2', [contratoId, u.empresaId]);
    if (!antes) throw new ErrorNegocio('Contrato no encontrado', 404);
    const r = await this.db.one(
      `update contratos set fecha_fin = coalesce($2, fecha_fin), fecha_fin_pactada = coalesce($2, fecha_fin_pactada), cargo = coalesce($3, cargo),
         fase_aprendiz = coalesce($4, fase_aprendiz), auxilio_transporte = coalesce($5, auxilio_transporte), horas_semanales = coalesce($6, horas_semanales),
         clase_riesgo = coalesce($7, clase_riesgo), prorrogas = coalesce($8, prorrogas), descripcion_obra = coalesce($9, descripcion_obra),
         tipo_salario = coalesce($10, tipo_salario)
       where id = $1 returning *`,
      [
        contratoId,
        d.fechaFin ?? null,
        d.cargo ?? null,
        d.faseAprendiz ?? null,
        d.auxilioTransporte ?? null,
        d.horasSemanales ?? null,
        d.claseRiesgo ?? null,
        d.prorrogas ?? null,
        d.descripcionObra ?? null,
        d.tipoSalario ?? null,
      ],
    );
    await this.auditoria.registrar(u, 'editar', 'contrato', contratoId, antes, r);
    return camel(r);
  }

  /** Aumento o cambio de salario con fecha (HU-19). Si la fecha es pasada, avisa el retroactivo. */
  async cambiarSalario(u: UsuarioSesion, contratoId: string, d: z.infer<typeof CambioSalarioDto>) {
    const ct = await this.db.maybe('select * from contratos where id = $1 and empresa_id = $2', [contratoId, u.empresaId]);
    if (!ct) throw new ErrorNegocio('Contrato no encontrado', 404);
    if (d.desde < ct.fecha_inicio) throw new ErrorNegocio('La fecha es anterior al inicio del contrato');
    const ctx = await this.contexto.cargar(u.empresaId);
    const smmlv = ctx.parametros.valor('SMMLV', d.desde) ?? D(0);
    if (!ct.salario_integral && ct.tipo !== 'aprendizaje' && ct.tipo !== 'tiempo_parcial' && D(d.salario).lt(smmlv) && !d.confirmar)
      throw new ErrorNegocio(`El salario es menor que el salario mínimo (${pesos(smmlv.toFixed(0))})`, 409, { requiereConfirmacion: true });
    const r = await this.db.one(
      `insert into historial_salarial (contrato_id, desde, salario, cargo, motivo, creado_por) values ($1, $2, $3, $4, $5, $6)
       on conflict (contrato_id, desde) do update set salario = excluded.salario, cargo = excluded.cargo, motivo = excluded.motivo returning *`,
      [contratoId, d.desde, d.salario, d.cargo ?? null, d.motivo ?? null, u.id],
    );
    if (d.cargo) await this.db.exec('update contratos set cargo = $2 where id = $1', [contratoId, d.cargo]);
    if (d.cargo) await this.db.exec('update empleados set cargo = $2 where id = $1', [ct.empleado_id, d.cargo]);
    const cerrados = await this.db.many(
      `select p.id, p.nombre from periodos p join liquidaciones l on l.periodo_id = p.id
       where l.empleado_id = $1 and p.estado in ('aprobado', 'cerrado') and p.hasta >= $2 and p.tipo = 'nomina' order by p.desde`,
      [ct.empleado_id, d.desde],
    );
    await this.auditoria.registrar(u, 'cambiar_salario', 'contrato', contratoId, null, r);
    return { ...camel(r), retroactivo: cerrados.length ? { periodos: camelLista(cerrados), mensaje: 'Hay nóminas cerradas desde esa fecha: puede calcular el retroactivo' } : null };
  }

  async cambiarAfiliacion(u: UsuarioSesion, empleadoId: string, d: z.infer<typeof AfiliacionDto>) {
    await this.ver(u, empleadoId);
    await this.db.exec('insert into afiliaciones_historial (empleado_id, tipo, entidad_id, desde) values ($1, $2, $3, $4)', [empleadoId, d.tipo, d.entidadId, d.desde]);
    if (d.desde <= fechaLocal()) await this.db.exec(`update empleados set ${d.tipo}_id = $2 where id = $1`, [empleadoId, d.entidadId]);
    await this.auditoria.registrar(u, 'cambiar_afiliacion', 'empleado', empleadoId, null, d);
    return this.ver(u, empleadoId);
  }

  /** Genera un PIN nuevo para el kiosco (HU-28). Se muestra una sola vez. */
  async restablecerPin(u: UsuarioSesion, empleadoId: string) {
    await this.ver(u, empleadoId);
    const pin = pinCuatroDigitos();
    await this.db.exec('update empleados set pin_hash = $2, pin_intentos = 0, pin_bloqueado = false where id = $1', [empleadoId, await bcrypt.hash(pin, 8)]);
    await this.auditoria.registrar(u, 'restablecer_pin', 'empleado', empleadoId, null, null);
    return { pin };
  }

  /** Contratos a término fijo por vencer y que superarían el límite (HU-21). */
  async contratosPorVencer(u: UsuarioSesion, dias?: number) {
    const ctx = await this.contexto.cargar(u.empresaId);
    const d = dias ?? ctx.configuracion.avisos.diasContratoPorVencer;
    const hoy = fechaLocal();
    const filas = await this.db.many(
      `select c.*, e.nombres, e.apellidos, e.numero_documento from contratos c join empleados e on e.id = c.empleado_id
       where c.empresa_id = $1 and c.estado = 'activo' and c.fecha_fin is not null and c.fecha_fin <= $2::date + $3::int order by c.fecha_fin`,
      [u.empresaId, hoy, d],
    );
    const maxAnios = ctx.configuracion.retiro.maxAniosFijo;
    return filas.map((f) => {
      const duracion = diasComerciales(f.fecha_inicio, f.fecha_fin);
      const proxima = diasComerciales(f.fecha_inicio, sumarDias(f.fecha_fin, duracion));
      return {
        contratoId: f.id,
        empleadoId: f.empleado_id,
        empleado: nombreCompleto(f),
        documento: f.numero_documento,
        tipo: f.tipo,
        fechaFin: f.fecha_fin,
        diasRestantes: diferenciaDias(hoy, f.fecha_fin),
        superaLimiteConProrroga: f.tipo === 'fijo' && proxima > maxAnios * 360,
        avisoPreaviso: 'Si ninguna parte avisa con 30 días de anticipación, el contrato se prorroga automáticamente (CST art. 46)',
      };
    });
  }

  async certificadoLaboral(u: UsuarioSesion, empleadoId: string, conSalario: boolean): Promise<Buffer> {
    const e = await this.ver(u, empleadoId);
    const empresa = await this.db.one('select * from empresas where id = $1', [u.empresaId]);
    const ct = e.contratos[0];
    if (!ct) throw new ErrorNegocio('El empleado no tiene contrato');
    const salario = e.historialSalarial.find((h: any) => h.contratoId === ct.id)?.salario;
    const tipos: Record<string, string> = {
      indefinido: 'a término indefinido',
      fijo: 'a término fijo',
      obra_labor: 'por obra o labor',
      ocasional: 'ocasional',
      aprendizaje: 'de aprendizaje',
      integral: 'a término indefinido con salario integral',
      tiempo_parcial: 'de tiempo parcial',
    };
    await this.auditoria.registrar(u, 'generar', 'certificado_laboral', empleadoId, null, { conSalario });
    return crearPdf((doc) => {
      encabezado(doc, empresa, 'CERTIFICACIÓN LABORAL');
      doc.moveDown(1).fontSize(11);
      const vigente = ct.estado === 'activo';
      doc.text(
        `${empresa.razon_social}, identificada con NIT ${empresa.nit}${empresa.dv ? '-' + empresa.dv : ''}, certifica que ${nombreCompleto(e)}, identificado(a) con ${e.tipoDocumento} ${e.numeroDocumento}, ` +
          (vigente ? `labora en la empresa desde el ${ct.fechaInicio}` : `laboró en la empresa desde el ${ct.fechaInicio} hasta el ${ct.fechaFin}`) +
          `, con contrato ${tipos[ct.tipo] ?? ct.tipo}, en el cargo de ${ct.cargo ?? e.cargo ?? 'colaborador(a)'}` +
          (conSalario && salario ? `, devengando un salario mensual de ${pesos(salario)}` : '') +
          '.',
        { align: 'justify', lineGap: 4 },
      );
      doc.moveDown(1.5).text(`Se expide a solicitud del interesado el ${fechaLocal()}.`);
      doc.moveDown(4).text('______________________________').text('Firma autorizada');
      doc.moveDown(2).fontSize(8).fillColor('#777777').text('Documento generado por Jornal 360 (CST art. 57 num. 7).');
    });
  }

  async ejecutor(): Promise<Ejecutor> {
    return this.db.pool;
  }
}

const valor = (v: unknown) => (v === '' ? null : v !== null && typeof v === 'object' ? JSON.stringify(v) : v);

@Controller('empleados')
export class EmpleadosController {
  constructor(private readonly s: EmpleadosService) {}

  @Get()
  listar(@Usuario() u: UsuarioSesion, @Query() q: Record<string, string>) {
    return this.s.listar(u, q);
  }

  @Get('contratos-por-vencer')
  porVencer(@Usuario() u: UsuarioSesion, @Query('dias') dias?: string) {
    return this.s.contratosPorVencer(u, dias ? Number(dias) : undefined);
  }

  @Get(':id')
  ver(@Usuario() u: UsuarioSesion, @Param('id') id: string) {
    return this.s.ver(u, id);
  }

  @Post()
  crear(@Usuario() u: UsuarioSesion, @Body(new Validar(EmpleadoDto)) d: z.infer<typeof EmpleadoDto>) {
    return this.s.crear(u, d);
  }

  @Patch(':id')
  editar(@Usuario() u: UsuarioSesion, @Param('id') id: string, @Body(new Validar(EmpleadoDto.partial())) d: Partial<z.infer<typeof EmpleadoDto>>) {
    return this.s.editar(u, id, d);
  }

  @Delete(':id')
  borrar(@Usuario() u: UsuarioSesion, @Param('id') id: string) {
    return this.s.borrar(u, id);
  }

  @Post(':id/contratos')
  contrato(@Usuario() u: UsuarioSesion, @Param('id') id: string, @Body(new Validar(ContratoDto)) d: z.infer<typeof ContratoDto>) {
    return this.s.crearContrato(u, id, d);
  }

  @Patch('contratos/:contratoId')
  editarContrato(
    @Usuario() u: UsuarioSesion,
    @Param('contratoId') id: string,
    @Body(new Validar(ContratoDto.partial().extend({ prorrogas: z.number().int().min(0).optional() }))) d: any,
  ) {
    return this.s.editarContrato(u, id, d);
  }

  @Post('contratos/:contratoId/salarios')
  salario(@Usuario() u: UsuarioSesion, @Param('contratoId') id: string, @Body(new Validar(CambioSalarioDto)) d: z.infer<typeof CambioSalarioDto>) {
    return this.s.cambiarSalario(u, id, d);
  }

  @Post(':id/afiliaciones')
  afiliacion(@Usuario() u: UsuarioSesion, @Param('id') id: string, @Body(new Validar(AfiliacionDto)) d: z.infer<typeof AfiliacionDto>) {
    return this.s.cambiarAfiliacion(u, id, d);
  }

  @Post(':id/pin')
  pin(@Usuario() u: UsuarioSesion, @Param('id') id: string) {
    return this.s.restablecerPin(u, id);
  }

  @Get(':id/certificado-laboral')
  async certificado(@Usuario() u: UsuarioSesion, @Param('id') id: string, @Query('salario') salario: string, @Res() res: Response) {
    const pdf = await this.s.certificadoLaboral(u, id, salario !== 'no');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="certificado-laboral.pdf"`);
    res.send(pdf);
  }
}
