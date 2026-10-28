import { Contexto, levantar } from './app';

/** Alcaldía: primas y bonificaciones del sector público territorial como provisiones. */
describe('API: ajustes del sector público territorial', () => {
  let c: Contexto;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    c = await levantar('publico');
  });
  afterAll(async () => c?.cerrar());

  const ok = (r: { status: number; body: any }) => {
    if (![200, 201].includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body;
  };

  it('aplica los ajustes y se puede repetir sin duplicar nada', async () => {
    ok(await c.api('patch', '/empresa', { exonerada: false }));
    const r = ok(await c.api('post', '/empresa/sector-publico'));
    expect(r.hecho.length).toBeGreaterThan(5);
    ok(await c.api('post', '/empresa/sector-publico'));
    const conceptos = ok(await c.api('get', '/conceptos'));
    expect(conceptos.filter((x: any) => x.codigo === 'PROV_PRIMA_NAVIDAD')).toHaveLength(1);
    expect(conceptos.find((x: any) => x.codigo === 'SUBSIDIO_ALIMENTACION').estado).toBe('borrador');
  });

  it('liquida con primas públicas y sin intereses para afiliados al FNA', async () => {
    const entidades = ok(await c.api('get', '/entidades'));
    const ent = (tipo: string, nombre: string) => entidades.find((e: any) => e.tipo === tipo && e.nombre === nombre).id;
    const base = { aceptaTratamientoDatos: true, epsId: ent('eps', 'Nueva EPS'), afpId: ent('afp', 'Colpensiones') };
    const crear = async (doc: string, nombres: string, cesantias: string, salario: number) => {
      const e = ok(await c.api('post', '/empleados', { ...base, numeroDocumento: doc, nombres, apellidos: 'Prueba', cesantiasId: ent('cesantias', cesantias) }));
      ok(await c.api('post', `/empleados/${e.id}/contratos`, { tipo: 'indefinido', fechaInicio: '2024-01-01', salario }));
      return e.id;
    };
    ids.laura = await crear('1085000001', 'Laura', 'Fondo Nacional del Ahorro', 3600000);
    ids.andres = await crear('1085000002', 'Andrés', 'Porvenir', 5200000);
    ids.jhon = await crear('1085000004', 'Jhon', 'Protección', 2000000);
    const grupo = ok(await c.api('get', '/grupos-pago'))[0].id;
    const p = ok(await c.api('post', '/periodos', { grupoPagoId: grupo, desde: '2026-10-01', hasta: '2026-10-31', nombre: 'Octubre' }));
    ok(await c.api('post', `/periodos/${p.id}/liquidar`, {}));
    const linea = async (emp: string, concepto: string) => {
      const d = ok(await c.api('get', `/periodos/${p.id}/empleados/${emp}`));
      return d.lineas.find((l: any) => l.concepto === concepto)?.valor ?? '0';
    };
    expect(await linea(ids.laura, 'PROV_PRIMA')).toBe('150000');
    expect(await linea(ids.laura, 'PROV_INTERESES')).toBe('0');
    expect(await linea(ids.laura, 'PROV_PRIMA_NAVIDAD')).toBe('300000');
    expect(await linea(ids.laura, 'PROV_PRIMA_VACACIONES')).toBe('150000');
    expect(await linea(ids.laura, 'PROV_BONIF_SERVICIOS')).toBe('105000');
    expect(await linea(ids.laura, 'PROV_BONIF_RECREACION')).toBe('20000');
    expect(await linea(ids.andres, 'PROV_INTERESES')).toBe('52000');
    expect(await linea(ids.jhon, 'PROV_BONIF_SERVICIOS')).toBe('83333');
    expect(await linea(ids.jhon, 'SUBSIDIO_ALIMENTACION')).toBe('0');
  });
});
