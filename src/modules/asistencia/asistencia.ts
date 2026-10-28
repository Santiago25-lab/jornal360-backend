import { Body, Controller, Delete, Get, Injectable, Param, Post, Query } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { AuditoriaService } from '../../common/auditoria.service';
import { ErrorNegocio, Ip, Publico, Usuario, UsuarioSesion, Validar } from '../../common/comun';
import { aLocal, camel, camelLista, desdeLocal, fechaLocal, nombreCompleto, zFecha } from '../../common/util';
import { config } from '../../config';
import { Db } from '../../db/db.service';
import { rango, sumarDias } from '../../domain/fechas';
import { aHoras, ClasificadorHoras, emparejarMarcaciones, TIPOS_HORA, Turno } from '../../domain/horas';
import { codigoSeisDigitos, generarTokenQr, llaveDispositivo, verificarTokenQr } from '../../domain/qr';
import { ContextoService } from '../configuracion/contexto.service';

const hashLlave = (llave: string) => createHash('sha256').update(llave).digest('hex');
const zHoraLocal = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Hora con formato AAAA-MM-DDTHH:mm');

@Injectable()
export class AsistenciaService {
  constructor(
    private readonly db: Db,
    private readonly auditoria: AuditoriaService,
    private readonly contexto: ContextoService,
  ) {}

  private async opcionesQr(empresaId: string) {
    const ctx = await this.contexto.cargar(empresaId);
    return { secreto: `${config().qrSecreto}:${empresaId}`, segundos: ctx.configuracion.asistencia.qrSegundos, gracia: ctx.configuracion.asistencia.qrGracia, ctx };
  }

  // ---------- QR de la sede (HU-23) ----------

  async qrSede(u: UsuarioSesion, sedeId: string) {
    const sede = await this.db.maybe('select id, nombre from sedes where id = $1 and empresa_id = $2 and activa', [sedeId, u.empresaId]);
    if (!sede) throw new ErrorNegocio('Sede no encontrada', 404);
    const op = await this.opcionesQr(u.empresaId);
    const { token, venceEn } = generarTokenQr(`${u.empresaId}~${sedeId}`, op);
    return { token, venceEn, segundos: op.segundos, sede: sede.nombre, url: `${config().urlFrontend}/marcar?t=${encodeURIComponent(token)}`, hora: aLocal(new Date()) };
  }

  private async validarQr(token: string) {
    const sedePart = token.split('.')[0] ?? '';
    const [empresaId, sedeId] = sedePart.split('~');
    if (!empresaId || !sedeId) throw new ErrorNegocio('El código QR no es válido', 400);
    const op = await this.opcionesQr(empresaId).catch(() => null);
    if (!op) throw new ErrorNegocio('El código QR no es válido', 400);
    const r = verificarTokenQr(token, op);
    if (!r.valido)
      throw new ErrorNegocio(r.motivo === 'vencido' ? 'El código QR ya venció. Escanee el código que aparece ahora en la pantalla' : 'El código QR no es válido', 400, { motivo: r.motivo });
    return { empresaId, sedeId, ctx: op.ctx };
  }

  // ---------- Vinculación de celulares (HU-24, HU-26) ----------

  async generarVinculacion(u: UsuarioSesion, empleadoId: string) {
    const e = await this.db.maybe(`select * from empleados where id = $1 and empresa_id = $2 and estado = 'activo'`, [empleadoId, u.empresaId]);
    if (!e) throw new ErrorNegocio('Empleado no encontrado o retirado', 404);
    await this.db.exec(`delete from codigos_vinculacion where empleado_id = $1 and usado_en is null`, [empleadoId]);
    const codigo = codigoSeisDigitos();
    const token = randomBytes(18).toString('base64url');
    const expira = new Date(Date.now() + 10 * 60000);
    await this.db.exec(
      `insert into codigos_vinculacion (empresa_id, tipo, empleado_id, codigo, token, expira_en) values ($1, 'celular', $2, $3, $4, $5)`,
      [u.empresaId, empleadoId, codigo, token, expira],
    );
    await this.auditoria.registrar(u, 'generar_vinculacion', 'empleado', empleadoId, null, { expira });
    return { codigo, token, expiraEn: expira.toISOString(), url: `${config().urlFrontend}/vincular?c=${token}`, empleado: nombreCompleto(e) };
  }

  private async buscarCodigo(d: { token?: string; codigo?: string }, tipo: 'celular' | 'kiosco') {
    const r = await this.db.maybe(
      `select * from codigos_vinculacion where tipo = $1 and usado_en is null and expira_en > now() and (($2::text is not null and token = $2) or ($3::text is not null and codigo = $3))
       order by creado_en desc limit 1`,
      [tipo, d.token ?? null, d.codigo ?? null],
    );
    if (!r) throw new ErrorNegocio('El código de vinculación no existe, ya se usó o venció. Pida uno nuevo al administrador', 400);
    return r;
  }

  async infoVinculacion(token: string) {
    const c = await this.buscarCodigo({ token }, 'celular');
    const e = await this.db.one('select nombres, apellidos, tipo_documento, numero_documento from empleados where id = $1', [c.empleado_id]);
    return { empleado: nombreCompleto(e), documentoOculto: `${e.tipo_documento} ${'•'.repeat(Math.max(0, e.numero_documento.length - 3))}${e.numero_documento.slice(-3)}` };
  }

  async vincular(d: { token?: string; codigo?: string; documento: string; aceptaDatos: boolean; descripcion?: string; llaveActual?: string }, ip: string) {
    const c = await this.buscarCodigo(d, 'celular');
    const e = await this.db.one('select * from empleados where id = $1', [c.empleado_id]);
    if (e.numero_documento.replace(/\D/g, '') !== d.documento.replace(/\D/g, '')) throw new ErrorNegocio('La cédula no coincide con el empleado de este código');
    if (!d.aceptaDatos) throw new ErrorNegocio('Debe aceptar la autorización de tratamiento de datos para vincular el celular');
    if (d.llaveActual) {
      const otro = await this.db.maybe(
        `select d.empleado_id from dispositivos d where d.llave_hash = $1 and d.activo and d.empleado_id <> $2`,
        [hashLlave(d.llaveActual), e.id],
      );
      if (otro) throw new ErrorNegocio('Este celular ya está vinculado a otro empleado. Un celular solo puede marcar por una persona');
    }
    const llave = llaveDispositivo();
    await this.db.tx(async (cl) => {
      await this.db.exec(`update dispositivos set activo = false, desvinculado_en = now() where empleado_id = $1 and activo`, [e.id], cl);
      await this.db.exec(`insert into dispositivos (empresa_id, empleado_id, llave_hash, descripcion) values ($1, $2, $3, $4)`, [
        e.empresa_id,
        e.id,
        hashLlave(llave),
        (d.descripcion ?? '').slice(0, 200) || null,
      ], cl);
      await this.db.exec(`update codigos_vinculacion set usado_en = now() where id = $1`, [c.id], cl);
      await this.db.exec(`update empleados set autorizacion_datos_en = coalesce(autorizacion_datos_en, now()) where id = $1`, [e.id], cl);
    });
    await this.auditoria.registrar(null, 'vincular_celular', 'empleado', e.id, null, { descripcion: d.descripcion }, { ip, empresaId: e.empresa_id });
    return { llave, empleado: nombreCompleto(e) };
  }

  async dispositivos(u: UsuarioSesion) {
    return camelLista(
      await this.db.many(
        `select d.id, d.empleado_id, d.descripcion, d.vinculado_en, d.ultimo_uso, e.nombres, e.apellidos, e.numero_documento
         from dispositivos d join empleados e on e.id = d.empleado_id where d.empresa_id = $1 and d.activo order by e.apellidos`,
        [u.empresaId],
      ),
    );
  }

  async desvincular(u: UsuarioSesion, id: string) {
    const r = await this.db.maybe(`update dispositivos set activo = false, desvinculado_en = now() where id = $1 and empresa_id = $2 and activo returning *`, [id, u.empresaId]);
    if (!r) throw new ErrorNegocio('Celular no encontrado', 404);
    await this.auditoria.registrar(u, 'desvincular_celular', 'empleado', r.empleado_id, r, null);
    return { ok: true };
  }

  // ---------- Marcación con celular (HU-25) ----------

  private async empleadoPorLlave(llave: string) {
    const d = await this.db.maybe(
      `select d.id as dispositivo_id, e.* from dispositivos d join empleados e on e.id = d.empleado_id where d.llave_hash = $1 and d.activo`,
      [hashLlave(llave)],
    );
    if (!d) throw new ErrorNegocio('Este celular no está vinculado. Pida al administrador un código para vincularlo', 403, { motivo: 'no_vinculado' });
    if (d.estado !== 'activo') throw new ErrorNegocio('El empleado no está activo', 403);
    return d;
  }

  private async ultimaMarcacion(empleadoId: string) {
    return this.db.maybe(`select * from marcaciones where empleado_id = $1 and not anulada order by hora desc limit 1`, [empleadoId]);
  }

  private siguienteTipo(ultima: any): 'entrada' | 'salida' {
    if (!ultima || ultima.tipo === 'salida') return 'entrada';
    // Una entrada de hace más de 20 horas se considera olvidada: la siguiente es una entrada nueva.
    return Date.now() - new Date(ultima.hora).getTime() > 20 * 3600000 ? 'entrada' : 'salida';
  }

  async estadoMarcacion(d: { qr: string; llave: string }) {
    const { empresaId, sedeId, ctx } = await this.validarQr(d.qr);
    if (!ctx.configuracion.asistencia.activa) throw new ErrorNegocio('El control de asistencia está desactivado', 403);
    const e = await this.empleadoPorLlave(d.llave);
    if (e.empresa_id !== empresaId) throw new ErrorNegocio('Este código QR es de otra empresa', 403);
    const sede = await this.db.one('select nombre from sedes where id = $1', [sedeId]);
    const ultima = await this.ultimaMarcacion(e.id);
    return { empleado: `${e.nombres} ${e.apellidos}`, nombre: e.nombres, siguiente: this.siguienteTipo(ultima), sede: sede.nombre, ultima: ultima ? { tipo: ultima.tipo, hora: aLocal(ultima.hora) } : null };
  }

  private async registrar(
    e: { id: string; empresa_id: string },
    tipo: 'entrada' | 'salida',
    origen: 'qr' | 'kiosco' | 'asistida' | 'correccion' | 'importacion',
    extra: { sedeId?: string | null; dispositivoId?: string; kioscoId?: string; excepcion?: boolean; registradoPor?: string; motivo?: string; hora?: Date; reemplazaId?: string },
    minutosDuplicado: number,
  ) {
    const hora = extra.hora ?? new Date();
    if (origen === 'qr' || origen === 'kiosco') {
      const dup = await this.db.maybe(
        `select * from marcaciones where empleado_id = $1 and not anulada and hora > $2::timestamptz - make_interval(mins => $3) order by hora desc limit 1`,
        [e.id, hora, minutosDuplicado],
      );
      if (dup) return { ...camel<any>(dup), horaLocal: aLocal(dup.hora), duplicada: true };
    }
    const r = await this.db.one(
      `insert into marcaciones (empresa_id, empleado_id, tipo, hora, origen, sede_id, dispositivo_id, kiosco_id, excepcion, registrado_por, motivo, reemplaza_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning *`,
      [e.empresa_id, e.id, tipo, hora, origen, extra.sedeId ?? null, extra.dispositivoId ?? null, extra.kioscoId ?? null, !!extra.excepcion, extra.registradoPor ?? null, extra.motivo ?? null, extra.reemplazaId ?? null],
    );
    return { ...camel<any>(r), horaLocal: aLocal(r.hora), duplicada: false };
  }

  async marcar(d: { qr: string; llave: string }) {
    const { sedeId, ctx } = await this.validarQr(d.qr);
    const est = await this.estadoMarcacion(d);
    const e = await this.empleadoPorLlave(d.llave);
    const r = await this.registrar(e, est.siguiente, 'qr', { sedeId, dispositivoId: e.dispositivo_id }, ctx.configuracion.asistencia.minutosDuplicado);
    await this.db.exec('update dispositivos set ultimo_uso = now() where id = $1', [e.dispositivo_id]);
    return { ok: true, tipo: r.tipo, hora: r.horaLocal, empleado: est.empleado, duplicada: r.duplicada };
  }

  // ---------- Kiosco (HU-27, HU-28) ----------

  async kioscos(u: UsuarioSesion) {
    return camelLista(
      await this.db.many(
        `select k.id, k.nombre, k.sede_id, k.activo, k.vinculado_en, k.ultimo_uso, (k.llave_hash is not null) as vinculado, s.nombre as sede
         from kioscos k left join sedes s on s.id = k.sede_id where k.empresa_id = $1 order by k.nombre`,
        [u.empresaId],
      ),
    );
  }

  async crearKiosco(u: UsuarioSesion, d: { nombre: string; sedeId: string }) {
    const r = await this.db.one('insert into kioscos (empresa_id, sede_id, nombre) values ($1, $2, $3) returning *', [u.empresaId, d.sedeId, d.nombre]);
    await this.auditoria.registrar(u, 'crear', 'kiosco', r.id, null, r);
    return camel(r);
  }

  async borrarKiosco(u: UsuarioSesion, id: string) {
    const r = await this.db.maybe('update kioscos set activo = false, llave_hash = null where id = $1 and empresa_id = $2 returning *', [id, u.empresaId]);
    if (!r) throw new ErrorNegocio('Kiosco no encontrado', 404);
    await this.auditoria.registrar(u, 'desactivar', 'kiosco', id, r, null);
    return { ok: true };
  }

  async codigoKiosco(u: UsuarioSesion, kioscoId: string) {
    const k = await this.db.maybe('select * from kioscos where id = $1 and empresa_id = $2', [kioscoId, u.empresaId]);
    if (!k) throw new ErrorNegocio('Kiosco no encontrado', 404);
    const codigo = codigoSeisDigitos();
    const token = randomBytes(18).toString('base64url');
    const expira = new Date(Date.now() + 10 * 60000);
    await this.db.exec(`insert into codigos_vinculacion (empresa_id, tipo, kiosco_id, codigo, token, expira_en) values ($1, 'kiosco', $2, $3, $4, $5)`, [u.empresaId, kioscoId, codigo, token, expira]);
    return { codigo, token, expiraEn: expira.toISOString(), url: `${config().urlFrontend}/kiosco?c=${token}` };
  }

  async vincularKiosco(d: { codigo?: string; token?: string }) {
    const c = await this.buscarCodigo(d, 'kiosco');
    const llave = llaveDispositivo();
    const k = await this.db.one(`update kioscos set llave_hash = $2, vinculado_en = now(), activo = true where id = $1 returning *`, [c.kiosco_id, hashLlave(llave)]);
    await this.db.exec('update codigos_vinculacion set usado_en = now() where id = $1', [c.id]);
    await this.auditoria.registrar(null, 'vincular_kiosco', 'kiosco', k.id, null, null, { empresaId: k.empresa_id });
    return { llave, kiosco: k.nombre };
  }

  private async kioscoPorLlave(llave: string) {
    const k = await this.db.maybe('select k.*, s.nombre as sede from kioscos k left join sedes s on s.id = k.sede_id where k.llave_hash = $1 and k.activo', [hashLlave(llave)]);
    if (!k) throw new ErrorNegocio('Este equipo no está vinculado como kiosco', 403, { motivo: 'kiosco_no_vinculado' });
    return k;
  }

  async infoKiosco(llave: string) {
    const k = await this.kioscoPorLlave(llave);
    return { kiosco: k.nombre, sede: k.sede, hora: aLocal(new Date()) };
  }

  private async identificarEnKiosco(d: { llave: string; documento: string; pin: string }) {
    const k = await this.kioscoPorLlave(d.llave);
    const ctx = await this.contexto.cargar(k.empresa_id);
    if (!ctx.configuracion.asistencia.activa) throw new ErrorNegocio('El control de asistencia está desactivado', 403);
    const e = await this.db.maybe(`select * from empleados where empresa_id = $1 and numero_documento = $2 and estado = 'activo'`, [k.empresa_id, d.documento.trim()]);
    if (!e || !e.pin_hash) throw new ErrorNegocio('Cédula o PIN incorrectos', 401);
    if (e.pin_bloqueado) throw new ErrorNegocio('Su PIN está bloqueado por intentos fallidos. Pida al administrador que lo restablezca', 423);
    if (!(await bcrypt.compare(d.pin, e.pin_hash))) {
      const intentos = e.pin_intentos + 1;
      const max = ctx.configuracion.asistencia.intentosPin;
      await this.db.exec('update empleados set pin_intentos = $2, pin_bloqueado = $3 where id = $1', [e.id, intentos, intentos >= max]);
      throw new ErrorNegocio(intentos >= max ? 'PIN bloqueado por intentos fallidos. Pida al administrador que lo restablezca' : 'Cédula o PIN incorrectos', intentos >= max ? 423 : 401);
    }
    if (e.pin_intentos) await this.db.exec('update empleados set pin_intentos = 0 where id = $1', [e.id]);
    let excepcion = false;
    if (!e.marca_en_kiosco) {
      if (!ctx.configuracion.asistencia.permitirExcepcionKiosco)
        throw new ErrorNegocio('Usted marca con su celular. Solo los casos especiales marcan en el kiosco', 403);
      excepcion = true;
    } else if (e.kiosco_id && e.kiosco_id !== k.id) throw new ErrorNegocio('Usted está asignado a otro kiosco', 403);
    return { k, e, ctx, excepcion };
  }

  async identificarKiosco(d: { llave: string; documento: string; pin: string }) {
    const { e, excepcion } = await this.identificarEnKiosco(d);
    const ultima = await this.ultimaMarcacion(e.id);
    return { empleado: nombreCompleto(e), siguiente: this.siguienteTipo(ultima), excepcion };
  }

  async marcarKiosco(d: { llave: string; documento: string; pin: string }) {
    const { k, e, ctx, excepcion } = await this.identificarEnKiosco(d);
    const tipo = this.siguienteTipo(await this.ultimaMarcacion(e.id));
    const r = await this.registrar(e, tipo, 'kiosco', { sedeId: k.sede_id, kioscoId: k.id, excepcion }, ctx.configuracion.asistencia.minutosDuplicado);
    await this.db.exec('update kioscos set ultimo_uso = now() where id = $1', [k.id]);
    return { ok: true, tipo: r.tipo, hora: r.horaLocal, empleado: nombreCompleto(e), excepcion, duplicada: r.duplicada };
  }

  async cambiarPinKiosco(d: { llave: string; documento: string; pin: string; nuevo: string }) {
    if (!/^\d{4}$/.test(d.nuevo)) throw new ErrorNegocio('El PIN nuevo debe tener 4 números');
    const { e } = await this.identificarEnKiosco(d);
    await this.db.exec('update empleados set pin_hash = $2 where id = $1', [e.id, await bcrypt.hash(d.nuevo, 8)]);
    return { ok: true };
  }

  // ---------- Marcación asistida y correcciones (HU-29, HU-30) ----------

  async marcacionAsistida(u: UsuarioSesion, d: { empleadoId: string; tipo?: 'entrada' | 'salida'; hora?: string; motivo: string; sedeId?: string | null }) {
    const e = await this.db.maybe(`select * from empleados where id = $1 and empresa_id = $2 and estado = 'activo'`, [d.empleadoId, u.empresaId]);
    if (!e) throw new ErrorNegocio('Empleado no encontrado', 404);
    const tipo = d.tipo ?? this.siguienteTipo(await this.ultimaMarcacion(e.id));
    const r = await this.registrar(e, tipo, 'asistida', { registradoPor: u.id, motivo: d.motivo, hora: d.hora ? desdeLocal(d.hora) : undefined, sedeId: d.sedeId ?? e.sede_id }, 0);
    await this.auditoria.registrar(u, 'marcacion_asistida', 'marcacion', r.id, null, r, { motivo: d.motivo });
    return r;
  }

  async corregir(u: UsuarioSesion, d: { empleadoId: string; marcacionId?: string | null; tipo: 'entrada' | 'salida'; hora: string; motivo: string }) {
    const e = await this.db.maybe('select * from empleados where id = $1 and empresa_id = $2', [d.empleadoId, u.empresaId]);
    if (!e) throw new ErrorNegocio('Empleado no encontrado', 404);
    let original: any = null;
    if (d.marcacionId) {
      original = await this.db.maybe('select * from marcaciones where id = $1 and empleado_id = $2', [d.marcacionId, d.empleadoId]);
      if (!original) throw new ErrorNegocio('Marcación no encontrada', 404);
      await this.db.exec('update marcaciones set anulada = true where id = $1', [original.id]);
    }
    const r = await this.registrar(e, d.tipo, 'correccion', { registradoPor: u.id, motivo: d.motivo, hora: desdeLocal(d.hora), reemplazaId: original?.id, sedeId: original?.sede_id ?? e.sede_id }, 0);
    await this.auditoria.registrar(u, 'corregir_marcacion', 'marcacion', r.id, original, r, { motivo: d.motivo });
    return r;
  }

  async anular(u: UsuarioSesion, id: string, motivo: string) {
    const r = await this.db.maybe('update marcaciones set anulada = true, motivo = coalesce(motivo, $3) where id = $1 and empresa_id = $2 returning *', [id, u.empresaId, motivo]);
    if (!r) throw new ErrorNegocio('Marcación no encontrada', 404);
    await this.auditoria.registrar(u, 'anular_marcacion', 'marcacion', id, r, null, { motivo });
    return { ok: true };
  }

  async listarMarcaciones(u: UsuarioSesion, q: { desde?: string; hasta?: string; empleadoId?: string; incluirAnuladas?: string }) {
    const desde = q.desde ?? fechaLocal();
    const hasta = q.hasta ?? desde;
    const filas = await this.db.many(
      `select m.*, e.nombres, e.apellidos, e.numero_documento, s.nombre as sede, k.nombre as kiosco, us.nombre as registrado_por_nombre
       from marcaciones m join empleados e on e.id = m.empleado_id left join sedes s on s.id = m.sede_id left join kioscos k on k.id = m.kiosco_id
       left join usuarios us on us.id = m.registrado_por
       where m.empresa_id = $1 and m.hora >= $2 and m.hora < $3 and ($4::uuid is null or m.empleado_id = $4) and ($5 or not m.anulada)
       order by m.hora`,
      [u.empresaId, desdeLocal(`${desde}T00:00`), desdeLocal(`${sumarDias(hasta, 1)}T00:00`), q.empleadoId || null, q.incluirAnuladas === 'true'],
    );
    return filas.map((f) => ({ ...camel<any>(f), horaLocal: aLocal(f.hora) }));
  }

  /** Resumen de hoy para el panel (presentes, tarde, sin marcar). */
  async hoy(u: UsuarioSesion) {
    const hoy = fechaLocal();
    const ctx = await this.contexto.cargar(u.empresaId);
    const empleados = await this.db.many(`select e.id, e.nombres, e.apellidos, e.turno_id, t.dias from empleados e left join turnos t on t.id = e.turno_id where e.empresa_id = $1 and e.estado = 'activo'`, [u.empresaId]);
    const marcas = await this.listarMarcaciones(u, { desde: hoy, hasta: hoy });
    const ds = new Date(`${hoy}T12:00:00Z`).getUTCDay();
    const tol = ctx.configuracion.horas.toleranciaMinutos;
    const ahora = aLocal(new Date()).slice(11, 16);
    const res = { presentes: 0, salieron: 0, tarde: 0, sinMarcar: 0, programados: 0, porKiosco: 0, asistidas: 0, detalle: [] as any[] };
    for (const e of empleados) {
      const franjas = ((e.dias ?? {}) as Record<string, { inicio: string }[]>)[String(ds)] ?? [];
      const programado = franjas.length > 0 && !ctx.festivos.includes(hoy);
      if (programado) res.programados++;
      const m = marcas.filter((x: any) => x.empleadoId === e.id);
      const primera = m.find((x: any) => x.tipo === 'entrada');
      const ultima = m[m.length - 1];
      let estado = 'sin_turno';
      if (ultima?.tipo === 'entrada') estado = 'presente';
      else if (ultima?.tipo === 'salida') estado = 'salio';
      else if (programado && franjas[0].inicio <= ahora) estado = 'sin_marcar';
      else if (programado) estado = 'programado';
      const tarde = !!(primera && programado && minutos(primera.horaLocal.slice(11, 16)) - minutos(franjas[0].inicio) > tol);
      if (estado === 'presente') res.presentes++;
      if (estado === 'salio') res.salieron++;
      if (estado === 'sin_marcar') res.sinMarcar++;
      if (tarde) res.tarde++;
      if (m.some((x: any) => x.origen === 'kiosco')) res.porKiosco++;
      if (m.some((x: any) => x.origen === 'asistida')) res.asistidas++;
      res.detalle.push({ empleadoId: e.id, empleado: nombreCompleto(e), estado, tarde, entrada: primera?.horaLocal?.slice(11, 16) ?? null, inicioTurno: franjas[0]?.inicio ?? null });
    }
    return res;
  }

  // ---------- Cálculo y aprobación de horas (HU-31, HU-32) ----------

  async procesar(u: UsuarioSesion, d: { desde: string; hasta: string; empleadoId?: string | null }) {
    const ctx = await this.contexto.cargar(u.empresaId);
    const empleados = await this.db.many(
      `select e.*, t.dias as turno_dias, t.nombre as turno_nombre from empleados e left join turnos t on t.id = e.turno_id
       where e.empresa_id = $1 and e.estado = 'activo' and ($2::uuid is null or e.id = $2)`,
      [u.empresaId, d.empleadoId ?? null],
    );
    const resumen = { procesados: 0, sinTurno: [] as string[], incompletas: [] as any[], alertas: 0 };
    for (const e of empleados) {
      if (!e.turno_dias) {
        resumen.sinTurno.push(nombreCompleto(e));
        continue;
      }
      const marcas = await this.db.many(
        `select tipo, hora from marcaciones where empleado_id = $1 and not anulada and hora >= $2 and hora < $3 order by hora`,
        [e.id, desdeLocal(`${sumarDias(d.desde, -1)}T00:00`), desdeLocal(`${sumarDias(d.hasta, 2)}T00:00`)],
      );
      const { intervalos, incompletas } = emparejarMarcaciones(marcas.map((m) => ({ tipo: m.tipo, hora: aLocal(m.hora) })));
      for (const i of incompletas) if (i.hora.slice(0, 10) >= d.desde && i.hora.slice(0, 10) <= d.hasta) resumen.incompletas.push({ empleado: nombreCompleto(e), ...i });
      const dentro = intervalos.filter((iv) => iv.entrada.slice(0, 10) >= d.desde && iv.entrada.slice(0, 10) <= d.hasta);
      const cal = await this.contexto.calendarioEmpleado(ctx, e.id);
      const cls = new ClasificadorHoras(cal, this.contexto.configHoras(ctx, d.hasta));
      const turno: Turno = { dias: Object.fromEntries(Object.entries(e.turno_dias).map(([k, v]) => [Number(k), v as any])) };
      const r = cls.clasificar(dentro, turno);
      await this.db.tx(async (cl) => {
        await this.db.exec(
          `delete from horas_registradas where empleado_id = $1 and origen = 'asistencia' and estado = 'pendiente' and fecha between $2 and $3`,
          [e.id, d.desde, d.hasta],
          cl,
        );
        for (const f of rango(d.desde, d.hasta)) {
          const m = r.porFecha[f];
          if (!m) continue;
          for (const t of TIPOS_HORA) {
            if (!m[t]) continue;
            await this.db.exec(
              `insert into horas_registradas (empresa_id, empleado_id, fecha, tipo, horas, origen, estado) values ($1, $2, $3, $4, $5, 'asistencia', $6)
               on conflict (empleado_id, fecha, tipo, origen) do nothing`,
              [u.empresaId, e.id, f, t, aHoras(m[t]), t === 'HOD' ? 'aprobada' : 'pendiente'],
              cl,
            );
          }
        }
        await this.db.exec('delete from alertas_asistencia where empleado_id = $1 and fecha between $2 and $3', [e.id, d.desde, d.hasta], cl);
        for (const a of r.alertas)
          await this.db.exec(
            `insert into alertas_asistencia (empresa_id, empleado_id, fecha, tipo, minutos, mensaje) values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
            [u.empresaId, e.id, a.fecha, a.tipo, a.minutos, a.mensaje],
            cl,
          );
      });
      resumen.alertas += r.alertas.length;
      resumen.procesados++;
    }
    await this.auditoria.registrar(u, 'procesar_asistencia', 'asistencia', null, null, { ...d, procesados: resumen.procesados });
    return resumen;
  }

  async horas(u: UsuarioSesion, q: { desde?: string; hasta?: string; estado?: string; empleadoId?: string; incluirOrdinarias?: string }) {
    const desde = q.desde ?? sumarDias(fechaLocal(), -30);
    const hasta = q.hasta ?? fechaLocal();
    return camelLista(
      await this.db.many(
        `select h.*, e.nombres, e.apellidos, e.numero_documento, us.nombre as aprobado_por_nombre
         from horas_registradas h join empleados e on e.id = h.empleado_id left join usuarios us on us.id = h.aprobado_por
         where h.empresa_id = $1 and h.fecha between $2 and $3 and ($4::text is null or h.estado = $4) and ($5::uuid is null or h.empleado_id = $5)
           and ($6 or h.tipo <> 'HOD')
         order by h.fecha, e.apellidos, h.tipo`,
        [u.empresaId, desde, hasta, q.estado || null, q.empleadoId || null, q.incluirOrdinarias === 'true'],
      ),
    );
  }

  async alertas(u: UsuarioSesion, q: { desde?: string; hasta?: string }) {
    const desde = q.desde ?? sumarDias(fechaLocal(), -30);
    const hasta = q.hasta ?? fechaLocal();
    return camelLista(
      await this.db.many(
        `select a.*, e.nombres, e.apellidos from alertas_asistencia a join empleados e on e.id = a.empleado_id
         where a.empresa_id = $1 and a.fecha between $2 and $3 order by a.fecha desc`,
        [u.empresaId, desde, hasta],
      ),
    );
  }

  async aprobarHoras(u: UsuarioSesion, d: { ids: string[]; aprobar: boolean; actividad?: string }) {
    const n = await this.db.exec(
      `update horas_registradas set estado = $3, aprobado_por = $4, aprobado_en = now(), actividad = coalesce($5, actividad)
       where empresa_id = $1 and id = any($2::uuid[])`,
      [u.empresaId, d.ids, d.aprobar ? 'aprobada' : 'rechazada', u.id, d.actividad ?? null],
    );
    await this.auditoria.registrar(u, d.aprobar ? 'aprobar_horas' : 'rechazar_horas', 'horas', null, null, { ids: d.ids });
    return { actualizadas: n };
  }

  async plantillaHoras(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Horas');
    ws.columns = [
      { header: 'documento', key: 'documento', width: 16 },
      { header: 'fecha (AAAA-MM-DD)', key: 'fecha', width: 18 },
      { header: 'tipo', key: 'tipo', width: 10 },
      { header: 'horas', key: 'horas', width: 10 },
      { header: 'actividad', key: 'actividad', width: 30 },
    ];
    ws.addRow({ documento: '1012345678', fecha: '2026-10-28', tipo: 'HED', horas: 2, actividad: 'Inventario' });
    const ayuda = wb.addWorksheet('Tipos de hora');
    ayuda.addRows([['tipo', 'significado'], ['HON', 'Recargo nocturno'], ['HED', 'Extra diurna'], ['HEN', 'Extra nocturna'], ['HDD', 'Día de descanso diurna'], ['HDN', 'Día de descanso nocturna'], ['HEDD', 'Extra diurna en descanso'], ['HEND', 'Extra nocturna en descanso']]);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  /** Importa horas desde Excel (HU-32). Con confirmar = false solo valida. */
  async importarHoras(u: UsuarioSesion, d: { archivoBase64: string; confirmar: boolean }) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(d.archivoBase64, 'base64') as any);
    const ws = wb.worksheets[0];
    if (!ws) throw new ErrorNegocio('El archivo no tiene hojas');
    const errores: { fila: number; mensaje: string }[] = [];
    const validas: { empleadoId: string; fecha: string; tipo: string; horas: string; actividad: string | null }[] = [];
    const empleados = new Map((await this.db.many('select id, numero_documento from empleados where empresa_id = $1', [u.empresaId])).map((e) => [e.numero_documento, e.id]));
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const celda = (i: number) => {
        const v = row.getCell(i).value as any;
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        return v === null || v === undefined ? '' : String(v?.result ?? v?.text ?? v).trim();
      };
      const [documento, fecha, tipo, horas, actividad] = [celda(1), celda(2), celda(3).toUpperCase(), celda(4).replace(',', '.'), celda(5)];
      if (!documento && !fecha) return;
      const empleadoId = empleados.get(documento);
      if (!empleadoId) return errores.push({ fila: n, mensaje: `No existe un empleado con documento ${documento}` });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return errores.push({ fila: n, mensaje: 'La fecha debe tener formato AAAA-MM-DD' });
      if (!(TIPOS_HORA as string[]).includes(tipo) || tipo === 'HOD') return errores.push({ fila: n, mensaje: `Tipo de hora no válido: ${tipo}` });
      if (!/^\d+(\.\d+)?$/.test(horas) || Number(horas) <= 0 || Number(horas) > 24) return errores.push({ fila: n, mensaje: 'Las horas deben ser un número entre 0 y 24' });
      validas.push({ empleadoId, fecha, tipo, horas, actividad: actividad || null });
    });
    if (!d.confirmar || validas.length === 0) return { validas: validas.length, errores, importadas: 0 };
    for (const v of validas)
      await this.db.exec(
        `insert into horas_registradas (empresa_id, empleado_id, fecha, tipo, horas, origen, estado, actividad) values ($1, $2, $3, $4, $5, 'importacion', 'pendiente', $6)
         on conflict (empleado_id, fecha, tipo, origen) do update set horas = excluded.horas, actividad = excluded.actividad, estado = 'pendiente'`,
        [u.empresaId, v.empleadoId, v.fecha, v.tipo, v.horas, v.actividad],
      );
    await this.auditoria.registrar(u, 'importar_horas', 'horas', null, null, { importadas: validas.length, errores: errores.length });
    return { validas: validas.length, errores, importadas: validas.length };
  }

  /** Registro de trabajo suplementario por empleado (CST art. 162 num. 2). */
  async registroExtras(u: UsuarioSesion, empleadoId: string, desde: string, hasta: string) {
    const e = await this.db.maybe('select * from empleados where id = $1 and empresa_id = $2', [empleadoId, u.empresaId]);
    if (!e) throw new ErrorNegocio('Empleado no encontrado', 404);
    const filas = await this.db.many(
      `select fecha, tipo, horas, actividad from horas_registradas where empleado_id = $1 and estado = 'aprobada' and tipo <> 'HOD' and fecha between $2 and $3 order by fecha, tipo`,
      [empleadoId, desde, hasta],
    );
    const nocturnas = new Set(['HON', 'HEN', 'HDN', 'HEND']);
    return {
      empleado: nombreCompleto(e),
      documento: e.numero_documento,
      cargo: e.cargo,
      desde,
      hasta,
      registros: filas.map((f) => ({ fecha: f.fecha, tipo: f.tipo, jornada: nocturnas.has(f.tipo) ? 'nocturna' : 'diurna', horas: f.horas, actividad: f.actividad ?? e.cargo ?? '' })),
      totalHoras: filas.reduce((a, f) => a + Number(f.horas), 0),
    };
  }
}

const minutos = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

@Controller('asistencia')
export class AsistenciaController {
  constructor(private readonly s: AsistenciaService) {}

  @Get('sedes/:sedeId/qr')
  qr(@Usuario() u: UsuarioSesion, @Param('sedeId') sedeId: string) {
    return this.s.qrSede(u, sedeId);
  }

  @Post('empleados/:id/vincular')
  vincular(@Usuario() u: UsuarioSesion, @Param('id') id: string) {
    return this.s.generarVinculacion(u, id);
  }

  @Get('dispositivos')
  dispositivos(@Usuario() u: UsuarioSesion) {
    return this.s.dispositivos(u);
  }

  @Delete('dispositivos/:id')
  desvincular(@Usuario() u: UsuarioSesion, @Param('id') id: string) {
    return this.s.desvincular(u, id);
  }

  @Get('kioscos')
  kioscos(@Usuario() u: UsuarioSesion) {
    return this.s.kioscos(u);
  }

  @Post('kioscos')
  crearKiosco(@Usuario() u: UsuarioSesion, @Body(new Validar(z.object({ nombre: z.string().min(1), sedeId: z.string().uuid() }))) d: { nombre: string; sedeId: string }) {
    return this.s.crearKiosco(u, d);
  }

  @Post('kioscos/:id/vincular')
  codigoKiosco(@Usuario() u: UsuarioSesion, @Param('id') id: string) {
    return this.s.codigoKiosco(u, id);
  }

  @Delete('kioscos/:id')
  borrarKiosco(@Usuario() u: UsuarioSesion, @Param('id') id: string) {
    return this.s.borrarKiosco(u, id);
  }

  @Post('marcaciones')
  asistida(
    @Usuario() u: UsuarioSesion,
    @Body(new Validar(z.object({ empleadoId: z.string().uuid(), tipo: z.enum(['entrada', 'salida']).optional(), hora: zHoraLocal.optional(), motivo: z.string().min(3, 'Escriba el motivo'), sedeId: z.string().uuid().optional().nullable() })))
    d: any,
  ) {
    return this.s.marcacionAsistida(u, d);
  }

  @Post('correcciones')
  corregir(
    @Usuario() u: UsuarioSesion,
    @Body(new Validar(z.object({ empleadoId: z.string().uuid(), marcacionId: z.string().uuid().optional().nullable(), tipo: z.enum(['entrada', 'salida']), hora: zHoraLocal, motivo: z.string().min(3, 'Escriba el motivo') })))
    d: any,
  ) {
    return this.s.corregir(u, d);
  }

  @Post('marcaciones/:id/anular')
  anular(@Usuario() u: UsuarioSesion, @Param('id') id: string, @Body(new Validar(z.object({ motivo: z.string().min(3) }))) d: { motivo: string }) {
    return this.s.anular(u, id, d.motivo);
  }

  @Get('marcaciones')
  marcaciones(@Usuario() u: UsuarioSesion, @Query() q: any) {
    return this.s.listarMarcaciones(u, q);
  }

  @Get('hoy')
  hoy(@Usuario() u: UsuarioSesion) {
    return this.s.hoy(u);
  }

  @Post('procesar')
  procesar(@Usuario() u: UsuarioSesion, @Body(new Validar(z.object({ desde: zFecha, hasta: zFecha, empleadoId: z.string().uuid().optional().nullable() }))) d: any) {
    return this.s.procesar(u, d);
  }

  @Get('horas')
  horas(@Usuario() u: UsuarioSesion, @Query() q: any) {
    return this.s.horas(u, q);
  }

  @Get('alertas')
  alertas(@Usuario() u: UsuarioSesion, @Query() q: any) {
    return this.s.alertas(u, q);
  }

  @Post('horas/aprobar')
  aprobar(@Usuario() u: UsuarioSesion, @Body(new Validar(z.object({ ids: z.array(z.string().uuid()).min(1), aprobar: z.boolean(), actividad: z.string().optional() }))) d: any) {
    return this.s.aprobarHoras(u, d);
  }

  @Get('horas/plantilla')
  async plantilla() {
    return { nombre: 'plantilla-horas.xlsx', archivoBase64: (await this.s.plantillaHoras()).toString('base64') };
  }

  @Post('horas/importar')
  importar(@Usuario() u: UsuarioSesion, @Body(new Validar(z.object({ archivoBase64: z.string().min(10), confirmar: z.boolean().default(false) }))) d: any) {
    return this.s.importarHoras(u, d);
  }

  @Get('registro-extras/:empleadoId')
  registro(@Usuario() u: UsuarioSesion, @Param('empleadoId') id: string, @Query('desde') desde: string, @Query('hasta') hasta: string) {
    return this.s.registroExtras(u, id, desde ?? sumarDias(fechaLocal(), -30), hasta ?? fechaLocal());
  }
}

/** Rutas sin sesión: las usan el celular del empleado y el kiosco. */
@Publico()
@Controller('publico')
export class PublicoAsistenciaController {
  constructor(private readonly s: AsistenciaService) {}

  @Get('vincular/:token')
  info(@Param('token') token: string) {
    return this.s.infoVinculacion(token);
  }

  @Post('vincular')
  vincular(
    @Body(new Validar(z.object({ token: z.string().optional(), codigo: z.string().regex(/^\d{6}$/).optional(), documento: z.string().min(3), aceptaDatos: z.boolean(), descripcion: z.string().max(300).optional(), llaveActual: z.string().optional() })))
    d: any,
    @Ip() ip: string,
  ) {
    if (!d.token && !d.codigo) throw new ErrorNegocio('Escriba el código de vinculación');
    return this.s.vincular(d, ip);
  }

  @Post('marcar/estado')
  estado(@Body(new Validar(z.object({ qr: z.string().min(5), llave: z.string().min(10) }))) d: any) {
    return this.s.estadoMarcacion(d);
  }

  @Post('marcar')
  marcar(@Body(new Validar(z.object({ qr: z.string().min(5), llave: z.string().min(10) }))) d: any) {
    return this.s.marcar(d);
  }

  @Post('kiosco/vincular')
  vincularKiosco(@Body(new Validar(z.object({ codigo: z.string().optional(), token: z.string().optional() }))) d: any) {
    return this.s.vincularKiosco(d);
  }

  @Post('kiosco/info')
  infoKiosco(@Body(new Validar(z.object({ llave: z.string().min(10) }))) d: { llave: string }) {
    return this.s.infoKiosco(d.llave);
  }

  @Post('kiosco/identificar')
  identificar(@Body(new Validar(z.object({ llave: z.string().min(10), documento: z.string().min(3), pin: z.string().regex(/^\d{4}$/, 'El PIN tiene 4 números') }))) d: any) {
    return this.s.identificarKiosco(d);
  }

  @Post('kiosco/marcar')
  marcarKiosco(@Body(new Validar(z.object({ llave: z.string().min(10), documento: z.string().min(3), pin: z.string().regex(/^\d{4}$/) }))) d: any) {
    return this.s.marcarKiosco(d);
  }

  @Post('kiosco/cambiar-pin')
  cambiarPin(@Body(new Validar(z.object({ llave: z.string().min(10), documento: z.string().min(3), pin: z.string().regex(/^\d{4}$/), nuevo: z.string() }))) d: any) {
    return this.s.cambiarPinKiosco(d);
  }
}
