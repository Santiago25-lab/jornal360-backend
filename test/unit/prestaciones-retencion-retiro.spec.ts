import { D } from '../../src/domain/decimal';
import {
  basePrestaciones,
  diasVacacionesCausados,
  liquidarCesantias,
  liquidarIntereses,
  liquidarPrima,
  liquidarVacaciones,
  promedioSalario,
  salarioEn,
  semestreDe,
} from '../../src/domain/prestaciones';
import { calcularRetencion, impuestoTabla, paramsRetencionPorDefecto, porcentajeProcedimiento2, TABLA_383 } from '../../src/domain/retencion';
import { calcularIndemnizacion, calcularMoratoria } from '../../src/domain/retiro';

describe('Prestaciones sociales', () => {
  it('HU-47: prima del semestre con auxilio de transporte', () => {
    const r = liquidarPrima(D(2000000).plus(249095), 180);
    expect(r.valor.toFixed()).toBe('1124548');
  });

  it('HU-48: cesantías e intereses del año', () => {
    const ces = liquidarCesantias(2249095, 360);
    expect(ces.valor.toFixed()).toBe('2249095');
    const int = liquidarIntereses(ces.valor, 360);
    expect(int.valor.toFixed()).toBe('269891');
  });

  it('proporcionales por días trabajados', () => {
    expect(liquidarCesantias(1800000, 90).valor.toFixed()).toBe('450000');
    expect(liquidarIntereses(450000, 90).valor.toFixed()).toBe('13500');
  });

  it('vacaciones causadas y su valor', () => {
    expect(diasVacacionesCausados(360).toFixed()).toBe('15');
    expect(diasVacacionesCausados(180).toFixed()).toBe('7.5');
    expect(liquidarVacaciones(3000000, 15).valor.toFixed()).toBe('1500000');
  });

  it('salario vigente y promedio ponderado', () => {
    const hist = [
      { desde: '2026-01-01', salario: 2000000 },
      { desde: '2026-07-01', salario: 3000000 },
    ];
    expect(salarioEn(hist, '2026-06-30').toFixed()).toBe('2000000');
    expect(salarioEn(hist, '2026-07-01').toFixed()).toBe('3000000');
    expect(promedioSalario(hist, '2026-01-01', '2026-12-31').toFixed()).toBe('2500000');
  });

  it('base: último salario si no varió en 3 meses; promedio si varió (CST art. 253)', () => {
    const fijo = basePrestaciones({
      historialSalario: [{ desde: '2025-01-01', salario: 2000000 }],
      auxilioTransporte: 249095,
      desde: '2026-01-01',
      hasta: '2026-12-31',
    });
    expect(fijo.metodo).toBe('ultimo_salario');
    expect(fijo.base.toFixed()).toBe('2249095');

    const vario = basePrestaciones({
      historialSalario: [
        { desde: '2025-01-01', salario: 2000000 },
        { desde: '2026-11-01', salario: 2600000 },
      ],
      desde: '2026-01-01',
      hasta: '2026-12-31',
    });
    expect(vario.metodo).toBe('promedio');
    expect(vario.base.toFixed()).toBe('2100000'); // (2.000.000 x 300 + 2.600.000 x 60) / 360
  });

  it('base con pagos variables promediados', () => {
    const b = basePrestaciones({
      historialSalario: [{ desde: '2026-01-01', salario: 2000000 }],
      variables: [
        { mes: '2026-01', variable: 300000 },
        { mes: '2026-02', variable: 300000 },
      ],
      desde: '2026-01-01',
      hasta: '2026-06-30',
      salarioVariable: true,
    });
    expect(b.base.toFixed()).toBe('2100000'); // 600.000 en 180 días = 100.000 mensual
  });

  it('semestre de la prima', () => {
    expect(semestreDe('2026-03-15')).toEqual({ desde: '2026-01-01', hasta: '2026-06-30' });
    expect(semestreDe('2026-10-28')).toEqual({ desde: '2026-07-01', hasta: '2026-12-31' });
  });
});

describe('Retención en la fuente', () => {
  const p = paramsRetencionPorDefecto(52374);

  it('tabla del art. 383', () => {
    expect(impuestoTabla(D(95), TABLA_383).toFixed()).toBe('0');
    expect(impuestoTabla(D(100), TABLA_383).toFixed()).toBe('0.95');
    expect(impuestoTabla(D(200), TABLA_383).toFixed()).toBe('24');
    expect(impuestoTabla(D(3000), TABLA_383).toFixed()).toBe('1043');
  });

  it('salario bajo no tiene retención', () => {
    const r = calcularRetencion({ ingresosLaborales: 3000000, ingresosNoConstitutivos: 240000, procedimiento: 1 }, p);
    expect(r.retencion.toFixed()).toBe('0');
  });

  it('procedimiento 1 con depuración completa (salario de $10.000.000)', () => {
    const r = calcularRetencion({ ingresosLaborales: 10000000, ingresosNoConstitutivos: 900000, procedimiento: 1 }, p);
    expect(r.baseGravable.toFixed()).toBe('6825000');
    expect(r.retencion.toFixed()).toBe('351000'); // 351.399,3 redondeado a mil
    expect(r.pasos.map((x) => x.concepto)).toContain('Base gravable');
  });

  it('el límite global del 40% recorta los beneficios', () => {
    const r = calcularRetencion(
      {
        ingresosLaborales: 10000000,
        ingresosNoConstitutivos: 900000,
        tieneDependiente: true,
        interesesVivienda: 5000000,
        medicinaPrepagada: 2000000,
        procedimiento: 1,
      },
      p,
    );
    // Neto 9.100.000 → límite 40% = 3.640.000 → base 5.460.000
    expect(r.baseGravable.toFixed()).toBe('5460000');
  });

  it('el 25% exento tiene tope de 790 UVT anuales', () => {
    const r = calcularRetencion({ ingresosLaborales: 40000000, ingresosNoConstitutivos: 0, procedimiento: 1 }, p);
    const exenta = r.pasos.find((x) => x.concepto.startsWith('(-) Renta exenta del 25'))!;
    expect(exenta.valor.toDecimalPlaces(0).toFixed()).toBe(D(790).div(12).mul(52374).toDecimalPlaces(0).toFixed());
  });

  it('procedimiento 2 con porcentaje fijo', () => {
    const r = calcularRetencion({ ingresosLaborales: 10000000, ingresosNoConstitutivos: 900000, procedimiento: 2, porcentajeFijo: '5.15' }, p);
    expect(r.retencion.toFixed()).toBe('351000'); // 6.825.000 x 5,15% = 351.487,5 → 351.000
  });

  it('cálculo del porcentaje del procedimiento 2', () => {
    const pct = porcentajeProcedimiento2(Array(12).fill(6825000), p);
    expect(pct.toFixed()).toBe('5.15');
  });

  it('los topes son configurables', () => {
    const sinExenta = { ...p, pctRentaExenta: D(0) };
    const r = calcularRetencion({ ingresosLaborales: 10000000, ingresosNoConstitutivos: 900000, procedimiento: 1 }, sinExenta);
    expect(r.baseGravable.toFixed()).toBe('9100000');
  });
});

describe('Indemnización y sanción moratoria', () => {
  it('HU-54: indefinido, menos de 10 SMMLV, 3 años → 70 días', () => {
    const r = calcularIndemnizacion({
      tipoContrato: 'indefinido',
      salarioMensual: 2000000,
      smmlv: 1750905,
      fechaIngreso: '2023-11-01',
      fechaRetiro: '2026-10-30',
    });
    expect(r.dias.toFixed()).toBe('70');
    expect(r.valor.toFixed()).toBe('4666667');
  });

  it('menos de un año: 30 días completos', () => {
    const r = calcularIndemnizacion({ tipoContrato: 'indefinido', salarioMensual: 3000000, smmlv: 1750905, fechaIngreso: '2026-05-01', fechaRetiro: '2026-10-30' });
    expect(r.dias.toFixed()).toBe('30');
    expect(r.valor.toFixed()).toBe('3000000');
  });

  it('10 SMMLV o más: 20 + 15 por año, con fracción proporcional', () => {
    const r = calcularIndemnizacion({ tipoContrato: 'indefinido', salarioMensual: 20000000, smmlv: 1750905, fechaIngreso: '2024-11-01', fechaRetiro: '2026-04-30' });
    // 540 días = 1,5 años → 20 + 15 x 0,5 = 27,5 días
    expect(r.dias.toFixed()).toBe('27.5');
  });

  it('término fijo: salarios del tiempo faltante', () => {
    const r = calcularIndemnizacion({
      tipoContrato: 'fijo',
      salarioMensual: 1800000,
      smmlv: 1750905,
      fechaIngreso: '2026-01-01',
      fechaRetiro: '2026-09-30',
      fechaFinPactada: '2026-12-31',
    });
    expect(r.dias.toFixed()).toBe('90');
    expect(r.valor.toFixed()).toBe('5400000');
  });

  it('obra o labor: mínimo 15 días', () => {
    const r = calcularIndemnizacion({
      tipoContrato: 'obra_labor',
      salarioMensual: 1800000,
      smmlv: 1750905,
      fechaIngreso: '2026-01-01',
      fechaRetiro: '2026-09-25',
      fechaFinPactada: '2026-09-30',
    });
    expect(r.dias.toFixed()).toBe('15');
  });

  it('sanción moratoria: un día de salario por día de retraso', () => {
    const r = calcularMoratoria({ salarioMensual: 3000000, smmlv: 1750905, fechaRetiro: '2026-10-01', fechaPago: '2026-10-11', saldoAdeudado: 5000000, tasaMoratoriaMensual: '0.02' });
    expect(r.dias).toBe(10);
    expect(r.valorDias.toFixed()).toBe('1000000');
    expect(r.intereses.toFixed()).toBe('0');
  });

  it('sanción moratoria: después de 24 meses, intereses (más de 1 SMMLV)', () => {
    const r = calcularMoratoria({ salarioMensual: 3000000, smmlv: 1750905, fechaRetiro: '2024-01-01', fechaPago: '2026-01-25', saldoAdeudado: 5000000, tasaMoratoriaMensual: '0.02' });
    expect(r.valorDias.toFixed()).toBe('72000000'); // 720 días
    expect(r.intereses.gt(0)).toBe(true);
  });
});
