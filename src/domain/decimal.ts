import Decimal from 'decimal.js';

// Precisión alta para que ningún cálculo intermedio pierda centavos.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };
export type Num = Decimal | number | string;

export const D = (v: Num | null | undefined): Decimal => new Decimal(v ?? 0);
export const ZERO = new Decimal(0);

export type ModoRedondeo = 'ninguno' | 'peso' | 'peso_arriba' | 'centena' | 'centena_arriba' | 'mil';

/** Redondea un valor según el modo configurado en el concepto o parámetro. */
export function redondear(valor: Num, modo: ModoRedondeo = 'peso'): Decimal {
  const v = D(valor);
  switch (modo) {
    case 'ninguno':
      return v;
    case 'peso':
      return v.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    case 'peso_arriba':
      return v.toDecimalPlaces(0, Decimal.ROUND_CEIL);
    case 'centena':
      return v.div(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).mul(100);
    case 'centena_arriba':
      return v.div(100).toDecimalPlaces(0, Decimal.ROUND_CEIL).mul(100);
    case 'mil':
      return v.div(1000).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).mul(1000);
    default:
      return v;
  }
}

export const max = (a: Num, b: Num): Decimal => Decimal.max(D(a), D(b));
export const min = (a: Num, b: Num): Decimal => Decimal.min(D(a), D(b));
export const sum = (vals: Num[]): Decimal => vals.reduce<Decimal>((acc, v) => acc.plus(D(v)), ZERO);

/** Serializa un Decimal para JSON / base de datos sin notación científica. */
export const toStr = (v: Num): string => D(v).toFixed();
