import { Contexto, levantar } from './app';

/** Panel de la plataforma: espacios por empresa, aislamiento de datos y entrada de soporte. */
describe('API: plataforma y espacios de trabajo', () => {
  let c: Contexto;
  let plataforma = '';
  let yeroz = '';
  let idYeroz = '';

  beforeAll(async () => {
    c = await levantar('plataforma');
  });
  afterAll(async () => c?.cerrar());

  const ok = (r: { status: number; body: any }) => {
    if (![200, 201].includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const con = (token: string, metodo: 'get' | 'post' | 'patch', ruta: string, cuerpo?: object) => {
    const r = c.http()[metodo](`/api${ruta}`).set('Authorization', `Bearer ${token}`);
    return cuerpo ? r.send(cuerpo) : r;
  };

  it('el administrador de la plataforma entra con su propia contraseña', async () => {
    const mal = await c.http().post('/api/plataforma/login').send({ usuario: 'Santiago', password: '123456santiago' });
    expect(mal.status).toBe(401);
    plataforma = ok(await c.http().post('/api/plataforma/login').send({ usuario: 'santiago', password: 'clave-plataforma-prueba' })).token;
    expect(ok(await con(plataforma, 'get', '/plataforma/yo')).tipo).toBe('plataforma');
  });

  it('las sesiones de plataforma y de empresa no se sirven entre sí', async () => {
    expect((await con(c.token, 'get', '/plataforma/espacios')).status).toBe(401);
    expect((await con(plataforma, 'get', '/empleados')).status).toBe(401);
  });

  it('crea un espacio nuevo con su catálogo y su superusuario', async () => {
    expect((await con(plataforma, 'post', '/plataforma/espacios', { espacio: 'nomina', usuario: 'admin', password: '12345678' })).status).toBe(400);
    expect((await con(plataforma, 'post', '/plataforma/espacios', { espacio: 'Mi Empresa', usuario: 'admin', password: '12345678' })).status).toBe(400);
    const e = ok(await con(plataforma, 'post', '/plataforma/espacios', { espacio: 'yeroz', usuario: 'Santiago', password: 'clave-yeroz-1' }));
    idYeroz = e.id;
    expect(e).toMatchObject({ espacio: 'yeroz', razonSocial: 'Mi empresa', usuarios: 1, empleados: 0 });
    expect((await con(plataforma, 'post', '/plataforma/espacios', { espacio: 'yeroz', usuario: 'otro', password: '12345678' })).status).toBe(409);
    const lista = ok(await con(plataforma, 'get', '/plataforma/espacios'));
    expect(lista).toHaveLength(2);
    expect(ok(await c.http().get('/api/auth/espacio/yeroz'))).toEqual({ espacio: 'yeroz', nombre: null });
    expect((await c.http().get('/api/auth/espacio/no-existe')).status).toBe(404);
  });

  it('el mismo nombre de usuario vive en dos espacios sin chocar', async () => {
    const ambiguo = await c.http().post('/api/auth/login').send({ usuario: 'Santiago', password: 'clave-yeroz-1' });
    expect(ambiguo.status).toBe(400);
    const r = ok(await c.http().post('/api/auth/login').send({ usuario: 'Santiago', password: 'clave-yeroz-1', espacio: 'yeroz' }));
    yeroz = r.token;
    expect(r.usuario.espacio).toBe('yeroz');
    expect(r.usuario.debeCambiarPassword).toBe(false);
    const otraClave = await c.http().post('/api/auth/login').send({ usuario: 'Santiago', password: 'clave-yeroz-1', espacio: 'mi-empresa-s-a-s' });
    expect(otraClave.status).toBe(401);
    const yo = ok(await con(yeroz, 'get', '/auth/yo'));
    expect(yo).toMatchObject({ espacio: 'yeroz', razonSocial: 'Mi empresa', asistenteCompletado: false });
    expect(ok(await con(yeroz, 'get', '/parametros')).length).toBeGreaterThan(50);
    expect(ok(await con(yeroz, 'get', '/conceptos')).length).toBeGreaterThan(40);
  });

  it('una empresa nunca ve los datos de otra', async () => {
    const emp = ok(await con(yeroz, 'post', '/empleados', { numeroDocumento: '1085999999', nombres: 'Ana', apellidos: 'Yeroz', aceptaTratamientoDatos: true }));
    expect(ok(await con(yeroz, 'get', '/empleados'))).toHaveLength(1);
    expect(ok(await c.api('get', '/empleados')).some((e: any) => e.id === emp.id)).toBe(false);
    expect((await c.api('get', `/empleados/${emp.id}`)).status).toBe(404);
    // El superusuario del espacio crea otro superusuario, solo para su espacio.
    ok(await con(yeroz, 'post', '/usuarios', { usuario: 'contadora', nombre: 'Contadora', rol: 'superusuario', password: 'clave-contadora' }));
    expect((await con(yeroz, 'post', '/usuarios', { usuario: 'Contadora', nombre: 'Otra', rol: 'superusuario', password: 'clave-contadora' })).status).toBe(409);
    expect(ok(await c.api('get', '/usuarios')).some((u: any) => u.usuario === 'contadora')).toBe(false);
  });

  it('la plataforma entra a un espacio en modo soporte y queda en la auditoría', async () => {
    const s = ok(await con(plataforma, 'post', `/plataforma/espacios/${idYeroz}/entrar`));
    expect(s.espacio).toBe('yeroz');
    const yo = ok(await con(s.token, 'get', '/auth/yo'));
    expect(yo).toMatchObject({ soporte: true, espacio: 'yeroz', rol: 'superusuario' });
    expect(ok(await con(s.token, 'get', '/empleados'))).toHaveLength(1);
    expect((await con(s.token, 'post', '/auth/cambiar-password', { actual: 'x', nueva: '12345678' })).status).toBe(400);
    const aud = ok(await con(yeroz, 'get', '/reportes/auditoria?entidad=empresa'));
    expect(aud.some((a: any) => a.accion === 'entrar_soporte' && a.usuarioNombre === 'Plataforma: Santiago')).toBe(true);
  });

  it('restablece la contraseña de un usuario y cambia el nombre del espacio', async () => {
    const us = ok(await con(plataforma, 'get', `/plataforma/espacios/${idYeroz}/usuarios`));
    const su = us.find((u: any) => u.usuario === 'Santiago');
    ok(await con(plataforma, 'post', `/plataforma/espacios/${idYeroz}/usuarios/${su.id}/password`, { password: 'nueva-clave-1' }));
    ok(await con(plataforma, 'patch', `/plataforma/espacios/${idYeroz}`, { espacio: 'yeroz-contadores' }));
    ok(await c.http().post('/api/auth/login').send({ usuario: 'Santiago', password: 'nueva-clave-1', espacio: 'yeroz-contadores' }));
    expect((await c.http().post('/api/auth/login').send({ usuario: 'Santiago', password: 'nueva-clave-1', espacio: 'yeroz' })).status).toBe(404);
  });
});
