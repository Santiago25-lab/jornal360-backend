import {
  ArgumentsHost,
  BadRequestException,
  CanActivate,
  Catch,
  createParamDecorator,
  ExceptionFilter,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  PipeTransform,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request, Response } from 'express';
import { ZodError, ZodSchema } from 'zod';
import { FormulaError } from '../domain/formulas';

export interface UsuarioSesion {
  id: string;
  empresaId: string;
  usuario: string;
  nombre: string;
  rol: 'superusuario' | 'analista' | 'contador' | 'aprobador' | 'supervisor';
}

export const ES_PUBLICO = 'esPublico';
/** Ruta sin inicio de sesión (marcación, kiosco, vinculación). */
export const Publico = () => SetMetadata(ES_PUBLICO, true);

export const ROLES = 'roles';
/** Roles permitidos. El superusuario siempre tiene acceso. */
export const Roles = (...roles: UsuarioSesion['rol'][]) => SetMetadata(ROLES, roles);

export const Usuario = createParamDecorator((_: unknown, ctx: ExecutionContext): UsuarioSesion => {
  return ctx.switchToHttp().getRequest().usuario;
});

export const Ip = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '';
});

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const publico = this.reflector.getAllAndOverride<boolean>(ES_PUBLICO, [ctx.getHandler(), ctx.getClass()]);
    if (publico) return true;
    const req = ctx.switchToHttp().getRequest<Request & { usuario?: UsuarioSesion }>();
    const h = req.headers.authorization ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query?.token as string | undefined);
    if (!token) throw new UnauthorizedException('Debe iniciar sesión');
    try {
      req.usuario = this.jwt.verify<UsuarioSesion>(token);
    } catch {
      throw new UnauthorizedException('La sesión venció. Inicie sesión de nuevo');
    }
    const roles = this.reflector.getAllAndOverride<UsuarioSesion['rol'][]>(ROLES, [ctx.getHandler(), ctx.getClass()]);
    if (roles?.length && req.usuario.rol !== 'superusuario' && !roles.includes(req.usuario.rol))
      throw new ForbiddenException('No tiene permiso para esta acción');
    return true;
  }
}

/** Valida el cuerpo o la consulta con un esquema zod y devuelve los datos limpios. */
export class Validar<T> implements PipeTransform {
  constructor(private readonly esquema: ZodSchema<T>) {}
  transform(valor: unknown): T {
    const r = this.esquema.safeParse(valor);
    if (!r.success) throw new BadRequestException({ mensaje: 'Datos inválidos', errores: formatearZod(r.error) });
    return r.data;
  }
}

export function formatearZod(e: ZodError): { campo: string; mensaje: string }[] {
  return e.issues.map((i) => ({ campo: i.path.join('.'), mensaje: traducir(i.message) }));
}

function traducir(m: string): string {
  if (m === 'Required') return 'Es obligatorio';
  if (m.startsWith('Expected') && m.includes('received undefined')) return 'Es obligatorio';
  if (m.startsWith('Expected number')) return 'Debe ser un número';
  if (m.startsWith('Expected string')) return 'Debe ser texto';
  if (m.startsWith('Expected boolean')) return 'Debe ser sí o no';
  if (m.startsWith('Invalid enum value')) return 'Opción no válida';
  if (m.startsWith('Invalid uuid')) return 'Identificador no válido';
  return m;
}

export class ErrorNegocio extends HttpException {
  constructor(mensaje: string, estado = 400, extra: Record<string, unknown> = {}) {
    super({ mensaje, ...extra }, estado);
  }
}

@Catch()
export class FiltroErrores implements ExceptionFilter {
  private readonly log = new Logger('Errores');

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (err instanceof HttpException) {
      const r = err.getResponse();
      const cuerpo = typeof r === 'string' ? { mensaje: r } : (r as Record<string, unknown>);
      if (!cuerpo.mensaje && cuerpo.message) cuerpo.mensaje = Array.isArray(cuerpo.message) ? cuerpo.message.join('. ') : cuerpo.message;
      return res.status(err.getStatus()).json({ estado: err.getStatus(), ...cuerpo });
    }
    if (err instanceof FormulaError) return res.status(400).json({ estado: 400, mensaje: err.message });
    const pg = err as { code?: string; detail?: string; constraint?: string; message?: string };
    if (pg?.code === '23505') return res.status(409).json({ estado: 409, mensaje: 'Ya existe un registro con esos datos', detalle: pg.detail });
    if (pg?.code === '23503') return res.status(409).json({ estado: 409, mensaje: 'El registro está relacionado con otros datos', detalle: pg.detail });
    if (pg?.code === '23514') return res.status(400).json({ estado: 400, mensaje: 'Un valor no es válido', detalle: pg.constraint });
    if (pg?.code === '22P02' || pg?.code === '22007' || pg?.code === '22008') return res.status(400).json({ estado: 400, mensaje: 'Un valor tiene un formato no válido' });
    this.log.error(pg?.message ?? String(err), (err as Error)?.stack);
    return res.status(500).json({ estado: 500, mensaje: 'Ocurrió un error inesperado. Intente de nuevo' });
  }
}
