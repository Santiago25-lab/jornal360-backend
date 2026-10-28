import { z } from 'zod';
import { config } from '../config';

export const zFecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha con formato AAAA-MM-DD');
export const zHora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora con formato HH:mm');
export const zNumero = z.union([z.number(), z.string().regex(/^-?\d+([.,]\d+)?$/, 'Debe ser un número')]).transform((v) => String(v).replace(',', '.'));
export const zUuid = z.string().uuid();
export const zOpcional = <T extends z.ZodTypeAny>(s: T) => s.optional().nullable();

/** Convierte un instante a fecha y hora local de Colombia 'AAAA-MM-DDTHH:mm'. */
export function aLocal(d: Date | string): string {
  const t = typeof d === 'string' ? new Date(d) : d;
  return new Date(t.getTime() + config().desfaseMinutos * 60000).toISOString().slice(0, 16);
}

/** Fecha local de Colombia de un instante. */
export function fechaLocal(d: Date | string = new Date()): string {
  return aLocal(d).slice(0, 10);
}

/** Convierte 'AAAA-MM-DDTHH:mm' local de Colombia a un instante. */
export function desdeLocal(local: string): Date {
  const [f, h] = local.split('T');
  return new Date(new Date(`${f}T${h.length === 5 ? h + ':00' : h}Z`).getTime() - config().desfaseMinutos * 60000);
}

/** Convierte claves snake_case de una fila a camelCase. */
export function camel<T = any>(fila: Record<string, any>): T {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(fila)) out[k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())] = v;
  return out as T;
}

export const camelLista = <T = any>(filas: Record<string, any>[]) => filas.map((f) => camel<T>(f));

/** Construye un UPDATE solo con los campos presentes. Devuelve null si no hay nada que cambiar. */
export function sqlActualizar(tabla: string, mapa: Record<string, string>, datos: Record<string, unknown>, desde = 1): { sets: string; valores: unknown[] } | null {
  const sets: string[] = [];
  const valores: unknown[] = [];
  for (const [campo, columna] of Object.entries(mapa)) {
    if (datos[campo] === undefined) continue;
    const v = datos[campo];
    valores.push(v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v);
    sets.push(`${columna} = $${desde + valores.length - 1}`);
  }
  if (!sets.length) return null;
  void tabla;
  return { sets: sets.join(', '), valores };
}

export const nombreCompleto = (e: { nombres: string; apellidos: string }) => `${e.nombres} ${e.apellidos}`.trim();

/** Formato colombiano de pesos para PDFs y mensajes. */
export function pesos(v: string | number): string {
  const n = Number(v);
  return '$ ' + Math.round(n).toLocaleString('es-CO').replace(/,/g, '.');
}
