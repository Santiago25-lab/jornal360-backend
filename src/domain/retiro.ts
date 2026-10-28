import { D, Decimal, Num, redondear, ModoRedondeo } from './decimal';
import { diasComerciales, diferenciaDias, Fecha, sumarDias } from './fechas';

/**
 * Terminación del contrato (CST arts. 64 y 65).
 */

export type TipoContrato = 'indefinido' | 'fijo' | 'obra_labor' | 'ocasional' | 'aprendizaje' | 'integral' | 'tiempo_parcial';

export interface TablaIndemnizacion {
  /** Tope en SMMLV que separa las dos tablas del art. 64 (10). */
  topeSmmlv: Num;
  diasPrimerAnioMenor: Num; // 30
  diasAdicionalMenor: Num; // 20
  diasPrimerAnioMayor: Num; // 20
  diasAdicionalMayor: Num; // 15
  minimoDiasObraLabor: Num; // 15
}

export const TABLA_INDEMNIZACION_POR_DEFECTO: TablaIndemnizacion = {
  topeSmmlv: 10,
  diasPrimerAnioMenor: 30,
  diasAdicionalMenor: 20,
  diasPrimerAnioMayor: 20,
  diasAdicionalMayor: 15,
  minimoDiasObraLabor: 15,
};

export interface EntradaIndemnizacion {
  tipoContrato: TipoContrato;
  /** Para indefinido y salario integral se trata como indefinido salvo que tenga fecha fin. */
  salarioMensual: Num;
  smmlv: Num;
  fechaIngreso: Fecha;
  fechaRetiro: Fecha;
  /** Fin pactado (término fijo) o estimado de la obra. */
  fechaFinPactada?: Fecha | null;
  redondeo?: ModoRedondeo;
}

export interface ResultadoIndemnizacion {
  dias: Decimal;
  valor: Decimal;
  detalle: string;
}

export function calcularIndemnizacion(e: EntradaIndemnizacion, t: TablaIndemnizacion = TABLA_INDEMNIZACION_POR_DEFECTO): ResultadoIndemnizacion {
  const diario = D(e.salarioMensual).div(30);
  const r = (dias: Decimal, detalle: string) => ({ dias, valor: redondear(diario.mul(dias), e.redondeo ?? 'peso'), detalle });

  const conFin = (e.tipoContrato === 'fijo' || e.tipoContrato === 'obra_labor' || e.tipoContrato === 'aprendizaje') && e.fechaFinPactada;
  if (conFin) {
    const faltan = e.fechaFinPactada! > e.fechaRetiro ? diasComerciales(sumarDias(e.fechaRetiro, 1), e.fechaFinPactada!) : 0;
    let dias = D(faltan);
    if (e.tipoContrato === 'obra_labor') dias = Decimal.max(dias, D(t.minimoDiasObraLabor));
    return r(dias, `Salarios del tiempo que faltaba para terminar el contrato: ${dias.toFixed()} días`);
  }

  const anios = D(diasComerciales(e.fechaIngreso, e.fechaRetiro)).div(360);
  const mayor = D(e.salarioMensual).gte(D(e.smmlv).mul(D(t.topeSmmlv)));
  const primer = D(mayor ? t.diasPrimerAnioMayor : t.diasPrimerAnioMenor);
  const adicional = D(mayor ? t.diasAdicionalMayor : t.diasAdicionalMenor);
  const dias = anios.lte(1) ? primer : primer.plus(adicional.mul(anios.minus(1)));
  return r(
    dias.toDecimalPlaces(4),
    `${primer.toFixed()} días por el primer año + ${adicional.toFixed()} por cada año adicional (proporcional); antigüedad ${anios.toDecimalPlaces(4).toFixed()} años`,
  );
}

export interface EntradaMoratoria {
  salarioMensual: Num;
  smmlv: Num;
  fechaRetiro: Fecha;
  fechaPago: Fecha;
  /** Saldo adeudado, para los intereses después del mes 24. */
  saldoAdeudado: Num;
  /** Tasa mensual de interés moratorio (después de 24 meses). */
  tasaMoratoriaMensual: Num;
}

/** Sanción moratoria del art. 65: un día de salario por día de retraso hasta 24 meses, luego intereses. */
export function calcularMoratoria(e: EntradaMoratoria): { dias: number; valorDias: Decimal; intereses: Decimal; total: Decimal } {
  const diasMora = Math.max(0, diferenciaDias(e.fechaRetiro, e.fechaPago));
  const diario = D(e.salarioMensual).div(30);
  const aplicaIntereses = D(e.salarioMensual).gt(D(e.smmlv)); // parágrafo 2: solo para quien gana más de 1 SMMLV
  const diasConSalario = aplicaIntereses ? Math.min(diasMora, 720) : diasMora;
  const valorDias = redondear(diario.mul(diasConSalario));
  let intereses = D(0);
  if (aplicaIntereses && diasMora > 720) {
    const meses = D(diasMora - 720).div(30);
    intereses = redondear(D(e.saldoAdeudado).mul(D(e.tasaMoratoriaMensual)).mul(meses));
  }
  return { dias: diasMora, valorDias, intereses, total: valorDias.plus(intereses) };
}
