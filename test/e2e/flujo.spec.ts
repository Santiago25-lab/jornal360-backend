import { Contexto, levantar } from './app';

/** Flujo completo de una empresa, de punta a punta, contra PostgreSQL real. */
describe('API: flujo completo de nómina y asistencia', () => {
  let c: Contexto;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    c = await levantar('flujo');
  });
  afterAll(async () => c?.cerrar());

  const ok = (r: { status: number; body: any }, esperado = [200, 201]) => {
    if (!esperado.includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body;
  };

  it('prepara estructura: EPS, fondo, grupo de pago y sede', async () => {
    ids.eps = ok(await c.api('post', '/entidades', { tipo: 'eps', nombre: 'EPS Prueba', nit: '800000001' })).id;
    ids.afp = ok(await c.api('post', '/entidades', { tipo: 'afp', nombre: 'Fondo Prueba', nit: '800000002' })).id;
    ids.ces = ok(await c.api('post', '/entidades', { tipo: 'cesantias', nombre: 'Cesantías Prueba', nit: '800000003' })).id;
    ids.grupo = ok(await c.api('get', '/grupos-pago'))[0].id;
    ids.sede = ok(await c.api('get', '/sedes'))[0].id;
    ids.turno = ok(await c.api('get', '/turnos'))[0].id;
    expect(ids.grupo && ids.sede && ids.turno).toBeTruthy();
  });

  it('HU-15 y HU-17: crea empleados con contrato', async () => {
    const base = { epsId: ids.eps, afpId: ids.afp, cesantiasId: ids.ces, grupoPagoId: ids.grupo, sedeId: ids.sede, turnoId: ids.turno, aceptaTratamientoDatos: true, banco: 'Bancolombia', tipoCuenta: 'Ahorros' };
    const e1 = ok(await c.api('post', '/empleados', { ...base, numeroDocumento: '1012345678', nombres: 'María', apellidos: 'López', numeroCuenta: '12345678901' }));
    ids.e1 = e1.id;
    expect(e1.autorizacionDatosEn).toBeTruthy();
    const dup = await c.api('post', '/empleados', { ...base, numeroDocumento: '1012345678', nombres: 'X', apellidos: 'Y' });
    expect(dup.status).toBe(409);
    const e2 = ok(await c.api('post', '/empleados', { ...base, numeroDocumento: '79111222', nombres: 'José', apellidos: 'Pérez', marcaEnKiosco: true }));
    ids.e2 = e2.id;

    const bajo = await c.api('post', `/empleados/${ids.e1}/contratos`, { tipo: 'indefinido', fechaInicio: '2024-01-01', salario: 1000000 });
    expect(bajo.status).toBe(409);
    expect(bajo.body.requiereConfirmacion).toBe(true);
    ok(await c.api('post', `/empleados/${ids.e1}/contratos`, { tipo: 'indefinido', fechaInicio: '2024-01-01', salario: 3000000, cargo: 'Analista' }));
    const fijoSinFin = await c.api('post', `/empleados/${ids.e2}/contratos`, { tipo: 'fijo', fechaInicio: '2026-01-01', salario: 1750905 });
    expect(fijoSinFin.status).toBe(400);
    const largo = await c.api('post', `/empleados/${ids.e2}/contratos`, { tipo: 'fijo', fechaInicio: '2026-01-01', fechaFin: '2031-01-01', salario: 1750905 });
    expect(largo.body.mensaje).toContain('4 años');
    ok(await c.api('post', `/empleados/${ids.e2}/contratos`, { tipo: 'fijo', fechaInicio: '2026-01-01', fechaFin: '2026-11-30', salario: 1750905, cargo: 'Operario' }));
    const lista = ok(await c.api('get', '/empleados?buscar=lópez'));
    expect(lista).toHaveLength(1);
    expect(lista[0].salario).toBe('3000000');
  });

  it('HU-21: contrato por vencer y certificado laboral en PDF', async () => {
    const v = ok(await c.api('get', '/empleados/contratos-por-vencer?dias=400'));
    expect(v.some((x: any) => x.empleadoId === ids.e2)).toBe(true);
    const pdf = await c.http().get(`/api/empleados/${ids.e1}/certificado-laboral`).set('Authorization', `Bearer ${c.token}`).buffer(true);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
  });

  let llave = '';
  it('HU-24: vincula el celular con código y cédula', async () => {
    const v = ok(await c.api('post', `/asistencia/empleados/${ids.e1}/vincular`));
    expect(v.codigo).toMatch(/^\d{6}$/);
    const info = ok(await c.http().get(`/api/publico/vincular/${v.token}`));
    expect(info.empleado).toBe('María López');
    const mal = await c.http().post('/api/publico/vincular').send({ token: v.token, documento: '999', aceptaDatos: true });
    expect(mal.body.mensaje).toContain('no coincide');
    const sinDatos = await c.http().post('/api/publico/vincular').send({ token: v.token, documento: '1012345678', aceptaDatos: false });
    expect(sinDatos.body.mensaje).toContain('tratamiento de datos');
    const r = ok(await c.http().post('/api/publico/vincular').send({ codigo: v.codigo, documento: '1012345678', aceptaDatos: true, descripcion: 'Android Chrome' }));
    llave = r.llave;
    const reuso = await c.http().post('/api/publico/vincular').send({ token: v.token, documento: '1012345678', aceptaDatos: true });
    expect(reuso.status).toBe(400);
    // Un celular, un empleado: el mismo celular no puede vincular a José
    const v2 = ok(await c.api('post', `/asistencia/empleados/${ids.e2}/vincular`));
    const otro = await c.http().post('/api/publico/vincular').send({ token: v2.token, documento: '79111222', aceptaDatos: true, llaveActual: llave });
    expect(otro.body.mensaje).toContain('ya está vinculado a otro empleado');
  });

  it('HU-23 y HU-25: marca entrada y salida escaneando el QR de la sede', async () => {
    const qr = ok(await c.api('get', `/asistencia/sedes/${ids.sede}/qr`));
    expect(qr.url).toContain('/marcar?t=');
    const est = ok(await c.http().post('/api/publico/marcar/estado').send({ qr: qr.token, llave }));
    expect(est).toMatchObject({ nombre: 'María', siguiente: 'entrada' });
    const m1 = ok(await c.http().post('/api/publico/marcar').send({ qr: qr.token, llave }));
    expect(m1.tipo).toBe('entrada');
    const dup = ok(await c.http().post('/api/publico/marcar').send({ qr: qr.token, llave }));
    expect(dup.duplicada).toBe(true);
    const sinVincular = await c.http().post('/api/publico/marcar').send({ qr: qr.token, llave: 'x'.repeat(43) });
    expect(sinVincular.status).toBe(403);
    const falso = await c.http().post('/api/publico/marcar').send({ qr: qr.token.replace(/.$/, 'Z'), llave });
    expect(falso.status).toBe(400);
  });

  let llaveKiosco = '';
  it('HU-27 y HU-28: kiosco con cédula y PIN', async () => {
    const k = ok(await c.api('post', '/asistencia/kioscos', { nombre: 'Portería', sedeId: ids.sede }));
    const cod = ok(await c.api('post', `/asistencia/kioscos/${k.id}/vincular`));
    llaveKiosco = ok(await c.http().post('/api/publico/kiosco/vincular').send({ codigo: cod.codigo })).llave;
    const pin = ok(await c.api('post', `/empleados/${ids.e2}/pin`)).pin;
    const malPin = await c.http().post('/api/publico/kiosco/identificar').send({ llave: llaveKiosco, documento: '79111222', pin: pin === '0000' ? '1111' : '0000' });
    expect(malPin.status).toBe(401);
    const id = ok(await c.http().post('/api/publico/kiosco/identificar').send({ llave: llaveKiosco, documento: '79111222', pin }));
    expect(id).toMatchObject({ empleado: 'José Pérez', siguiente: 'entrada', excepcion: false });
    const m = ok(await c.http().post('/api/publico/kiosco/marcar').send({ llave: llaveKiosco, documento: '79111222', pin }));
    expect(m.tipo).toBe('entrada');
  });

  it('HU-29 y HU-30: marcación asistida y corrección con motivo', async () => {
    // Fecha fija distinta de hoy: las marcaciones reales del QR y del kiosco son de hoy y no deben mezclarse.
    const a = ok(await c.api('post', '/asistencia/marcaciones', { empleadoId: ids.e2, tipo: 'entrada', hora: '2026-10-21T07:00', motivo: 'Sin batería' }));
    expect(a.origen).toBe('asistida');
    ok(await c.api('post', '/asistencia/correcciones', { empleadoId: ids.e2, tipo: 'salida', hora: '2026-10-21T20:24', motivo: 'Olvidó marcar la salida' }));
    const sinMotivo = await c.api('post', '/asistencia/marcaciones', { empleadoId: ids.e2, motivo: '' });
    expect(sinMotivo.status).toBe(400);
    const hoy = ok(await c.api('get', '/asistencia/hoy'));
    expect(hoy.presentes).toBeGreaterThanOrEqual(1);
  });

  it('HU-31 y HU-32: calcula las horas, las aprueba y genera el registro de extras', async () => {
    const r = ok(await c.api('post', '/asistencia/procesar', { desde: '2026-10-21', hasta: '2026-10-21', empleadoId: ids.e2 }));
    expect(r.procesados).toBe(1);
    const horas = ok(await c.api('get', `/asistencia/horas?desde=2026-10-21&hasta=2026-10-21&empleadoId=${ids.e2}`));
    const tipos = Object.fromEntries(horas.map((h: any) => [h.tipo, h.horas]));
    expect(tipos).toEqual({ HED: '3.6', HEN: '1.4' });
    ok(await c.api('post', '/asistencia/horas/aprobar', { ids: horas.map((h: any) => h.id), aprobar: true, actividad: 'Inventario' }));
    const reg = ok(await c.api('get', `/asistencia/registro-extras/${ids.e2}?desde=2026-10-01&hasta=2026-10-31`));
    expect(reg.registros).toHaveLength(2);
    expect(reg.registros[1].jornada).toBe('nocturna');
    const alertas = ok(await c.api('get', '/asistencia/alertas?desde=2026-10-21&hasta=2026-10-21'));
    expect(alertas.some((a: any) => a.tipo === 'exceso_extras_dia')).toBe(true);
  });

  it('asistencia del día: entrada, salida, llegada tarde, salida anticipada y horas', async () => {
    const d = ok(await c.api('get', '/asistencia/diario?fecha=2026-10-21'));
    const jose = d.filas.find((f: any) => f.empleadoId === ids.e2);
    expect(jose).toMatchObject({ entrada: '07:00', salida: '20:24', minutosTarde: 0, minutosAntes: 0, minutosTrabajados: 804, estado: 'completo' });
    const maria = d.filas.find((f: any) => f.empleadoId === ids.e1);
    expect(maria).toMatchObject({ entrada: null, salida: null, estado: 'no_llego' });
    // Llegó 40 minutos tarde y salió dos horas antes del fin del turno (7:00 a 15:24).
    ok(await c.api('post', '/asistencia/marcaciones', { empleadoId: ids.e1, tipo: 'entrada', hora: '2026-10-22T07:40', motivo: 'Prueba' }));
    ok(await c.api('post', '/asistencia/marcaciones', { empleadoId: ids.e1, tipo: 'salida', hora: '2026-10-22T13:24', motivo: 'Prueba' }));
    const d2 = ok(await c.api('get', '/asistencia/diario?fecha=2026-10-22'));
    expect(d2.filas.find((f: any) => f.empleadoId === ids.e1)).toMatchObject({ entrada: '07:40', salida: '13:24', minutosTarde: 40, minutosAntes: 120, minutosTrabajados: 344, estado: 'completo' });
    expect(d2.resumen).toMatchObject({ tarde: 1, salieronAntes: 1 });
  });

  it('HU-33 a HU-39: novedades, vacaciones, préstamos y embargos', async () => {
    const inc = ok(await c.api('post', '/novedades/dias', { empleadoId: ids.e1, tipo: 'incapacidad_eg', desde: '2026-10-05', hasta: '2026-10-09', diagnostico: 'J00' }));
    expect(inc.diasCalendario).toBe(5);
    const cruce = await c.api('post', '/novedades/dias', { empleadoId: ids.e1, tipo: 'licencia_remunerada', subtipo: 'luto', desde: '2026-10-08' });
    expect(cruce.body.mensaje).toContain('Se cruza');
    const luto = ok(await c.api('post', '/novedades/dias', { empleadoId: ids.e1, tipo: 'licencia_remunerada', subtipo: 'luto', desde: '2026-10-19' }));
    expect(luto.hasta).toBe('2026-10-23'); // 5 días hábiles desde el lunes 19
    const saldo = ok(await c.api('get', `/novedades/vacaciones/${ids.e1}/saldo?corte=2026-10-31`));
    expect(Number(saldo.causados)).toBeGreaterThan(40);
    const vac = await c.api('post', '/novedades/dias', { empleadoId: ids.e1, tipo: 'vacaciones', desde: '2026-12-01', diasHabiles: 15 });
    expect([201, 409]).toContain(vac.status);
    const com = ok(await c.api('post', '/novedades/valor', { empleadoId: ids.e1, concepto: 'comisiones', fecha: '2026-10-31', valor: 500000 }));
    expect(com.tipo).toBe('COMISIONES');
    const sinAut = await c.api('post', '/prestamos', { empleadoId: ids.e1, tipo: 'prestamo', descripcion: 'Préstamo', valorTotal: 600000, numeroCuotas: 6, fechaInicio: '2026-10-01', autorizacionEscrita: false });
    expect(sinAut.body.mensaje).toContain('autorización escrita');
    ids.prestamo = ok(await c.api('post', '/prestamos', { empleadoId: ids.e1, tipo: 'prestamo', descripcion: 'Préstamo', valorTotal: 600000, numeroCuotas: 6, fechaInicio: '2026-10-01', autorizacionEscrita: true })).id;
    ok(await c.api('post', '/embargos', { empleadoId: ids.e1, tipo: 'ordinario', descripcion: 'Juzgado 1 civil', porcentaje: '0.5', saldo: 1000000 }));
  });

  it('HU-40 a HU-46: liquida la nómina de octubre con el paso a paso', async () => {
    const sug = ok(await c.api('get', `/periodos/sugerir/${ids.grupo}`));
    expect(sug.hasta >= sug.desde).toBe(true);
    const p = ok(await c.api('post', '/periodos', { grupoPagoId: ids.grupo, desde: '2026-10-01', hasta: '2026-10-31', nombre: 'Nómina octubre 2026' }));
    ids.periodo = p.id;
    const cruce = await c.api('post', '/periodos', { grupoPagoId: ids.grupo, desde: '2026-10-15', hasta: '2026-11-15' });
    expect(cruce.body.mensaje).toContain('Se cruza');
    const sim = ok(await c.api('post', `/periodos/${p.id}/simular`, {}));
    expect(sim.totales.empleados).toBe(2);
    const liq = ok(await c.api('post', `/periodos/${p.id}/liquidar`, {}));
    expect(liq.periodo.estado).toBe('liquidado');
    const maria = ok(await c.api('get', `/periodos/${p.id}/empleados/${ids.e1}`));
    const v = (k: string) => maria.lineas.filter((l: any) => l.concepto === k).reduce((a: number, l: any) => a + Number(l.valor), 0);
    expect(v('SALARIO_BASICO')).toBe(2500000);
    expect(v('INCAPACIDAD_EMPLEADOR')).toBe(133340);
    expect(v('INCAPACIDAD_EPS')).toBe(200010);
    expect(v('COMISIONES')).toBe(500000);
    expect(v('PRESTAMO')).toBe(100000);
    expect(v('EMBARGO')).toBeGreaterThan(0);
    expect(maria.lineas.find((l: any) => l.concepto === 'SALUD_EMPLEADO').detalle.formula).toContain('IBC_SALUD');
    const jose = ok(await c.api('get', `/periodos/${p.id}/empleados/${ids.e2}`));
    const hed = jose.lineas.find((l: any) => l.concepto === 'HED');
    expect(hed.cantidad).toBe('3.6');
    const pdf = await c.http().get(`/api/periodos/${p.id}/empleados/${ids.e1}/desprendible`).set('Authorization', `Bearer ${c.token}`).buffer(true);
    expect(pdf.headers['content-type']).toContain('application/pdf');
  });

  it('HU-13: probar un concepto en borrador sin afectar la nómina', async () => {
    ok(await c.api('post', '/conceptos', { codigo: 'BONO_PRUEBA', nombre: 'Bono de prueba', tipo: 'devengo', formula: 'SALARIO * 0,05', estado: 'borrador', salarial: true }));
    const r = ok(await c.api('post', '/conceptos/BONO_PRUEBA/probar', { empleadoId: ids.e1, desde: '2026-10-01', hasta: '2026-10-31' }));
    expect(r.valor).toBe('150000');
    expect(r.linea.detalle.variables.SALARIO).toBe('3000000');
  });

  it('HU-55: comparativo, aprobación, cierre y saldos de préstamos', async () => {
    const comp = ok(await c.api('get', `/periodos/${ids.periodo}/comparativo`));
    expect(comp.anterior).toBeNull();
    expect(comp.empleados.every((e: any) => e.nuevo)).toBe(true);
    const cerrarAntes = await c.api('post', `/periodos/${ids.periodo}/cerrar`);
    expect(cerrarAntes.status).toBe(400);
    ok(await c.api('post', `/periodos/${ids.periodo}/aprobar`));
    ok(await c.api('post', `/periodos/${ids.periodo}/cerrar`));
    const pr = ok(await c.api('get', `/prestamos?empleadoId=${ids.e1}`));
    expect(pr[0].saldo).toBe('500000');
    const noBorrar = await c.api('delete', `/periodos/${ids.periodo}`);
    expect(noBorrar.status).toBe(400);
    const novCerrada = await c.api('get', `/novedades?empleadoId=${ids.e1}&tipo=COMISIONES`);
    const b = await c.api('delete', `/novedades/${novCerrada.body[0].id}`);
    expect(b.body.mensaje).toContain('aprobada o cerrada');
  });

  it('HU-57: archivo del banco con validación de cuentas', async () => {
    const sinCuenta = await c.api('post', `/pagos/periodos/${ids.periodo}/archivo`, { formato: 'BANCOLOMBIA' });
    expect(sinCuenta.status).toBe(409);
    expect(sinCuenta.body.invalidos[0].empleado).toBe('José Pérez');
    const r = ok(await c.api('post', `/pagos/periodos/${ids.periodo}/archivo`, { formato: 'CSV_GENERICO', excluirInvalidos: true }));
    expect(r.registros).toBe(1);
    const txt = Buffer.from(r.contenidoBase64, 'base64').toString('latin1');
    expect(txt).toContain('1012345678;Maria Lopez;Bancolombia');
    const pagos = ok(await c.api('get', `/pagos/periodos/${ids.periodo}`));
    ok(await c.api('patch', '/pagos', { ids: pagos.map((p: any) => p.id), estado: 'pagado' }));
  });

  it('HU-58: comprobante contable cuadrado y exportado', async () => {
    const comp = ok(await c.api('get', `/contabilidad/periodos/${ids.periodo}`));
    expect(comp.cuadrado).toBe(true);
    expect(comp.sinCuenta).toEqual([]);
    const exp = ok(await c.api('post', `/contabilidad/periodos/${ids.periodo}/exportar`, { formato: 'SIIGO' }));
    expect(Buffer.from(exp.contenidoBase64, 'base64').toString().split('\r\n')[0]).toContain('Código cuenta contable');
  });

  it('HU-56 y HU-45: reabrir con motivo y calcular retroactivo', async () => {
    const sinMotivo = await c.api('post', `/periodos/${ids.periodo}/reabrir`, {});
    expect(sinMotivo.status).toBe(400);
    const r = ok(await c.api('post', `/periodos/${ids.periodo}/reabrir`, { motivo: 'Corrección de prueba' }));
    expect(r.advertencia).toContain('archivo del banco');
    const pr = ok(await c.api('get', `/prestamos?empleadoId=${ids.e1}`));
    expect(pr[0].saldo).toBe('600000');
    ok(await c.api('post', `/periodos/${ids.periodo}/aprobar`));
    ok(await c.api('post', `/periodos/${ids.periodo}/cerrar`));
    // Aumento retroactivo desde octubre
    const emp = ok(await c.api('get', `/empleados/${ids.e1}`));
    const aumento = ok(await c.api('post', `/empleados/contratos/${emp.contratos[0].id}/salarios`, { desde: '2026-10-01', salario: 3300000, motivo: 'Aumento' }));
    expect(aumento.retroactivo.periodos).toHaveLength(1);
    const nov = ok(await c.api('post', '/periodos', { grupoPagoId: ids.grupo, desde: '2026-11-01', hasta: '2026-11-30' }));
    ids.noviembre = nov.id;
    const prev = ok(await c.api('post', `/periodos/${nov.id}/retroactivo`, { periodosOrigen: [ids.periodo], motivo: 'Aumento de octubre' }));
    const dif = prev.diferencias.find((d: any) => d.empleadoId === ids.e1);
    expect(Number(dif.valor)).toBe(250000); // 25 días x 10.000 más
    ok(await c.api('post', `/periodos/${nov.id}/retroactivo`, { periodosOrigen: [ids.periodo], motivo: 'Aumento de octubre', aplicar: true }));
    ok(await c.api('post', `/periodos/${nov.id}/liquidar`, {}));
    const det = ok(await c.api('get', `/periodos/${nov.id}/empleados/${ids.e1}`));
    expect(det.lineas.find((l: any) => l.concepto === 'RETROACTIVO').valor).toBe('250000');
  });

  it('HU-47 y HU-48: prima del segundo semestre y cesantías del año', async () => {
    const prima = ok(await c.api('post', '/prestaciones/prima', { anio: 2026, semestre: 2 }));
    expect(prima.totales.empleados).toBe(2);
    const ces = ok(await c.api('post', '/prestaciones/cesantias', { anio: 2026 }));
    expect(ces.totales.empleados).toBe(1); // José termina el 30 de noviembre
    const fondos = ok(await c.api('get', `/prestaciones/cesantias/${ces.periodo.id}/fondos`));
    expect(fondos[0].fondo).toBe('Cesantías Prueba');
  });

  it('HU-53 y HU-54: liquidación del contrato con indemnización', async () => {
    const r = ok(await c.api('post', '/retiros/calcular', { empleadoId: ids.e1, fechaRetiro: '2026-12-31', causa: 'Despido', sinJustaCausa: true }));
    const ind = r.lineas.find((l: any) => l.concepto === 'INDEMNIZACION');
    expect(Number(ind.cantidad)).toBeCloseTo(30 + 20 * 2, 0); // 3 años
    expect(r.lineas.some((l: any) => l.concepto === 'VACACIONES_COMPENSADAS')).toBe(true);
    // La prima del semestre está liquidada pero no aprobada: no cuenta como pagada y se incluye completa.
    expect(Number(r.lineas.find((l: any) => l.concepto === 'PRIMA_SERVICIOS')?.valor ?? 0)).toBeGreaterThan(0);
    const g = ok(await c.api('post', '/retiros', { empleadoId: ids.e1, fechaRetiro: '2026-12-31', causa: 'Despido', sinJustaCausa: true }));
    ok(await c.api('post', `/retiros/${g.id}/aprobar`));
    const emp = ok(await c.api('get', `/empleados/${ids.e1}`));
    expect(emp.estado).toBe('retirado');
    const pdf = await c.http().get(`/api/retiros/${g.id}/pdf`).set('Authorization', `Bearer ${c.token}`).buffer(true);
    expect(pdf.headers['content-type']).toContain('application/pdf');
  });

  it('HU-60: panel, reportes, certificado de ingresos y exportación', async () => {
    const panel = ok(await c.api('get', '/reportes/panel'));
    expect(panel.ultimoPeriodo).toBeTruthy();
    expect(panel.distribucion.length).toBeGreaterThan(0);
    expect(Array.isArray(panel.pendientes)).toBe(true);
    const res = ok(await c.api('get', '/reportes/resumen?desde=2026-01-01&hasta=2026-12-31'));
    expect(res.porConcepto.length).toBeGreaterThan(5);
    const cert = ok(await c.api('get', `/reportes/certificado-ingresos/${ids.e1}?anio=2026`));
    expect(Number(cert.pagosSalariales)).toBeGreaterThan(0);
    const x = ok(await c.api('post', '/reportes/exportar', { titulo: 'Prueba', formato: 'excel', columnas: [{ clave: 'a', titulo: 'A' }], filas: [{ a: '1' }] }));
    expect(x.nombre).toBe('prueba.xlsx');
    const notif = ok(await c.api('get', '/notificaciones'));
    expect(Array.isArray(notif)).toBe(true);
    const aud = ok(await c.api('get', '/reportes/auditoria?entidad=periodo'));
    expect(aud.length).toBeGreaterThan(3);
  });
});
