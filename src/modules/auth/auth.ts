import { Body, Controller, Get, Injectable, Param, Patch, Post } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { AuditoriaService } from '../../common/auditoria.service';
import { ErrorNegocio, Ip, Publico, Roles, Usuario, UsuarioSesion, Validar } from '../../common/comun';
import { camel, camelLista } from '../../common/util';
import { config } from '../../config';
import { Db } from '../../db/db.service';

const LoginDto = z.object({ usuario: z.string().trim().min(1, 'Escriba su usuario'), password: z.string().min(1, 'Escriba su contraseña') });
const CambioDto = z.object({ actual: z.string().min(1), nueva: z.string().min(8, 'La nueva contraseña debe tener al menos 8 caracteres') });
const UsuarioDto = z.object({
  usuario: z.string().trim().min(3),
  nombre: z.string().trim().min(1),
  correo: z.string().email().optional().nullable(),
  rol: z.enum(['superusuario', 'analista', 'contador', 'aprobador', 'supervisor']),
  password: z.string().min(8),
});
const UsuarioEditarDto = UsuarioDto.partial().extend({ activo: z.boolean().optional() });

@Injectable()
export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly jwt: JwtService,
    private readonly auditoria: AuditoriaService,
  ) {}

  async login(usuario: string, password: string, ip: string) {
    const u = await this.db.maybe(
      `select u.*, e.configuracion from usuarios u join empresas e on e.id = u.empresa_id where lower(u.usuario) = lower($1)`,
      [usuario],
    );
    const seg = u?.configuracion?.seguridad ?? {};
    const maxIntentos = Number(seg.intentosLogin ?? 5);
    const minutos = Number(seg.minutosBloqueo ?? 15);
    if (!u || !u.activo) throw new ErrorNegocio('Usuario o contraseña incorrectos', 401);
    if (u.bloqueado_hasta && new Date(u.bloqueado_hasta) > new Date())
      throw new ErrorNegocio(`La cuenta está bloqueada por intentos fallidos. Intente de nuevo en ${minutos} minutos`, 423);
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) {
      const intentos = u.intentos_fallidos + 1;
      const bloquear = intentos >= maxIntentos;
      await this.db.exec(
        `update usuarios set intentos_fallidos = $2, bloqueado_hasta = $3 where id = $1`,
        [u.id, bloquear ? 0 : intentos, bloquear ? new Date(Date.now() + minutos * 60000) : null],
      );
      await this.auditoria.registrar(null, 'login_fallido', 'usuario', u.id, null, { intentos }, { ip, empresaId: u.empresa_id });
      if (bloquear) throw new ErrorNegocio(`Demasiados intentos. La cuenta quedó bloqueada ${minutos} minutos`, 423);
      throw new ErrorNegocio('Usuario o contraseña incorrectos', 401);
    }
    await this.db.exec(`update usuarios set intentos_fallidos = 0, bloqueado_hasta = null, ultimo_acceso = now() where id = $1`, [u.id]);
    const sesion: UsuarioSesion = { id: u.id, empresaId: u.empresa_id, usuario: u.usuario, nombre: u.nombre, rol: u.rol };
    await this.auditoria.registrar(sesion, 'login', 'usuario', u.id, null, null, { ip });
    return {
      token: this.jwt.sign(sesion, { expiresIn: `${config().jwtHoras}h` }),
      usuario: { ...sesion, debeCambiarPassword: u.debe_cambiar_password },
      minutosSesion: Number(seg.minutosSesion ?? 30),
    };
  }

  async yo(u: UsuarioSesion) {
    const r = await this.db.one(
      `select u.id, u.usuario, u.nombre, u.correo, u.rol, u.debe_cambiar_password, u.ultimo_acceso,
              e.id as empresa_id, e.razon_social, e.nit, e.asistente_completado, e.asistente_paso, e.configuracion
       from usuarios u join empresas e on e.id = u.empresa_id where u.id = $1`,
      [u.id],
    );
    return camel(r);
  }

  async cambiarPassword(u: UsuarioSesion, actual: string, nueva: string) {
    const r = await this.db.one('select password_hash from usuarios where id = $1', [u.id]);
    if (!(await bcrypt.compare(actual, r.password_hash))) throw new ErrorNegocio('La contraseña actual no es correcta');
    if (actual === nueva) throw new ErrorNegocio('La nueva contraseña debe ser distinta de la actual');
    await this.db.exec('update usuarios set password_hash = $2, debe_cambiar_password = false where id = $1', [u.id, await bcrypt.hash(nueva, 10)]);
    await this.auditoria.registrar(u, 'cambiar_password', 'usuario', u.id, null, null);
    return { ok: true };
  }

  async listar(u: UsuarioSesion) {
    return camelLista(
      await this.db.many(
        'select id, usuario, nombre, correo, rol, activo, ultimo_acceso, creado_en from usuarios where empresa_id = $1 order by nombre',
        [u.empresaId],
      ),
    );
  }

  async crear(u: UsuarioSesion, d: z.infer<typeof UsuarioDto>) {
    const r = await this.db.one(
      `insert into usuarios (empresa_id, usuario, nombre, correo, rol, password_hash, debe_cambiar_password)
       values ($1, $2, $3, $4, $5, $6, true) returning id, usuario, nombre, correo, rol, activo`,
      [u.empresaId, d.usuario, d.nombre, d.correo ?? null, d.rol, await bcrypt.hash(d.password, 10)],
    );
    await this.auditoria.registrar(u, 'crear', 'usuario', r.id, null, r);
    return camel(r);
  }

  async editar(u: UsuarioSesion, id: string, d: z.infer<typeof UsuarioEditarDto>) {
    const antes = await this.db.maybe('select id, usuario, nombre, correo, rol, activo from usuarios where id = $1 and empresa_id = $2', [id, u.empresaId]);
    if (!antes) throw new ErrorNegocio('Usuario no encontrado', 404);
    if (id === u.id && (d.activo === false || (d.rol && d.rol !== 'superusuario')))
      throw new ErrorNegocio('No puede desactivarse ni quitarse el rol de superusuario a sí mismo');
    const r = await this.db.one(
      `update usuarios set usuario = coalesce($3, usuario), nombre = coalesce($4, nombre), correo = coalesce($5, correo),
         rol = coalesce($6, rol), activo = coalesce($7, activo),
         password_hash = coalesce($8, password_hash)
       where id = $1 and empresa_id = $2 returning id, usuario, nombre, correo, rol, activo`,
      [id, u.empresaId, d.usuario ?? null, d.nombre ?? null, d.correo ?? null, d.rol ?? null, d.activo ?? null, d.password ? await bcrypt.hash(d.password, 10) : null],
    );
    await this.auditoria.registrar(u, 'editar', 'usuario', id, antes, r);
    return camel(r);
  }
}

@Controller('auth')
export class AuthController {
  constructor(private readonly s: AuthService) {}

  @Publico()
  @Post('login')
  login(@Body(new Validar(LoginDto)) d: z.infer<typeof LoginDto>, @Ip() ip: string) {
    return this.s.login(d.usuario, d.password, ip);
  }

  @Get('yo')
  yo(@Usuario() u: UsuarioSesion) {
    return this.s.yo(u);
  }

  @Post('cambiar-password')
  cambiar(@Usuario() u: UsuarioSesion, @Body(new Validar(CambioDto)) d: z.infer<typeof CambioDto>) {
    return this.s.cambiarPassword(u, d.actual, d.nueva);
  }
}

@Controller('usuarios')
@Roles('superusuario')
export class UsuariosController {
  constructor(private readonly s: AuthService) {}

  @Get()
  listar(@Usuario() u: UsuarioSesion) {
    return this.s.listar(u);
  }

  @Post()
  crear(@Usuario() u: UsuarioSesion, @Body(new Validar(UsuarioDto)) d: z.infer<typeof UsuarioDto>) {
    return this.s.crear(u, d);
  }

  @Patch(':id')
  editar(@Usuario() u: UsuarioSesion, @Param('id') id: string, @Body(new Validar(UsuarioEditarDto)) d: z.infer<typeof UsuarioEditarDto>) {
    return this.s.editar(u, id, d);
  }
}
