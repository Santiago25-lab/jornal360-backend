import { Body, Controller, Get, Injectable, Param, Patch, Post } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { AuditoriaService } from '../../common/auditoria.service';
import { ErrorNegocio, Ip, Publico, SesionPlataforma, SoloPlataforma, Usuario, UsuarioSesion, Validar } from '../../common/comun';
import { errorEspacio } from '../../common/espacios';
import { camel, camelLista } from '../../common/util';
import { config } from '../../config';
import { Db } from '../../db/db.service';
import { festivosColombia } from '../../domain/festivos';
import { sqlSemilla } from '../../seed/semilla';

const zEspacio = z.string().trim().toLowerCase().refine((v) => !errorEspacio(v), (v) => ({ message: errorEspacio(v) ?? '' }));
const LoginDto = z.object({ usuario: z.string().trim().min(1, 'Escriba su usuario'), password: z.string().min(1, 'Escriba su contraseña') });
const EspacioDto = z.object({
  espacio: zEspacio,
  usuario: z.string().trim().min(3, 'El usuario debe tener al menos 3 caracteres'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
});
const PasswordDto = z.object({ password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres') });

/** Razón social provisional: la empresa pone la suya en el asistente de primeros pasos. */
const RAZON_PROVISIONAL = 'Mi empresa';
const MAX_INTENTOS = 5;
const MINUTOS_BLOQUEO = 15;

@Injectable()
export class PlataformaService {
  constructor(
    private readonly db: Db,
    private readonly jwt: JwtService,
    private readonly auditoria: AuditoriaService,
  ) {}

  async login(usuario: string, password: string, ip: string) {
    const a = await this.db.maybe('select * from administradores_plataforma where lower(usuario) = lower($1)', [usuario]);
    if (!a || !a.activo) throw new ErrorNegocio('Usuario o contraseña incorrectos', 401);
    if (a.bloqueado_hasta && new Date(a.bloqueado_hasta) > new Date())
      throw new ErrorNegocio(`La cuenta está bloqueada por intentos fallidos. Intente de nuevo en ${MINUTOS_BLOQUEO} minutos`, 423);
    if (!(await bcrypt.compare(password, a.password_hash))) {
      const intentos = a.intentos_fallidos + 1;
      const bloquear = intentos >= MAX_INTENTOS;
      await this.db.exec('update administradores_plataforma set intentos_fallidos = $2, bloqueado_hasta = $3 where id = $1', [
        a.id,
        bloquear ? 0 : intentos,
        bloquear ? new Date(Date.now() + MINUTOS_BLOQUEO * 60000) : null,
      ]);
      if (bloquear) throw new ErrorNegocio(`Demasiados intentos. La cuenta quedó bloqueada ${MINUTOS_BLOQUEO} minutos`, 423);
      throw new ErrorNegocio('Usuario o contraseña incorrectos', 401);
    }
    await this.db.exec('update administradores_plataforma set intentos_fallidos = 0, bloqueado_hasta = null, ultimo_acceso = now() where id = $1', [a.id]);
    const sesion: SesionPlataforma = { tipo: 'plataforma', id: a.id, usuario: a.usuario, nombre: a.nombre };
    void ip;
    return { token: this.jwt.sign(sesion, { expiresIn: `${config().jwtHoras}h` }), administrador: sesion };
  }

  async espacios() {
    return camelLista(
      await this.db.many(
        `select e.id, e.espacio, e.razon_social, e.nit, e.asistente_completado, e.creado_en,
                (select count(*)::int from empleados x where x.empresa_id = e.id and x.estado = 'activo') as empleados,
                (select count(*)::int from usuarios x where x.empresa_id = e.id and x.activo) as usuarios,
                (select max(x.ultimo_acceso) from usuarios x where x.empresa_id = e.id) as ultimo_acceso
         from empresas e order by e.creado_en`,
      ),
    );
  }

  /** Crea un espacio nuevo con su catálogo legal y su primer superusuario. */
  async crear(p: SesionPlataforma, d: z.infer<typeof EspacioDto>) {
    if (await this.db.maybe('select 1 from empresas where lower(espacio) = $1', [d.espacio])) throw new ErrorNegocio(`Ya existe un espacio llamado "${d.espacio}"`, 409);
    const id = randomUUID();
    const anio = new Date().getUTCFullYear();
    const hash = await bcrypt.hash(d.password, 10);
    await this.db.tx(async (c) => {
      await c.query(
        sqlSemilla({
          empresaId: id,
          espacio: d.espacio,
          razonSocial: RAZON_PROVISIONAL,
          nit: '',
          usuario: d.usuario,
          nombreUsuario: d.usuario,
          passwordHashSql: `'${hash.replace(/'/g, "''")}'`,
          debeCambiarPassword: false,
          aniosFestivos: [anio - 1, anio, anio + 1],
        }),
      );
    });
    // La semilla trae los festivos calculados; se asegura el año siguiente por si la semilla cambia.
    for (const f of festivosColombia(anio + 1))
      await this.db.exec('insert into festivos (empresa_id, fecha, nombre) values ($1, $2, $3) on conflict do nothing', [id, f.fecha, f.nombre]);
    await this.auditoria.registrar(this.firma(p, id), 'crear_espacio', 'empresa', id, null, { espacio: d.espacio, superusuario: d.usuario });
    return (await this.espacios()).find((e: any) => e.id === id);
  }

  async renombrar(p: SesionPlataforma, id: string, espacio: string) {
    const e = await this.empresa(id);
    if (await this.db.maybe('select 1 from empresas where lower(espacio) = $1 and id <> $2', [espacio, id])) throw new ErrorNegocio(`Ya existe un espacio llamado "${espacio}"`, 409);
    await this.db.exec('update empresas set espacio = $2 where id = $1', [id, espacio]);
    await this.auditoria.registrar(this.firma(p, id), 'cambiar_espacio', 'empresa', id, { espacio: e.espacio }, { espacio });
    return { ok: true, espacio };
  }

  async usuarios(id: string) {
    await this.empresa(id);
    return camelLista(await this.db.many('select id, usuario, nombre, rol, activo, ultimo_acceso from usuarios where empresa_id = $1 order by rol desc, usuario', [id]));
  }

  async restablecer(p: SesionPlataforma, id: string, usuarioId: string, password: string) {
    const u = await this.db.maybe('select id, usuario from usuarios where id = $1 and empresa_id = $2', [usuarioId, id]);
    if (!u) throw new ErrorNegocio('Usuario no encontrado', 404);
    await this.db.exec('update usuarios set password_hash = $2, intentos_fallidos = 0, bloqueado_hasta = null, activo = true where id = $1', [usuarioId, await bcrypt.hash(password, 10)]);
    await this.auditoria.registrar(this.firma(p, id), 'restablecer_password', 'usuario', usuarioId, null, { usuario: u.usuario });
    return { ok: true };
  }

  /** Entra al espacio como superusuario de soporte. Todo lo que haga queda firmado como «Plataforma: …». */
  async entrar(p: SesionPlataforma, id: string, ip: string) {
    const e = await this.empresa(id);
    const sesion: UsuarioSesion = { id: p.id, empresaId: id, usuario: p.usuario, nombre: `Plataforma: ${p.nombre}`, rol: 'superusuario', espacio: e.espacio, soporte: true };
    await this.auditoria.registrar(sesion, 'entrar_soporte', 'empresa', id, null, null, { ip });
    return { token: this.jwt.sign(sesion, { expiresIn: '4h' }), espacio: e.espacio };
  }

  private async empresa(id: string) {
    const e = await this.db.maybe('select id, espacio, razon_social from empresas where id = $1', [id]);
    if (!e) throw new ErrorNegocio('Espacio no encontrado', 404);
    return camel<any>(e);
  }

  private firma(p: SesionPlataforma, empresaId: string) {
    return { id: p.id, empresaId, nombre: `Plataforma: ${p.nombre}` };
  }
}

@Controller('plataforma')
@SoloPlataforma()
export class PlataformaController {
  constructor(private readonly s: PlataformaService) {}

  @Publico()
  @Post('login')
  login(@Body(new Validar(LoginDto)) d: z.infer<typeof LoginDto>, @Ip() ip: string) {
    return this.s.login(d.usuario, d.password, ip);
  }

  @Get('yo')
  yo(@Usuario() p: SesionPlataforma) {
    return p;
  }

  @Get('espacios')
  espacios() {
    return this.s.espacios();
  }

  @Post('espacios')
  crear(@Usuario() p: SesionPlataforma, @Body(new Validar(EspacioDto)) d: z.infer<typeof EspacioDto>) {
    return this.s.crear(p, d);
  }

  @Patch('espacios/:id')
  renombrar(@Usuario() p: SesionPlataforma, @Param('id') id: string, @Body(new Validar(z.object({ espacio: zEspacio }))) d: { espacio: string }) {
    return this.s.renombrar(p, id, d.espacio);
  }

  @Get('espacios/:id/usuarios')
  usuarios(@Param('id') id: string) {
    return this.s.usuarios(id);
  }

  @Post('espacios/:id/usuarios/:usuarioId/password')
  restablecer(@Usuario() p: SesionPlataforma, @Param('id') id: string, @Param('usuarioId') usuarioId: string, @Body(new Validar(PasswordDto)) d: { password: string }) {
    return this.s.restablecer(p, id, usuarioId, d.password);
  }

  @Post('espacios/:id/entrar')
  entrar(@Usuario() p: SesionPlataforma, @Param('id') id: string, @Ip() ip: string) {
    return this.s.entrar(p, id, ip);
  }
}
