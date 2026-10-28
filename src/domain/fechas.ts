/**
 * Utilidades de fechas sin zona horaria (fechas de calendario 'AAAA-MM-DD').
 * Se trabaja en UTC para que ningún cálculo cambie de día por la zona del servidor.
 */

export type Fecha = string; // 'AAAA-MM-DD'

const RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function aDate(f: Fecha): Date {
  const m = RE.exec(f);
  if (!m) throw new Error(`Fecha inválida: ${f}`);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== +m[2] - 1) throw new Error(`Fecha inválida: ${f}`);
  return d;
}

export function aFecha(d: Date): Fecha {
  return d.toISOString().slice(0, 10);
}

export function fecha(anio: number, mes: number, dia: number): Fecha {
  return aFecha(new Date(Date.UTC(anio, mes - 1, dia)));
}

export function sumarDias(f: Fecha, n: number): Fecha {
  const d = aDate(f);
  d.setUTCDate(d.getUTCDate() + n);
  return aFecha(d);
}

export function sumarMeses(f: Fecha, n: number): Fecha {
  const d = aDate(f);
  const dia = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const ultimo = diasDelMes(d.getUTCFullYear(), d.getUTCMonth() + 1);
  d.setUTCDate(Math.min(dia, ultimo));
  return aFecha(d);
}

/** Días calendario entre dos fechas, sin incluir la primera (hasta - desde). */
export function diferenciaDias(desde: Fecha, hasta: Fecha): number {
  return Math.round((aDate(hasta).getTime() - aDate(desde).getTime()) / 86_400_000);
}

/** Días calendario incluyendo ambos extremos. */
export function diasCalendario(desde: Fecha, hasta: Fecha): number {
  return diferenciaDias(desde, hasta) + 1;
}

/** 0 = domingo ... 6 = sábado */
export function diaSemana(f: Fecha): number {
  return aDate(f).getUTCDay();
}

export function diasDelMes(anio: number, mes: number): number {
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate();
}

export function finDeMes(f: Fecha): Fecha {
  const d = aDate(f);
  return fecha(d.getUTCFullYear(), d.getUTCMonth() + 1, diasDelMes(d.getUTCFullYear(), d.getUTCMonth() + 1));
}

export const anioDe = (f: Fecha) => +f.slice(0, 4);
export const mesDe = (f: Fecha) => +f.slice(5, 7);
export const diaDe = (f: Fecha) => +f.slice(8, 10);

export const maxFecha = (a: Fecha, b: Fecha) => (a > b ? a : b);
export const minFecha = (a: Fecha, b: Fecha) => (a < b ? a : b);

/** Recorre cada fecha del rango, incluyendo ambos extremos. */
export function* rango(desde: Fecha, hasta: Fecha): Generator<Fecha> {
  for (let f = desde; f <= hasta; f = sumarDias(f, 1)) yield f;
}

/**
 * Días comerciales (año de 360 días, meses de 30), incluyendo ambos extremos.
 * Es la convención usada en Colombia para salario y prestaciones:
 * el día 31 cuenta como 30 y el último día de febrero también cuenta como 30.
 *   1-ene a 31-dic = 360 · 1-feb a 28-feb = 30 · 10-ene a 31-ene = 21
 */
export function diasComerciales(desde: Fecha, hasta: Fecha): number {
  if (hasta < desde) return 0;
  const ajustar = (f: Fecha) => {
    const a = anioDe(f);
    const m = mesDe(f);
    const d = diaDe(f);
    const ultimo = diasDelMes(a, m);
    return { a, m, d: d === ultimo ? 30 : Math.min(d, 30) };
  };
  const i = ajustar(desde);
  const f = ajustar(hasta);
  // Si el periodo empieza el último día de un mes, ese día igual vale 1.
  const dIni = i.d === 30 && diaDe(desde) !== 30 ? 30 : i.d;
  return (f.a - i.a) * 360 + (f.m - i.m) * 30 + (f.d - dIni) + 1;
}

/** Años completos y fracción comercial entre dos fechas (para antigüedad). */
export function antiguedadAnios(ingreso: Fecha, corte: Fecha): number {
  return diasComerciales(ingreso, corte) / 360;
}
