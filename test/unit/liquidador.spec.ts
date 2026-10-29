import { contextoLibre, liquidarLibre, listaParametros, num, OpcionesLiquidacion, validarEmpleado } from '../../src/domain/liquidador';

const octubre = (regimen: 'privado' | 'publico'): OpcionesLiquidacion => ({ tipo: 'nomina', regimen, desde: '2026-10-01', hasta: '2026-10-31' });
const valor = (r: { lineas: { concepto: string; valor: string }[] }, c: string) => r.lineas.find((l) => l.concepto === c)?.valor ?? '0';

describe('Liquidador independiente', () => {
  it('lee valores escritos a la colombiana', () => {
    expect(num('$ 1.750.905').toFixed()).toBe('1750905');
    expect(num('1750905,5').toFixed()).toBe('1750905.5');
    expect(num(2500000).toFixed()).toBe('2500000');
    expect(num('').toFixed()).toBe('0');
  });

  it('valida las filas antes de liquidar', () => {
    expect(validarEmpleado('nomina', { documento: '1', nombre: 'Ana', salario: 2000000 })).toEqual([]);
    expect(validarEmpleado('prima', { documento: '1', nombre: 'Ana', salario: 2000000 })).toContain('Falta la fecha de ingreso');
    expect(validarEmpleado('retiro', { documento: '1', nombre: 'Ana', salario: '0', fecha_ingreso: '2024-01-01' })).toEqual(expect.arrayContaining(['El salario debe ser mayor que cero', 'Falta fecha de retiro']));
    expect(validarEmpleado('nomina', { documento: '1', nombre: 'Ana', salario: 1, tipo_contrato: 'otro' })[0]).toContain('Tipo de contrato');
  });

  it('nómina privada: mismo resultado que la nómina de la empresa', () => {
    const r = liquidarLibre(octubre('privado'), { documento: '1', nombre: 'Laura', salario: 3600000, fecha_ingreso: '2024-02-01' }, contextoLibre('privado', {}, true), 'e1');
    expect(r.totales.neto).toBe('3312000');
    expect(valor(r, 'SALUD_EMPLEADOR')).toBe('0'); // exonerada
    const aux = liquidarLibre(octubre('privado'), { documento: '2', nombre: 'Jhon', salario: '2.000.000' }, contextoLibre('privado', {}, true), 'e2');
    expect(aux.totales.neto).toBe('2089095');
  });

  it('nómina pública: aportes ESAP y escuelas, primas públicas y sin intereses para el FNA', () => {
    const r = liquidarLibre(octubre('publico'), { documento: '1', nombre: 'Laura', salario: 3600000, fecha_ingreso: '2024-02-01', cesantias_fna: 'sí' }, contextoLibre('publico', {}, true), 'e1');
    expect(r.totales.neto).toBe('3312000');
    expect(valor(r, 'SALUD_EMPLEADOR')).toBe('306000'); // la entidad pública no se exonera
    expect(valor(r, 'SENA')).toBe('18000');
    expect(valor(r, 'APORTE_ESAP')).toBe('18000');
    expect(valor(r, 'APORTE_ESCUELAS_INDUSTRIALES')).toBe('36000');
    expect(valor(r, 'PROV_PRIMA')).toBe('150000');
    expect(valor(r, 'PROV_PRIMA_NAVIDAD')).toBe('300000');
    expect(valor(r, 'PROV_INTERESES')).toBe('0');
  });

  it('horas extra con la jornada del régimen y valores cambiados por el usuario', () => {
    const r = liquidarLibre(octubre('privado'), { documento: '1', nombre: 'A', salario: 2000000, HED: '10' }, contextoLibre('privado', {}, true), 'e');
    expect(valor(r, 'HED')).toBe('138889'); // 42 h: hora = 2.000.000 / 180
    const p = liquidarLibre(octubre('publico'), { documento: '1', nombre: 'A', salario: 2000000, HED: '10' }, contextoLibre('publico', {}, true), 'e');
    expect(valor(p, 'HED')).toBe('132576'); // 44 h: hora = 2.000.000 / 188,57
    const c = liquidarLibre(octubre('privado'), { documento: '2', nombre: 'B', salario: 2000000 }, contextoLibre('privado', { AUX_TRANSPORTE: '300000' }, true), 'e');
    expect(c.totales.neto).toBe('2140000');
    const lista = listaParametros('privado', { AUX_TRANSPORTE: '300000' }, '2026-10-31');
    expect(lista.find((x) => x.codigo === 'AUX_TRANSPORTE')).toMatchObject({ valor: '300000', porDefecto: '249095', modificado: true });
    expect(listaParametros('publico', {}, '2026-10-31').find((x) => x.codigo === 'HORAS_SEMANALES')?.valor).toBe('44');
  });

  it('prima, cesantías y vacaciones', () => {
    const seg = { tipo: 'prima' as const, regimen: 'privado' as const, desde: '2026-07-01', hasta: '2026-12-31' };
    const emp = { documento: '1', nombre: 'A', salario: 2000000, fecha_ingreso: '2024-01-01' };
    expect(valor(liquidarLibre(seg, emp, contextoLibre('privado', {}, true), 'e'), 'PRIMA_SERVICIOS')).toBe('1124548');
    const pub = { tipo: 'prima' as const, regimen: 'publico' as const, desde: '2025-07-01', hasta: '2026-06-30' };
    expect(valor(liquidarLibre(pub, { ...emp, salario: 3600000 }, contextoLibre('publico', {}, true), 'e'), 'PRIMA_SERVICIOS')).toBe('1800000');
    expect(valor(liquidarLibre({ ...pub, clasePrima: 'navidad', desde: '2026-01-01', hasta: '2026-12-31' }, { ...emp, salario: 3600000 }, contextoLibre('publico', {}, true), 'e'), 'PRIMA_NAVIDAD')).toBe('3600000');
    const ces = liquidarLibre({ tipo: 'cesantias', regimen: 'privado', desde: '2026-01-01', hasta: '2026-12-31' }, emp, contextoLibre('privado', {}, true), 'e');
    expect([valor(ces, 'CESANTIAS'), valor(ces, 'INTERESES_CESANTIAS')]).toEqual(['2249095', '269891']);
    const vac = liquidarLibre({ tipo: 'vacaciones', regimen: 'publico', desde: '2026-10-01', hasta: '2026-10-31' }, { ...emp, salario: 3600000 }, contextoLibre('publico', {}, true), 'e');
    expect([valor(vac, 'VACACIONES'), valor(vac, 'PRIMA_VACACIONES'), valor(vac, 'BONIF_RECREACION')]).toEqual(['1800000', '1800000', '240000']);
  });

  it('liquidación de contrato con indemnización y vacaciones del último año', () => {
    const r = liquidarLibre(
      { tipo: 'retiro', regimen: 'privado', desde: '2026-12-01', hasta: '2026-12-31' },
      { documento: '1', nombre: 'María', salario: 3000000, fecha_ingreso: '2024-01-01', fecha_retiro: '2026-12-31', sin_justa_causa: 'si' },
      contextoLibre('privado', {}, true),
      'e',
    );
    expect(valor(r, 'INDEMNIZACION')).toBe('7000000'); // 30 + 20 × 2 años = 70 días
    expect(valor(r, 'CESANTIAS')).toBe('3249095'); // con auxilio de transporte
    expect(valor(r, 'VACACIONES_COMPENSADAS')).toBe('1500000'); // 15 días del último año
    expect(r.alertas.some((a) => a.mensaje.includes('último periodo'))).toBe(true);
  });
});
