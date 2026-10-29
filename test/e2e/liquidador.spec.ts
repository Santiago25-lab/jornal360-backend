import { Contexto, levantar } from './app';

/** Liquidador independiente: datos digitados o de Excel, sin tocar la nómina de la empresa. */
describe('API: liquidador independiente', () => {
  let c: Contexto;
  let id = '';

  beforeAll(async () => {
    c = await levantar('liquidador');
  });
  afterAll(async () => c?.cerrar());

  const ok = (r: { status: number; body: any }) => {
    if (![200, 201].includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body;
  };

  it('crea una liquidación de nómina con sus empleados y la liquida', async () => {
    const l = ok(await c.api('post', '/liquidador', { nombre: 'Octubre · Cliente ABC', clienteRazonSocial: 'Cliente ABC S.A.S.', clienteNit: '900123456', tipo: 'nomina', regimen: 'privado', desde: '2026-10-01', hasta: '2026-10-31' }));
    id = l.id;
    expect(l.campos.some((x: any) => x.clave === 'HED')).toBe(true);
    const sinEmpleados = await c.api('post', `/liquidador/${id}/liquidar`);
    expect(sinEmpleados.status).toBe(400);
    ok(await c.api('put', `/liquidador/${id}/empleados`, { empleados: [{ documento: '1', nombre: 'Laura', salario: 3600000 }, { documento: '2', nombre: '', salario: 0 }] }));
    const malo = await c.api('post', `/liquidador/${id}/liquidar`);
    expect(malo.status).toBe(400);
    expect(malo.body.errores.join(' ')).toContain('Fila 2');
    ok(await c.api('put', `/liquidador/${id}/empleados`, { empleados: [{ documento: '1', nombre: 'Laura', salario: 3600000 }, { documento: '2', nombre: 'Jhon', salario: '2.000.000', HED: 10 }] }));
    const r = ok(await c.api('post', `/liquidador/${id}/liquidar`));
    expect(r.estado).toBe('liquidada');
    expect(r.empleados[0].resultado.totales.neto).toBe('3312000');
    expect(r.totales.empleados).toBe(2);
    // La nómina de la empresa no se tocó.
    expect(ok(await c.api('get', '/empleados'))).toHaveLength(0);
    expect(ok(await c.api('get', '/periodos'))).toHaveLength(0);
  });

  it('los valores cambiados solo aplican a esa liquidación', async () => {
    const editado = ok(await c.api('patch', `/liquidador/${id}`, { parametros: { AUX_TRANSPORTE: '300000' } }));
    expect(editado.estado).toBe('borrador');
    const params = ok(await c.api('get', `/liquidador/${id}/parametros`));
    expect(params.find((p: any) => p.codigo === 'AUX_TRANSPORTE')).toMatchObject({ valor: '300000', modificado: true });
    const r = ok(await c.api('post', `/liquidador/${id}/liquidar`));
    const jhon = r.empleados.find((e: any) => e.datos.documento === '2').resultado;
    expect(jhon.lineas.find((x: any) => x.concepto === 'AUXILIO_TRANSPORTE').valor).toBe('300000');
    const empresa = ok(await c.api('get', '/parametros'));
    expect(empresa.find((p: any) => p.codigo === 'AUX_TRANSPORTE').valorActual).toBe('249095');
  });

  it('copia la liquidación para el mes siguiente', async () => {
    const n = ok(await c.api('post', `/liquidador/${id}/copiar`, { nombre: 'Noviembre · Cliente ABC', desde: '2026-11-01', hasta: '2026-11-30' }));
    expect(n.empleados).toHaveLength(2);
    expect(n.estado).toBe('borrador');
    expect(n.parametros).toEqual({ AUX_TRANSPORTE: '300000' });
    expect(ok(await c.api('get', '/liquidador'))).toHaveLength(2);
  });

  it('carga empleados desde la plantilla de Excel', async () => {
    const ret = ok(await c.api('post', '/liquidador', { nombre: 'Retiros', tipo: 'retiro', regimen: 'publico', desde: '2026-12-01', hasta: '2026-12-31' }));
    expect(ret.exonerada).toBe(false);
    const p = ok(await c.api('get', '/liquidador/plantilla/retiro'));
    // Se carga aquí: el arnés reinicia los módulos al levantar la API.
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(p.archivoBase64, 'base64') as any);
    const ws = wb.worksheets[0];
    const cols = (ws.getRow(1).values as any[]).slice(1);
    expect(cols).toEqual(expect.arrayContaining(['documento', 'fecha_retiro', 'sin_justa_causa']));
    ws.spliceRows(2, 1);
    const fila = (o: Record<string, unknown>) => ws.addRow(cols.map((k) => o[k] ?? ''));
    fila({ documento: '10', nombre: 'Ana', salario: 3600000, fecha_ingreso: '01/02/2024', fecha_retiro: '2026-12-31', cesantias_fna: 'sí' });
    fila({ documento: '11', nombre: 'Sin fecha', salario: 2000000 });
    const b64 = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
    const rev = ok(await c.api('post', `/liquidador/${ret.id}/importar`, { archivoBase64: b64, confirmar: false }));
    expect(rev.validas).toBe(1);
    expect(rev.errores[0].fila).toBe(3);
    ok(await c.api('post', `/liquidador/${ret.id}/importar`, { archivoBase64: b64, confirmar: true }));
    const r = ok(await c.api('post', `/liquidador/${ret.id}/liquidar`));
    const ana = r.empleados[0];
    expect(ana.datos.fecha_ingreso).toBe('2024-02-01');
    const conceptos = ana.resultado.lineas.map((x: any) => x.concepto);
    expect(conceptos).toEqual(expect.arrayContaining(['CESANTIAS', 'PRIMA_SERVICIOS', 'PRIMA_NAVIDAD', 'VACACIONES_COMPENSADAS', 'PRIMA_VACACIONES']));
    expect(conceptos).not.toContain('INTERESES_CESANTIAS'); // afiliada al FNA
  });

  it('descarga el resumen en Excel y el desprendible en PDF', async () => {
    const x = ok(await c.api('get', `/liquidador/${id}/excel`));
    expect(x.nombre).toContain('.xlsx');
    const l = ok(await c.api('get', `/liquidador/${id}`));
    const pdf = await c.http().get(`/api/liquidador/${id}/empleados/${l.empleados[0].id}/pdf`).set('Authorization', `Bearer ${c.token}`).buffer(true);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    ok(await c.api('delete', `/liquidador/${id}`));
    expect((await c.api('get', `/liquidador/${id}`)).status).toBe(404);
  });
});
