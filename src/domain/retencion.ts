import { D, Decimal, Num, redondear, ModoRedondeo } from './decimal';

/**
 * Retención en la fuente por pagos laborales (ET arts. 206, 383, 385, 386, 387, 388, 336).
 * Todos los porcentajes y topes en UVT son parámetros editables.
 */

export interface FilaTablaRetencion {
  desdeUvt: Num; // excluido
  hastaUvt: Num | null; // incluido; null = en adelante
  tarifa: Num; // tarifa marginal
  restaUvt: Num; // UVT que se restan a la base
  sumaUvt: Num; // UVT que se suman al impuesto
}

/** Tabla del art. 383 del ET (en UVT). */
export const TABLA_383: FilaTablaRetencion[] = [
  { desdeUvt: 0, hastaUvt: 95, tarifa: 0, restaUvt: 0, sumaUvt: 0 },
  { desdeUvt: 95, hastaUvt: 150, tarifa: '0.19', restaUvt: 95, sumaUvt: 0 },
  { desdeUvt: 150, hastaUvt: 360, tarifa: '0.28', restaUvt: 150, sumaUvt: 10 },
  { desdeUvt: 360, hastaUvt: 640, tarifa: '0.33', restaUvt: 360, sumaUvt: 69 },
  { desdeUvt: 640, hastaUvt: 945, tarifa: '0.35', restaUvt: 640, sumaUvt: 162 },
  { desdeUvt: 945, hastaUvt: 2300, tarifa: '0.37', restaUvt: 945, sumaUvt: 268 },
  { desdeUvt: 2300, hastaUvt: null, tarifa: '0.39', restaUvt: 2300, sumaUvt: 770 },
];

export interface ParamsRetencion {
  uvt: Decimal;
  pctRentaExenta: Decimal; // 0,25
  topeRentaExentaUvtAnual: Decimal; // 790
  pctLimiteGlobal: Decimal; // 0,40
  topeLimiteGlobalUvtAnual: Decimal; // 1340
  pctDependientes: Decimal; // 0,10
  topeDependientesUvtMes: Decimal; // 32
  topeInteresesViviendaUvtMes: Decimal; // 100
  topeMedicinaPrepagadaUvtMes: Decimal; // 16
  uvtDependienteAdicionalAnual: Decimal; // 72 (Ley 2277 de 2022)
  maxDependientesAdicionales: number; // 4
  tabla: FilaTablaRetencion[];
  redondeo: ModoRedondeo; // 'mil'
}

export const paramsRetencionPorDefecto = (uvt: Num): ParamsRetencion => ({
  uvt: D(uvt),
  pctRentaExenta: D('0.25'),
  topeRentaExentaUvtAnual: D(790),
  pctLimiteGlobal: D('0.40'),
  topeLimiteGlobalUvtAnual: D(1340),
  pctDependientes: D('0.10'),
  topeDependientesUvtMes: D(32),
  topeInteresesViviendaUvtMes: D(100),
  topeMedicinaPrepagadaUvtMes: D(16),
  uvtDependienteAdicionalAnual: D(72),
  maxDependientesAdicionales: 4,
  tabla: TABLA_383,
  redondeo: 'mil',
});

export interface EntradaRetencion {
  /** Pagos laborales gravables del mes. */
  ingresosLaborales: Num;
  /** Ingresos no constitutivos: aportes obligatorios a salud, pensión y FSP del empleado. */
  ingresosNoConstitutivos: Num;
  tieneDependiente?: boolean;
  dependientesAdicionales?: number;
  interesesVivienda?: Num;
  medicinaPrepagada?: Num;
  /** Aportes voluntarios a pensión y AFC/FPC (renta exenta, ya con sus topes). */
  aportesVoluntarios?: Num;
  /** Otras rentas exentas (ej. factor prestacional ya se excluye antes). */
  otrasExentas?: Num;
  procedimiento: 1 | 2;
  porcentajeFijo?: Num; // procedimiento 2
}

export interface PasoRetencion {
  concepto: string;
  valor: Decimal;
  uvt: Decimal;
}

export interface ResultadoRetencion {
  baseGravable: Decimal;
  baseUvt: Decimal;
  retencion: Decimal;
  pasos: PasoRetencion[];
}

export function impuestoTabla(baseUvt: Decimal, tabla: FilaTablaRetencion[]): Decimal {
  for (const f of tabla) {
    const desde = D(f.desdeUvt);
    const hasta = f.hastaUvt === null ? null : D(f.hastaUvt);
    if (baseUvt.gt(desde) && (hasta === null || baseUvt.lte(hasta))) {
      if (D(f.tarifa).isZero()) return D(0);
      return baseUvt.minus(D(f.restaUvt)).mul(D(f.tarifa)).plus(D(f.sumaUvt));
    }
  }
  return D(0);
}

/** Depuración y cálculo mensual de la retención (procedimiento 1 o 2). */
export function calcularRetencion(e: EntradaRetencion, p: ParamsRetencion): ResultadoRetencion {
  const uvt = p.uvt;
  const enUvt = (v: Decimal) => (uvt.isZero() ? D(0) : v.div(uvt));
  const pasos: PasoRetencion[] = [];
  const paso = (concepto: string, valor: Decimal) => {
    pasos.push({ concepto, valor, uvt: enUvt(valor) });
    return valor;
  };

  const ingresos = paso('Ingresos laborales del mes', D(e.ingresosLaborales));
  const incr = paso('(-) Ingresos no constitutivos (aportes obligatorios)', Decimal.min(D(e.ingresosNoConstitutivos), ingresos));
  const neto = paso('Ingreso neto', ingresos.minus(incr));

  const dep = e.tieneDependiente ? Decimal.min(ingresos.mul(p.pctDependientes), p.topeDependientesUvtMes.mul(uvt)) : D(0);
  const viv = Decimal.min(D(e.interesesVivienda ?? 0), p.topeInteresesViviendaUvtMes.mul(uvt));
  const prep = Decimal.min(D(e.medicinaPrepagada ?? 0), p.topeMedicinaPrepagadaUvtMes.mul(uvt));
  const deducciones = paso('(-) Deducciones (dependientes, vivienda, prepagada)', dep.plus(viv).plus(prep));
  const exentasVol = paso('(-) Rentas exentas por aportes voluntarios', D(e.aportesVoluntarios ?? 0).plus(D(e.otrasExentas ?? 0)));

  const subtotal = Decimal.max(neto.minus(deducciones).minus(exentasVol), D(0));
  const exenta25 = paso(
    `(-) Renta exenta del ${p.pctRentaExenta.mul(100).toFixed()}%`,
    Decimal.min(subtotal.mul(p.pctRentaExenta), p.topeRentaExentaUvtAnual.div(12).mul(uvt)),
  );

  const beneficios = deducciones.plus(exentasVol).plus(exenta25);
  const limite = Decimal.min(neto.mul(p.pctLimiteGlobal), p.topeLimiteGlobalUvtAnual.div(12).mul(uvt));
  const aplicados = paso('Beneficios aplicados (con límite global)', Decimal.min(beneficios, limite));

  const nDepAd = Math.min(e.dependientesAdicionales ?? 0, p.maxDependientesAdicionales);
  const depAdicional = paso('(-) Dependientes adicionales (fuera del límite)', p.uvtDependienteAdicionalAnual.div(12).mul(uvt).mul(nDepAd));

  const base = Decimal.max(neto.minus(aplicados).minus(depAdicional), D(0));
  paso('Base gravable', base);
  const baseUvt = enUvt(base);

  let retencion: Decimal;
  if (e.procedimiento === 2) {
    retencion = base.mul(D(e.porcentajeFijo ?? 0)).div(100);
    paso(`Retención procedimiento 2 (${D(e.porcentajeFijo ?? 0).toFixed()}%)`, retencion);
  } else {
    const impUvt = impuestoTabla(baseUvt, p.tabla);
    retencion = impUvt.mul(uvt);
    paso('Retención según tabla art. 383', retencion);
  }
  retencion = redondear(retencion, p.redondeo);
  return { baseGravable: base, baseUvt, retencion, pasos };
}

/**
 * Porcentaje fijo semestral del procedimiento 2 (ET art. 386):
 * promedio mensual de la base de los 12 meses anteriores, se busca el impuesto en la tabla
 * y se divide por el promedio.
 */
export function porcentajeProcedimiento2(basesGravables12Meses: Num[], p: ParamsRetencion): Decimal {
  if (basesGravables12Meses.length === 0) return D(0);
  const total = basesGravables12Meses.reduce<Decimal>((a, v) => a.plus(D(v)), D(0));
  const meses = Math.min(12, basesGravables12Meses.length);
  const promedio = total.div(meses);
  const promUvt = p.uvt.isZero() ? D(0) : promedio.div(p.uvt);
  const impUvt = impuestoTabla(promUvt, p.tabla);
  if (promUvt.isZero()) return D(0);
  return impUvt.div(promUvt).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}
