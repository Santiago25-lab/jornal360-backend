import { D } from '../../src/domain/decimal';
import { liquidarEmpleado } from '../../src/domain/nomina';
import { contexto, entrada, liquidar, parametrosCatalogo, v } from './helpers';

describe('Liquidación de nómina', () => {
  it('empleado básico de $2.000.000 en octubre de 2026', () => {
    const r = liquidar(entrada(2000000));
    expect(v(r, 'SALARIO_BASICO')).toBe('2000000');
    expect(v(r, 'AUXILIO_TRANSPORTE')).toBe('249095');
    expect(v(r, 'SALUD_EMPLEADO')).toBe('80000');
    expect(v(r, 'PENSION_EMPLEADO')).toBe('80000');
    expect(v(r, 'FONDO_SOLIDARIDAD')).toBe('0');
    expect(r.totales.neto).toBe('2089095');
    // Empresa exonerada: sin salud del empleador, ICBF ni SENA
    expect(v(r, 'SALUD_EMPLEADOR')).toBe('0');
    expect(v(r, 'ICBF')).toBe('0');
    expect(v(r, 'PENSION_EMPLEADOR')).toBe('240000');
    expect(v(r, 'ARL')).toBe('10440');
    expect(v(r, 'CAJA_COMPENSACION')).toBe('80000');
    // Provisiones
    expect(v(r, 'PROV_CESANTIAS')).toBe('187425');
    expect(v(r, 'PROV_INTERESES')).toBe('22491');
    expect(v(r, 'PROV_PRIMA')).toBe('187425');
    expect(v(r, 'PROV_VACACIONES')).toBe('83333');
    expect(r.dias.periodo).toBe(30);
  });

  it('empresa no exonerada paga salud del empleador, ICBF y SENA', () => {
    const r = liquidar(entrada(2000000), contexto({ empresa: { exonerada: false } }));
    expect(v(r, 'SALUD_EMPLEADOR')).toBe('170000');
    expect(v(r, 'ICBF')).toBe('60000');
    expect(v(r, 'SENA')).toBe('40000');
  });

  it('cada valor trae su paso a paso', () => {
    const r = liquidar(entrada(2000000));
    const salud = r.lineas.find((l) => l.concepto === 'SALUD_EMPLEADO')!;
    expect(salud.detalle.formula).toContain('IBC_SALUD * PCT_SALUD_EMPLEADO');
    expect(salud.detalle.variables).toMatchObject({ IBC_SALUD: '2000000', PCT_SALUD_EMPLEADO: '0.04' });
  });

  it('HU-41: hora de $10.000 con 42 horas y 2 extras diurnas = $25.000', () => {
    const r = liquidar(entrada(1800000, { horas: [{ fecha: '2026-10-28', tipo: 'HED', horas: 2 }] }));
    expect(v(r, 'HED')).toBe('25000');
    expect(r.lineas.find((l) => l.concepto === 'HED')!.cantidad).toBe('2');
  });

  it('todos los recargos combinados en día de descanso', () => {
    const r = liquidar(
      entrada(1800000, {
        horas: [
          { fecha: '2026-10-25', tipo: 'HDD', horas: 1 },
          { fecha: '2026-10-25', tipo: 'HDN', horas: 1 },
          { fecha: '2026-10-25', tipo: 'HEDD', horas: 1 },
          { fecha: '2026-10-25', tipo: 'HEND', horas: 1 },
          { fecha: '2026-10-28', tipo: 'HON', horas: 1 },
          { fecha: '2026-10-28', tipo: 'HEN', horas: 1 },
        ],
      }),
    );
    expect(v(r, 'HDD')).toBe('19000'); // 190%
    expect(v(r, 'HDN')).toBe('22500'); // 225%
    expect(v(r, 'HEDD')).toBe('21500'); // 215%
    expect(v(r, 'HEND')).toBe('26500'); // 265%
    expect(v(r, 'HON')).toBe('3500'); // solo el 35%: la hora ya está en el salario
    expect(v(r, 'HEN')).toBe('17500'); // 175%, sin sumar el nocturno
  });

  it('HU-07: el recargo de domingo cambia del 80% al 90% el 1 de julio de 2026 dentro del mismo periodo', () => {
    const r = liquidar(
      entrada(1800000, {
        periodo: { desde: '2026-06-16', hasta: '2026-07-15' },
        horas: [
          { fecha: '2026-06-28', tipo: 'HDD', horas: 8 },
          { fecha: '2026-07-05', tipo: 'HDD', horas: 8 },
        ],
      }),
    );
    const hora44 = D(1800000).div(D(44).mul(30).div(7));
    const esperado = hora44.mul(8).mul('1.8').plus(hora44.mul(8).mul('1.9')).toDecimalPlaces(0);
    expect(v(r, 'HDD')).toBe(esperado.toFixed());
    const linea = r.lineas.find((l) => l.concepto === 'HDD')!;
    expect(linea.detalle.tramos!.map((t) => t.variables['RECARGO_DESCANSO'])).toEqual(['0.8', '0.9']);
  });

  it('HU-40: empleado que ingresa el día 10 recibe 21 días', () => {
    const r = liquidar(
      entrada(3000000, {
        periodo: { desde: '2026-01-01', hasta: '2026-01-31' },
        contrato: { tipo: 'indefinido', fechaInicio: '2026-01-10', historialSalario: [{ desde: '2026-01-10', salario: 3000000 }] },
      }),
    );
    expect(r.dias.periodo).toBe(21);
    expect(v(r, 'SALARIO_BASICO')).toBe('2100000');
  });

  it('HU-19: aumento desde el día 16 se paga por tramos', () => {
    const r = liquidar(
      entrada(0, {
        contrato: {
          tipo: 'indefinido',
          fechaInicio: '2024-01-01',
          historialSalario: [
            { desde: '2024-01-01', salario: 2000000 },
            { desde: '2026-10-16', salario: 2400000 },
          ],
        },
      }),
    );
    expect(v(r, 'SALARIO_BASICO')).toBe('2200000');
  });

  it('HU-33: incapacidad de 5 días con salario de $3.000.000', () => {
    const r = liquidar(entrada(3000000, { novedadesDias: [{ tipo: 'incapacidad_eg', desde: '2026-10-05', hasta: '2026-10-09' }] }));
    expect(v(r, 'INCAPACIDAD_EMPLEADOR')).toBe('133340');
    expect(v(r, 'INCAPACIDAD_EPS')).toBe('200010');
    expect(v(r, 'SALARIO_BASICO')).toBe('2500000');
    expect(r.bases.ibcSalud).toBe('2833350');
  });

  it('incapacidad con salario mínimo: no baja del SMMLV diario', () => {
    const r = liquidar(entrada(1750905, { novedadesDias: [{ tipo: 'incapacidad_eg', desde: '2026-10-05', hasta: '2026-10-09' }] }));
    expect(v(r, 'INCAPACIDAD_EMPLEADOR')).toBe('116727'); // 2 x 58.363,5
    expect(v(r, 'INCAPACIDAD_EPS')).toBe('175091'); // 3 x 58.363,5 = 175.090,5
  });

  it('prórroga: los días anteriores cuentan para el tramo del 50% (día 91 en adelante)', () => {
    const r = liquidar(entrada(6000000, { novedadesDias: [{ tipo: 'incapacidad_eg', desde: '2026-10-01', hasta: '2026-10-10', diasPrevios: 85 }] }));
    // días 86-90 al 66,67% y 91-95 al 50%, todo EPS; diario 200.000
    expect(v(r, 'INCAPACIDAD_EPS')).toBe(D(200000).mul('0.6667').mul(5).plus(D(200000).mul('0.5').mul(5)).toFixed());
    expect(v(r, 'INCAPACIDAD_EMPLEADOR')).toBe('0');
  });

  it('la empresa puede completar el 100% de la incapacidad', () => {
    const ctx = contexto({ parametros: parametrosCatalogo().con('EMPRESA_COMPLETA_INCAPACIDAD', '2020-01-01', 1) });
    const r = liquidar(entrada(3000000, { novedadesDias: [{ tipo: 'incapacidad_eg', desde: '2026-10-05', hasta: '2026-10-09' }] }), ctx);
    expect(v(r, 'COMPLEMENTO_INCAPACIDAD')).toBe('166650'); // 5 x (100.000 - 66.670)
  });

  it('incapacidad laboral al 100% a cargo de la ARL', () => {
    const r = liquidar(entrada(3000000, { novedadesDias: [{ tipo: 'incapacidad_laboral', desde: '2026-10-05', hasta: '2026-10-09' }] }));
    expect(v(r, 'INCAPACIDAD_LABORAL')).toBe('500000');
  });

  it('HU-43: regla del 40% con auxilio no salarial de $1.500.000', () => {
    const r = liquidar(entrada(2000000, { novedadesValor: [{ concepto: 'AUXILIO_NO_SALARIAL', valor: 1500000 }] }));
    expect(r.bases.ibcSalud).toBe('2100000');
    expect(v(r, 'SALUD_EMPLEADO')).toBe('84000');
    expect(v(r, 'PENSION_EMPLEADO')).toBe('84000');
  });

  it('Fondo de Solidaridad al 1% desde 4 SMMLV', () => {
    const r = liquidar(entrada(8754525));
    expect(v(r, 'FONDO_SOLIDARIDAD')).toBe('87545');
  });

  it('salario integral: IBC al 70%, sin prestaciones y con exoneración no aplicable', () => {
    const r = liquidar(entrada(25000000, { contrato: { tipo: 'integral', fechaInicio: '2024-01-01', salarioIntegral: true, historialSalario: [{ desde: '2024-01-01', salario: 25000000 }] } }));
    expect(v(r, 'SALARIO_INTEGRAL')).toBe('25000000');
    expect(v(r, 'SALARIO_BASICO')).toBe('0');
    expect(v(r, 'AUXILIO_TRANSPORTE')).toBe('0');
    expect(r.bases.ibcSalud).toBe('17500000');
    expect(v(r, 'FONDO_SOLIDARIDAD')).toBe('175000');
    expect(v(r, 'SALUD_EMPLEADOR')).toBe('1487500');
    expect(v(r, 'PROV_CESANTIAS')).toBe('0');
    expect(Number(v(r, 'RETENCION_FUENTE'))).toBeGreaterThan(0);
  });

  it('aprendiz en fase lectiva: 75% del SMMLV, salud plena del empleador, sin pensión ni caja', () => {
    const r = liquidar(entrada(0, { contrato: { tipo: 'aprendizaje', fechaInicio: '2026-01-01', faseAprendiz: 'lectiva', historialSalario: [] } }));
    expect(v(r, 'APOYO_SOSTENIMIENTO')).toBe('1313179');
    expect(v(r, 'SALUD_EMPLEADO')).toBe('0');
    expect(v(r, 'PENSION_EMPLEADO')).toBe('0');
    expect(v(r, 'SALUD_EMPLEADOR')).toBe('218863');
    expect(v(r, 'CAJA_COMPENSACION')).toBe('0');
    expect(Number(v(r, 'ARL'))).toBeGreaterThan(0);
    expect(v(r, 'PROV_CESANTIAS')).toBe('0');
  });

  it('aprendiz en fase práctica: 100% del SMMLV y prestaciones', () => {
    const r = liquidar(entrada(0, { contrato: { tipo: 'aprendizaje', fechaInicio: '2026-01-01', faseAprendiz: 'practica', historialSalario: [] } }));
    expect(v(r, 'APOYO_SOSTENIMIENTO')).toBe('1750905');
    expect(v(r, 'PENSION_EMPLEADO')).toBe('70036');
    expect(Number(v(r, 'PROV_CESANTIAS'))).toBeGreaterThan(0);
  });

  it('HU-44: embargo ordinario a salario de $3.000.000 = 1/5 del excedente', () => {
    const r = liquidar(entrada(3000000, { embargos: [{ id: 'EM1', descripcion: 'Juzgado 1', tipo: 'ordinario', porcentaje: 1 }] }));
    expect(v(r, 'EMBARGO')).toBe('249819');
  });

  it('embargo por alimentos hasta el 50%', () => {
    const r = liquidar(entrada(3000000, { embargos: [{ id: 'EM2', descripcion: 'Alimentos', tipo: 'alimentos', valorFijo: 5000000 }] }));
    // (3.000.000 - 240.000 de ley) x 50% = 1.380.000
    expect(v(r, 'EMBARGO')).toBe('1380000');
    expect(r.pendientes[0].noAplicado).toBe('3620000');
  });

  it('HU-44: préstamo en cuotas y protección del salario mínimo', () => {
    const r = liquidar(entrada(3000000, { prestamos: [{ id: 'P1', descripcion: 'Préstamo', cuota: 100000, saldo: 600000, tipo: 'prestamo' }] }));
    expect(v(r, 'PRESTAMO')).toBe('100000');
    const r2 = liquidar(entrada(1750905, { prestamos: [{ id: 'P2', descripcion: 'Grande', cuota: 500000, saldo: 500000, tipo: 'prestamo' }] }));
    // disponible 2.000.000 - 140.072 = 1.859.928; mínimo protegido 1.750.905 → 109.023
    expect(v(r2, 'PRESTAMO')).toBe('109023');
    expect(r2.pendientes[0].noAplicado).toBe('390977');
    expect(r2.alertas.some((a) => a.mensaje.includes('no se aplicaron'))).toBe(true);
  });

  it('retención de un salario de $10.000.000 (procedimiento 1)', () => {
    const r = liquidar(entrada(10000000));
    expect(v(r, 'RETENCION_FUENTE')).toBe('351000');
    expect(r.retencion!.baseGravable).toBe('6825000');
  });

  it('retención quincenal: solo en la quincena que cierra el mes, sobre el mes completo', () => {
    const q1 = liquidar(entrada(10000000, { periodo: { desde: '2026-10-01', hasta: '2026-10-15' } }));
    expect(v(q1, 'RETENCION_FUENTE')).toBe('0');
    const q2 = liquidar(
      entrada(10000000, {
        periodo: { desde: '2026-10-16', hasta: '2026-10-31' },
        acumuladoMes: { ingresosRetencion: 5000000, noConstitutivos: 450000, retencionPracticada: 0 },
      }),
    );
    expect(v(q2, 'RETENCION_FUENTE')).toBe('351000');
  });

  it('vacaciones disfrutadas: salario de los días trabajados + vacaciones', () => {
    const r = liquidar(entrada(3000000, { novedadesDias: [{ tipo: 'vacaciones', desde: '2026-10-13', hasta: '2026-10-27' }] }));
    expect(v(r, 'SALARIO_BASICO')).toBe('1500000');
    expect(v(r, 'VACACIONES_DISFRUTADAS')).toBe('1500000');
    expect(r.bases.ibcSalud).toBe('3000000');
  });

  it('vacaciones compensadas en dinero', () => {
    const r = liquidar(entrada(3000000, { novedadesValor: [{ concepto: 'VACACIONES_COMPENSADAS', cantidad: 7 }] }));
    expect(v(r, 'VACACIONES_COMPENSADAS')).toBe('700000');
    expect(r.bases.ibcSalud).toBe('3000000'); // no cotiza
  });

  it('licencia no remunerada de 3 días', () => {
    const r = liquidar(entrada(1800000, { novedadesDias: [{ tipo: 'licencia_no_remunerada', desde: '2026-10-05', hasta: '2026-10-07' }] }));
    expect(v(r, 'SALARIO_BASICO')).toBe('1620000');
    expect(v(r, 'AUXILIO_TRANSPORTE')).toBe('224186');
    expect(r.dias.cotizados).toBe(27);
  });

  it('licencia de maternidad a cargo de la EPS', () => {
    const r = liquidar(entrada(3000000, { novedadesDias: [{ tipo: 'licencia_maternidad', desde: '2026-10-01', hasta: '2027-02-04' }] }));
    expect(v(r, 'LICENCIA_EPS')).toBe('3000000');
    expect(v(r, 'SALARIO_BASICO')).toBe('0');
  });

  it('comisiones como novedad', () => {
    const r = liquidar(entrada(2000000, { novedadesValor: [{ concepto: 'COMISIONES', valor: 750000 }] }));
    expect(v(r, 'COMISIONES')).toBe('750000');
    expect(r.bases.ibcSalud).toBe('2750000');
    expect(v(r, 'AUXILIO_TRANSPORTE')).toBe('249095'); // el tope mira el salario básico
  });

  it('HU-11: concepto propio con fórmula (prima de antigüedad)', () => {
    const ctx = contexto();
    ctx.conceptos.push({
      codigo: 'PRIMA_ANTIGUEDAD',
      nombre: 'Prima de antigüedad',
      tipo: 'devengo',
      formula: 'SI(ANTIGUEDAD_ANOS >= 5; SALARIO * 0,10; 0)',
      salarial: true,
      baseIbc: true,
      baseArl: true,
      baseParafiscales: true,
      basePrestaciones: true,
      baseVacaciones: true,
      baseRetencion: true,
      cuenta40: false,
      orden: 70,
      esLegal: false,
    });
    const r = liquidar(entrada(3000000, { empleado: { id: 'E', fechaIngreso: '2020-06-01', claseRiesgo: 1 } }), ctx);
    expect(v(r, 'PRIMA_ANTIGUEDAD')).toBe('300000');
    const r2 = liquidar(entrada(3000000, { empleado: { id: 'E', fechaIngreso: '2023-06-01', claseRiesgo: 1 } }), ctx);
    expect(v(r2, 'PRIMA_ANTIGUEDAD')).toBe('0');
  });

  it('calculadora: cambiar un porcentaje cambia el resultado', () => {
    const ctx = contexto({ parametros: parametrosCatalogo().con('PCT_SALUD_EMPLEADO', '2026-01-01', '0.05') });
    const r = liquidar(entrada(2000000), ctx);
    expect(v(r, 'SALUD_EMPLEADO')).toBe('100000');
  });

  it('calculadora: cambiar la fórmula de un concepto legal', () => {
    const ctx = contexto();
    ctx.conceptos.find((c) => c.codigo === 'AUXILIO_TRANSPORTE')!.formula = '300000';
    const r = liquidar(entrada(2000000), ctx);
    expect(v(r, 'AUXILIO_TRANSPORTE')).toBe('300000');
  });

  it('una fórmula inválida genera alerta sin romper la liquidación', () => {
    const ctx = contexto();
    ctx.conceptos.find((c) => c.codigo === 'AUXILIO_TRANSPORTE')!.formula = 'SALARIO * ';
    const r = liquidar(entrada(2000000), ctx);
    expect(r.alertas.some((a) => a.nivel === 'error' && a.mensaje.includes('Auxilio'))).toBe(true);
    expect(v(r, 'SALARIO_BASICO')).toBe('2000000');
  });

  it('contrato que no cubre el periodo no se liquida', () => {
    const e = entrada(2000000, { contrato: { tipo: 'indefinido', fechaInicio: '2026-11-01', historialSalario: [{ desde: '2026-11-01', salario: 2000000 }] } });
    expect(liquidarEmpleado(e, contexto())).toBeNull();
  });

  it('retiro a mitad de mes', () => {
    const r = liquidar(entrada(3000000, { contrato: { tipo: 'indefinido', fechaInicio: '2024-01-01', fechaFin: '2026-10-20', historialSalario: [{ desde: '2024-01-01', salario: 3000000 }] } }));
    expect(v(r, 'SALARIO_BASICO')).toBe('2000000');
  });

  it('pensionado no aporta a pensión', () => {
    const r = liquidar(entrada(3000000, { empleado: { id: 'E', esPensionado: true, claseRiesgo: 1 } }));
    expect(v(r, 'PENSION_EMPLEADO')).toBe('0');
    expect(v(r, 'PENSION_EMPLEADOR')).toBe('0');
  });

  it('febrero: 30 días comerciales', () => {
    const r = liquidar(entrada(3000000, { periodo: { desde: '2026-02-01', hasta: '2026-02-28' } }));
    expect(v(r, 'SALARIO_BASICO')).toBe('3000000');
  });

  it('clase de riesgo V', () => {
    const r = liquidar(entrada(2000000, { empleado: { id: 'E', claseRiesgo: 5 } }));
    expect(v(r, 'ARL')).toBe('139200');
  });
});
