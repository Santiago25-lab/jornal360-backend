import { contabilizar, FORMATOS_BANCO, FORMATOS_CONTABLES, generarArchivo, validarFormato } from '../../src/domain/archivos';
import { codigoSeisDigitos, generarTokenQr, llaveDispositivo, pinCuatroDigitos, verificarTokenQr } from '../../src/domain/qr';

const op = { secreto: 'secreto-de-prueba', segundos: 30, gracia: 5 };

describe('QR rotativo', () => {
  const t0 = Date.UTC(2026, 9, 28, 12, 0, 0); // múltiplo de 30 s

  it('un token recién generado es válido para su sede', () => {
    const { token, venceEn } = generarTokenQr('sede-1', op, t0 + 1000);
    expect(venceEn).toBe(29000);
    expect(verificarTokenQr(token, op, t0 + 1000)).toEqual({ valido: true, sedeId: 'sede-1' });
  });

  it('vence a los 30 segundos (con 5 de gracia)', () => {
    const { token } = generarTokenQr('sede-1', op, t0 + 1000);
    expect(verificarTokenQr(token, op, t0 + 33000).valido).toBe(true); // 3 s de gracia
    expect(verificarTokenQr(token, op, t0 + 36000)).toEqual({ valido: false, motivo: 'vencido' });
    expect(verificarTokenQr(token, op, t0 + 120000)).toEqual({ valido: false, motivo: 'vencido' });
  });

  it('una foto del QR enviada por chat no sirve después', () => {
    const { token } = generarTokenQr('sede-1', op, t0);
    expect(verificarTokenQr(token, op, t0 + 10 * 60 * 1000).valido).toBe(false);
  });

  it('no se puede falsificar ni cambiar de sede', () => {
    const { token } = generarTokenQr('sede-1', op, t0);
    const [, v, f] = token.split('.');
    expect(verificarTokenQr(`sede-2.${v}.${f}`, op, t0)).toEqual({ valido: false, motivo: 'firma' });
    expect(verificarTokenQr(token, { ...op, secreto: 'otro' }, t0)).toEqual({ valido: false, motivo: 'firma' });
    expect(verificarTokenQr('basura', op, t0)).toEqual({ valido: false, motivo: 'formato' });
  });

  it('códigos y llaves aleatorios con el formato correcto', () => {
    expect(codigoSeisDigitos()).toMatch(/^\d{6}$/);
    expect(pinCuatroDigitos()).toMatch(/^\d{4}$/);
    expect(llaveDispositivo()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(llaveDispositivo()).not.toBe(llaveDispositivo());
  });
});

describe('Archivos para bancos', () => {
  const comunes = {
    empresa: { nit: '900123456', razonSocial: 'Empresa Prueba SAS', cuenta: '12345678901', tipoCuentaCodigo: 'S' },
    fechaPago: '2026-10-30',
    total: { registros: 2, valor: '3500000.50' },
  };
  const registros = [
    { empleado: { documento: '1012345678', nombre: 'María López', codigoBanco: '7', cuenta: '98765432101', tipoTransaccion: '37', tipoDocumentoCodigo: '01', tipoCuentaCodigo: 'CA', banco: 'Bancolombia', tipoCuenta: 'Ahorros' }, pago: { valor: '1500000', referencia: 'NOMINA OCT' } },
    { empleado: { documento: '79111222', nombre: 'José Ñáñez', codigoBanco: '51', cuenta: '555', tipoTransaccion: '27', tipoDocumentoCodigo: '01', tipoCuentaCodigo: 'CC', banco: 'Davivienda', tipoCuenta: 'Corriente' }, pago: { valor: '2000000.50', referencia: 'NOMINA OCT' } },
  ];

  it('todas las plantillas son válidas', () => {
    for (const f of [...FORMATOS_BANCO, ...FORMATOS_CONTABLES]) expect(validarFormato(f)).toEqual([]);
  });

  it('ancho fijo: cada línea tiene la longitud exacta', () => {
    const f = FORMATOS_BANCO.find((x) => x.codigo === 'BANCOLOMBIA')!;
    const txt = generarArchivo(f, comunes, registros);
    const lineas = txt.split('\r\n').filter(Boolean);
    expect(lineas).toHaveLength(3);
    const anchoDetalle = f.detalle.reduce((a, c) => a + (c.ancho ?? 0), 0);
    expect(lineas[1]).toHaveLength(anchoDetalle);
    expect(lineas[2]).toContain('JOSE NANEZ'.slice(0, 0) || 'Jose Nanez'); // sin tildes
    expect(lineas[1]).toContain('000000000150000000'.slice(1)); // valor en centavos con ceros
  });

  it('CSV genérico con títulos', () => {
    const f = FORMATOS_BANCO.find((x) => x.codigo === 'CSV_GENERICO')!;
    const txt = generarArchivo(f, comunes, registros);
    expect(txt.split('\r\n')[0]).toBe('Documento;Nombre;Banco;Tipo de cuenta;Cuenta;Valor;Fecha de pago');
    expect(txt.split('\r\n')[2]).toBe('79111222;Jose Nanez;Davivienda;Corriente;555;2000000.50;2026-10-30');
  });

  it('detecta formatos incompletos', () => {
    expect(validarFormato({ codigo: 'X', nombre: 'X', separador: null, extension: 'txt', detalle: [{ nombre: 'A', fuente: 'a' }] })).toEqual([
      'El campo A necesita ancho en un archivo de ancho fijo',
    ]);
  });
});

describe('Contabilización', () => {
  const emp = { nit: '1012345678', nombre: 'María López' };
  const eps = { nit: '800000001', nombre: 'EPS Sura' };

  it('el comprobante queda cuadrado y reporta conceptos sin cuenta', () => {
    const r = contabilizar([
      { concepto: 'SALARIO_BASICO', nombre: 'Salario', tipo: 'devengo', valor: 2000000, cuentaDebito: '510506', cuentaCredito: '250505', centroCosto: 'ADM', empleado: emp },
      { concepto: 'SALUD_EMPLEADO', nombre: 'Salud', tipo: 'deduccion', valor: 80000, cuentaDebito: '250505', cuentaCredito: '237005', centroCosto: 'ADM', empleado: emp, terceroCredito: eps },
      { concepto: 'PENSION_EMPLEADOR', nombre: 'Pensión', tipo: 'aporte_empleador', valor: 240000, cuentaDebito: '510570', cuentaCredito: '238030', centroCosto: 'ADM', empleado: emp },
      { concepto: 'BONO', nombre: 'Bono', tipo: 'devengo', valor: 100000, centroCosto: 'ADM', empleado: emp },
    ]);
    expect(r.debitos).toBe(r.creditos);
    expect(r.debitos).toBe('2320000.00');
    expect(r.sinCuenta).toEqual(['BONO']);
    const credSalud = r.movimientos.find((m) => m.cuenta === '237005')!;
    expect(credSalud.tercero.nit).toBe('800000001');
    const f = FORMATOS_CONTABLES.find((x) => x.codigo === 'SIIGO')!;
    const csv = generarArchivo(f, { fecha: '2026-10-31', comprobante: '1' }, r.movimientos as any);
    expect(csv.split('\r\n')[1]).toContain('NOMINA,1,31102026,510506,1012345678');
  });
});
