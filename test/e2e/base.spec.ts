import { Contexto, levantar } from './app';

describe('API: inicio de sesión, empresa y configuración', () => {
  let c: Contexto;
  beforeAll(async () => {
    c = await levantar('base');
  });
  afterAll(async () => c?.cerrar());

  it('salud responde sin sesión', async () => {
    const r = await c.http().get('/api/salud');
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('ok');
  });

  it('HU-01: el superusuario Santiago entra con su contraseña', async () => {
    const r = await c.http().post('/api/auth/login').send({ usuario: 'santiago', password: '123456santiago' });
    expect(r.status).toBe(201);
    expect(r.body.usuario.rol).toBe('superusuario');
    expect(r.body.usuario.nombre).toBe('Santiago');
  });

  it('contraseña incorrecta y bloqueo tras 5 intentos', async () => {
    const mal = await c.http().post('/api/auth/login').send({ usuario: 'Santiago', password: 'x' });
    expect(mal.status).toBe(401);
    expect(mal.body.mensaje).toBe('Usuario o contraseña incorrectos');
  });

  it('las rutas protegidas exigen sesión', async () => {
    const r = await c.http().get('/api/empleados');
    expect(r.status).toBe(401);
    expect(r.body.mensaje).toContain('iniciar sesión');
  });

  it('HU-02: datos de la empresa con validación del dígito de verificación', async () => {
    const mal = await c.api('patch', '/empresa', { nit: '900123456', dv: '1' });
    expect(mal.status).toBe(400);
    expect(mal.body.mensaje).toContain('dígito de verificación');
    const ok = await c.api('patch', '/empresa', { nit: '900123456', razonSocial: 'Empresa de Prueba S.A.S.', exonerada: true });
    expect(ok.status).toBe(200);
    expect(ok.body.dv).toBe('8');
    expect(ok.body.razonSocial).toBe('Empresa de Prueba S.A.S.');
  });

  it('HU-61: configurar días laborales con casillas', async () => {
    const r = await c.api('patch', '/empresa/configuracion', { calendario: { diasLaborales: [1, 2, 3, 4, 5], sabadoHabilVacaciones: false } });
    expect(r.status).toBe(200);
    expect(r.body.calendario).toEqual({ diasLaborales: [1, 2, 3, 4, 5], diaDescanso: 0, sabadoHabilVacaciones: false });
    const mal = await c.api('patch', '/empresa/configuracion', { calendario: { diasLaborales: [0, 1, 2] } });
    expect(mal.status).toBe(400);
    expect(mal.body.mensaje).toContain('descanso');
  });

  it('HU-06: parámetros con vigencia y advertencia por valor menor al legal', async () => {
    const lista = await c.api('get', '/parametros?fecha=2026-10-28');
    const smmlv = lista.body.find((p: any) => p.codigo === 'SMMLV');
    expect(smmlv.valorActual).toBe('1750905');
    // Recién instalado nada aparece como modificado, ni los que tienen cambios programados por la reforma.
    expect(lista.body.filter((p: any) => p.distintoDeLegal).map((p: any) => p.codigo)).toEqual([]);
    const recargo = lista.body.find((p: any) => p.codigo === 'RECARGO_DESCANSO');
    expect([recargo.valorActual, recargo.valorLegal]).toEqual(['0.9', '0.90']);
    const bajoRecargo = await c.api('post', '/parametros/RECARGO_DESCANSO/vigencias', { desde: '2027-08-01', valor: '0.9' });
    expect(bajoRecargo.status).toBe(409);
    const bajo = await c.api('post', '/parametros/SMMLV/vigencias', { desde: '2027-01-01', valor: 1000000 });
    expect(bajo.status).toBe(409);
    expect(bajo.body.requiereConfirmacion).toBe(true);
    const ok = await c.api('post', '/parametros/SMMLV/vigencias', { desde: '2027-01-01', valor: '1900000' });
    expect(ok.status).toBe(201);
    const l2 = await c.api('get', '/parametros?fecha=2027-02-01');
    expect(l2.body.find((p: any) => p.codigo === 'SMMLV').valorActual).toBe('1900000');
  });

  it('HU-08: festivos generados para 2026', async () => {
    const r = await c.api('get', '/festivos?anio=2026');
    expect(r.body).toHaveLength(18);
    expect(r.body.map((f: any) => f.fecha)).toContain('2026-11-16');
  });

  it('HU-10 y HU-11: crear un concepto propio con fórmula y validar errores', async () => {
    const mal = await c.api('post', '/conceptos', { codigo: 'BONO_X', nombre: 'Bono', tipo: 'devengo', formula: 'SALARIO * BONO_INEXISTENTE' });
    expect(mal.status).toBe(400);
    expect(mal.body.errores).toEqual(['La variable BONO_INEXISTENTE no existe']);
    const ok = await c.api('post', '/conceptos', {
      codigo: 'prima_antiguedad',
      nombre: 'Prima de antigüedad',
      tipo: 'devengo',
      formula: 'SI(ANTIGUEDAD_ANOS >= 5; SALARIO * 0,10; 0)',
      salarial: true,
      baseIbc: true,
    });
    expect(ok.status).toBe(201);
    expect(ok.body.codigo).toBe('PRIMA_ANTIGUEDAD');
    const circular = await c.api('patch', '/conceptos/PRIMA_ANTIGUEDAD', { formula: 'PRIMA_ANTIGUEDAD + 1' });
    expect(circular.status).toBe(400);
    expect(circular.body.errores[0]).toContain('circular');
    const v = await c.api('post', '/conceptos/validar', { codigo: 'X', formula: 'SALARIO / 30' });
    expect(v.body).toEqual({ valida: true, errores: [] });
  });

  it('HU-09: modificar y restaurar un concepto legal', async () => {
    const e = await c.api('patch', '/conceptos/AUXILIO_TRANSPORTE', { formula: '300000' });
    expect(e.status).toBe(200);
    const v = await c.api('get', '/conceptos/AUXILIO_TRANSPORTE');
    expect(v.body.distintoDeLegal).toBe(true);
    expect(v.body.versiones.length).toBe(1);
    const r = await c.api('post', '/conceptos/AUXILIO_TRANSPORTE/restaurar');
    expect(r.body.formula).toContain('AUX_TRANSPORTE');
    const b = await c.api('delete', '/conceptos/SALARIO_BASICO');
    expect(b.body.borrado).toBe(false);
    await c.api('patch', '/conceptos/SALARIO_BASICO', { estado: 'activo' });
  });

  it('HU-03: sedes y centros de costo con CRUD genérico', async () => {
    const s = await c.api('post', '/sedes', { nombre: 'Bodega norte', claseRiesgo: 3 });
    expect(s.status).toBe(201);
    expect(s.body.claseRiesgo).toBe(3);
    const l = await c.api('get', '/sedes');
    expect(l.body.length).toBe(2);
    const cc = await c.api('post', '/centros-costo', { codigo: 'PLA', nombre: 'Planta' });
    expect(cc.status).toBe(201);
  });

  it('HU-05: la auditoría registra los cambios y no se puede borrar', async () => {
    const { Db } = await import('../../src/db/db.service');
    const db = c.app.get(Db);
    const n = await db.one(`select count(*)::int as n from auditoria where entidad = 'parametro'`);
    expect(n.n).toBeGreaterThan(0);
    await expect(db.exec('delete from auditoria')).rejects.toThrow('no se puede modificar');
  });

  it('HU-64: exportar e importar la configuración muestra los cambios', async () => {
    const exp = await c.api('get', '/respaldo/exportar');
    expect(exp.body.parametros.length).toBeGreaterThan(50);
    exp.body.conceptos.find((x: any) => x.codigo === 'PRIMA_ANTIGUEDAD').formula = 'SALARIO * 0,2';
    const prev = await c.api('post', '/respaldo/importar', { datos: exp.body, aplicar: false });
    expect(prev.body.cambios).toContain('Cambia el concepto PRIMA_ANTIGUEDAD');
    const ap = await c.api('post', '/respaldo/importar', { datos: exp.body, aplicar: true });
    expect(ap.body.aplicado).toBe(true);
    const v = await c.api('get', '/conceptos/PRIMA_ANTIGUEDAD');
    expect(v.body.formula).toBe('SALARIO * 0,2');
  });
});
