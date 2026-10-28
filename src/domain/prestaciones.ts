import { D, Decimal, Num, redondear, ModoRedondeo, sum } from './decimal';
import { diasComerciales, Fecha, maxFecha, minFecha, sumarMeses } from './fechas';

/**
 * Prestaciones sociales (CST arts. 186-192, 249-253, 306; Ley 52 de 1975).
 * Todas las cifras (días base, porcentajes, meses para promedio) llegan como parámetros
 * para que el superusuario pueda cambiarlas.
 */

export interface ParamsPrestaciones {
  diasAnio: number; // 360
  pctInteresesCesantias: Decimal; // 0,12
  diasVacacionesPorAnio: number; // 15
  mesesVariacionParaPromedio: number; // 3 (CST art. 253)
  redondeo: ModoRedondeo;
}

export const PARAMS_PRESTACIONES_POR_DEFECTO: ParamsPrestaciones = {
  diasAnio: 360,
  pctInteresesCesantias: D('0.12'),
  diasVacacionesPorAnio: 15,
  mesesVariacionParaPromedio: 3,
  redondeo: 'peso',
};

export interface CambioSalario {
  desde: Fecha;
  salario: Num;
}

export interface DevengoMensual {
  /** Mes 'AAAA-MM' */
  mes: string;
  /** Pagos salariales variables del mes (extras, recargos, comisiones). */
  variable: Num;
}

export interface EntradaBase {
  historialSalario: CambioSalario[];
  /** Pagos salariales variables por mes en el lapso a liquidar. */
  variables?: DevengoMensual[];
  auxilioTransporte?: Num; // valor mensual si tiene derecho
  desde: Fecha;
  hasta: Fecha;
  salarioVariable?: boolean;
}

/** Salario vigente en una fecha según el historial. */
export function salarioEn(historial: CambioSalario[], f: Fecha): Decimal {
  const ordenado = [...historial].sort((a, b) => a.desde.localeCompare(b.desde));
  let s = D(ordenado[0]?.salario ?? 0);
  for (const c of ordenado) if (c.desde <= f) s = D(c.salario);
  return s;
}

/** Promedio del salario básico en el lapso, ponderado por días comerciales. */
export function promedioSalario(historial: CambioSalario[], desde: Fecha, hasta: Fecha): Decimal {
  const ordenado = [...historial].sort((a, b) => a.desde.localeCompare(b.desde));
  let total = D(0);
  let dias = 0;
  for (let i = 0; i < ordenado.length; i++) {
    const ini = maxFecha(ordenado[i].desde, desde);
    const finTramo = i + 1 < ordenado.length ? sumarDiasStr(ordenado[i + 1].desde, -1) : hasta;
    const fin = minFecha(finTramo, hasta);
    if (fin < ini) continue;
    const d = diasComerciales(ini, fin);
    total = total.plus(D(ordenado[i].salario).mul(d));
    dias += d;
  }
  return dias ? total.div(dias) : salarioEn(historial, hasta);
}

function sumarDiasStr(f: Fecha, n: number): Fecha {
  const d = new Date(f + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Base para cesantías y prima (CST art. 253): último salario si no varió en los últimos
 * N meses; si varió o es variable, el promedio del lapso. Se suma el auxilio de transporte
 * y el promedio mensual de lo variable.
 */
export function basePrestaciones(e: EntradaBase, p: ParamsPrestaciones = PARAMS_PRESTACIONES_POR_DEFECTO): {
  base: Decimal;
  metodo: 'ultimo_salario' | 'promedio';
  detalle: string;
} {
  const limite = sumarMeses(e.hasta, -p.mesesVariacionParaPromedio);
  const vario = e.historialSalario.some((c) => c.desde > limite && c.desde <= e.hasta && c.desde > e.desde);
  const usarPromedio = vario || !!e.salarioVariable;
  const basico = usarPromedio ? promedioSalario(e.historialSalario, e.desde, e.hasta) : salarioEn(e.historialSalario, e.hasta);
  const dias = diasComerciales(e.desde, e.hasta);
  const variable = sum((e.variables ?? []).map((v) => v.variable));
  const promVariable = dias ? variable.div(dias).mul(30) : D(0);
  const aux = D(e.auxilioTransporte ?? 0);
  const base = basico.plus(promVariable).plus(aux);
  return {
    base,
    metodo: usarPromedio ? 'promedio' : 'ultimo_salario',
    detalle: `Básico ${basico.toFixed(2)} (${usarPromedio ? 'promedio' : 'último salario'}) + variable mensual ${promVariable.toFixed(2)} + auxilio ${aux.toFixed(2)}`,
  };
}

export interface ResultadoPrestacion {
  base: Decimal;
  dias: number;
  valor: Decimal;
  formula: string;
}

/** Prima de servicios: 30 días por año, proporcional (CST art. 306). */
export function liquidarPrima(base: Num, dias: number, p: ParamsPrestaciones = PARAMS_PRESTACIONES_POR_DEFECTO): ResultadoPrestacion {
  const valor = redondear(D(base).mul(dias).div(p.diasAnio), p.redondeo);
  return { base: D(base), dias, valor, formula: `base × días / ${p.diasAnio}` };
}

/** Cesantías: un mes de salario por año, proporcional (CST art. 249). */
export function liquidarCesantias(base: Num, dias: number, p: ParamsPrestaciones = PARAMS_PRESTACIONES_POR_DEFECTO): ResultadoPrestacion {
  const valor = redondear(D(base).mul(dias).div(p.diasAnio), p.redondeo);
  return { base: D(base), dias, valor, formula: `base × días / ${p.diasAnio}` };
}

/** Intereses sobre cesantías: 12% anual proporcional (Ley 52 de 1975). */
export function liquidarIntereses(cesantias: Num, dias: number, p: ParamsPrestaciones = PARAMS_PRESTACIONES_POR_DEFECTO): ResultadoPrestacion {
  const valor = redondear(D(cesantias).mul(dias).mul(p.pctInteresesCesantias).div(p.diasAnio), p.redondeo);
  return { base: D(cesantias), dias, valor, formula: `cesantías × días × ${p.pctInteresesCesantias.toFixed()} / ${p.diasAnio}` };
}

/** Días de vacaciones causados por tiempo trabajado (15 hábiles por 360 días). */
export function diasVacacionesCausados(diasTrabajados: number, p: ParamsPrestaciones = PARAMS_PRESTACIONES_POR_DEFECTO): Decimal {
  return D(diasTrabajados).mul(p.diasVacacionesPorAnio).div(p.diasAnio);
}

/**
 * Valor de vacaciones (CST art. 192): salario ordinario del día en que empiezan;
 * con salario variable, promedio del último año. Sin horas extra ni dominicales.
 */
export function liquidarVacaciones(baseMensual: Num, dias: Num, p: ParamsPrestaciones = PARAMS_PRESTACIONES_POR_DEFECTO): ResultadoPrestacion {
  const valor = redondear(D(baseMensual).div(30).mul(dias), p.redondeo);
  return { base: D(baseMensual), dias: D(dias).toNumber(), valor, formula: 'base / 30 × días' };
}

/** Semestre al que pertenece una fecha para la prima. */
export function semestreDe(f: Fecha): { desde: Fecha; hasta: Fecha } {
  const anio = f.slice(0, 4);
  return +f.slice(5, 7) <= 6 ? { desde: `${anio}-01-01`, hasta: `${anio}-06-30` } : { desde: `${anio}-07-01`, hasta: `${anio}-12-31` };
}

/** Días comerciales trabajados en un lapso descontando días no remunerados (licencias, suspensiones). */
export function diasTrabajados(desde: Fecha, hasta: Fecha, ingreso: Fecha, retiro: Fecha | null, diasNoRemunerados = 0): number {
  const ini = maxFecha(desde, ingreso);
  const fin = retiro ? minFecha(hasta, retiro) : hasta;
  return Math.max(0, diasComerciales(ini, fin) - diasNoRemunerados);
}
