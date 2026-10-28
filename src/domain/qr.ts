import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';

/**
 * Código QR rotativo de cada sede (HU-23). El código cambia cada `segundos` y está firmado
 * con una clave secreta del servidor, así una foto del QR deja de servir al vencer.
 */

export interface OpcionesQr {
  secreto: string;
  segundos: number; // 30 por defecto
  /** Segundos de gracia después del cambio (para quien escaneó justo al final). */
  gracia: number; // 5 por defecto
}

const b64url = (b: Buffer) => b.toString('base64url');

function firma(secreto: string, sedeId: string, ventana: number): string {
  return b64url(createHmac('sha256', secreto).update(`${sedeId}|${ventana}`).digest()).slice(0, 22);
}

export function generarTokenQr(sedeId: string, op: OpcionesQr, ahoraMs = Date.now()): { token: string; venceEn: number } {
  const ventana = Math.floor(ahoraMs / 1000 / op.segundos);
  const token = `${sedeId}.${ventana}.${firma(op.secreto, sedeId, ventana)}`;
  const venceEn = (ventana + 1) * op.segundos * 1000 - ahoraMs;
  return { token, venceEn };
}

export type ResultadoQr = { valido: true; sedeId: string } | { valido: false; motivo: 'formato' | 'firma' | 'vencido' };

export function verificarTokenQr(token: string, op: OpcionesQr, ahoraMs = Date.now()): ResultadoQr {
  const partes = token.split('.');
  if (partes.length !== 3) return { valido: false, motivo: 'formato' };
  const [sedeId, vStr, f] = partes;
  const ventana = Number(vStr);
  if (!sedeId || !Number.isInteger(ventana)) return { valido: false, motivo: 'formato' };
  const esperada = firma(op.secreto, sedeId, ventana);
  const a = Buffer.from(f);
  const b = Buffer.from(esperada);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { valido: false, motivo: 'firma' };
  const seg = ahoraMs / 1000;
  const actual = Math.floor(seg / op.segundos);
  if (ventana === actual) return { valido: true, sedeId };
  if (ventana === actual - 1 && seg - actual * op.segundos <= op.gracia) return { valido: true, sedeId };
  return { valido: false, motivo: 'vencido' };
}

/** Código de vinculación de 6 dígitos (HU-24). */
export function codigoSeisDigitos(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Llave secreta que se guarda en el navegador del celular o kiosco vinculado. */
export function llaveDispositivo(): string {
  return b64url(randomBytes(32));
}

/** PIN de 4 dígitos para el kiosco (HU-28). */
export function pinCuatroDigitos(): string {
  return String(randomInt(0, 10_000)).padStart(4, '0');
}
