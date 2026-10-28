import { Calendario, CALENDARIO_POR_DEFECTO } from '../../src/domain/calendario';
import { festivosColombia } from '../../src/domain/festivos';
import { ClasificadorHoras, CONFIG_HORAS_POR_DEFECTO, emparejarMarcaciones, Turno } from '../../src/domain/horas';

const festivos = festivosColombia(2026).map((f) => f.fecha);
const cal = new Calendario(CALENDARIO_POR_DEFECTO(festivos));
const lv = (inicio: string, fin: string): Turno => ({
  dias: { 1: [{ inicio, fin }], 2: [{ inicio, fin }], 3: [{ inicio, fin }], 4: [{ inicio, fin }], 5: [{ inicio, fin }] },
});
const turno42 = lv('07:00', '15:24'); // 8h24 x 5 = 42 horas

describe('Clasificación de horas', () => {
  const c = new ClasificadorHoras(cal);

  it('el turno de HU-22 suma 42 horas', () => {
    const semana = [1, 2, 3, 4, 5].reduce((a, d) => a + c.minutosProgramados(turno42, d), 0);
    expect(semana / 60).toBe(42);
  });

  it('jornada normal: todo ordinario diurno', () => {
    const r = c.clasificar([{ entrada: '2026-10-28T07:00', salida: '2026-10-28T15:24' }], turno42);
    expect(r.total.HOD).toBe(504);
    expect(r.total.HED + r.total.HEN).toBe(0);
    expect(r.alertas).toEqual([]);
  });

  it('ejemplo HU-31: salida 20:24 → 3h36 extra diurna y 1h24 extra nocturna', () => {
    const r = c.clasificar([{ entrada: '2026-10-28T07:00', salida: '2026-10-28T20:24' }], turno42);
    expect(r.total.HOD).toBe(504);
    expect(r.total.HED).toBe(216); // 15:24 a 19:00
    expect(r.total.HEN).toBe(84); // 19:00 a 20:24
    expect(r.alertas.map((a) => a.tipo)).toContain('exceso_extras_dia');
  });

  it('turno nocturno que cruza la medianoche', () => {
    const noche: Turno = { dias: { 3: [{ inicio: '22:00', fin: '06:00' }] } };
    const r = c.clasificar([{ entrada: '2026-10-28T22:00', salida: '2026-10-29T06:00' }], noche);
    expect(r.total.HON).toBe(480);
    expect(r.total.HOD).toBe(0);
    expect(Object.keys(r.porFecha)).toEqual(['2026-10-28', '2026-10-29']);
  });

  it('la jornada nocturna empieza a las 19:00 (Ley 2466)', () => {
    const tarde: Turno = { dias: { 3: [{ inicio: '14:00', fin: '22:00' }] } };
    const r = c.clasificar([{ entrada: '2026-10-28T14:00', salida: '2026-10-28T22:00' }], tarde);
    expect(r.total.HOD).toBe(300);
    expect(r.total.HON).toBe(180);
  });

  it('la hora de inicio nocturna es configurable', () => {
    const c21 = new ClasificadorHoras(cal, { ...CONFIG_HORAS_POR_DEFECTO, inicioNocturna: '21:00' });
    const tarde: Turno = { dias: { 3: [{ inicio: '14:00', fin: '22:00' }] } };
    const r = c21.clasificar([{ entrada: '2026-10-28T14:00', salida: '2026-10-28T22:00' }], tarde);
    expect(r.total.HON).toBe(60);
  });

  it('trabajo en domingo sin turno: primeras 8 horas de descanso, resto extra de descanso', () => {
    const r = c.clasificar([{ entrada: '2026-11-01T08:00', salida: '2026-11-01T18:00' }], turno42);
    expect(r.total.HDD).toBe(480);
    expect(r.total.HEDD).toBe(120);
  });

  it('festivo que cae en día de turno se paga como día de descanso', () => {
    // 2-nov-2026 es festivo (lunes)
    const r = c.clasificar([{ entrada: '2026-11-02T07:00', salida: '2026-11-02T15:24' }], turno42);
    expect(r.total.HDD).toBe(480);
    expect(r.total.HEDD).toBe(24);
    expect(r.total.HOD).toBe(0);
  });

  it('nocturno en día de descanso', () => {
    const r = c.clasificar([{ entrada: '2026-11-01T18:00', salida: '2026-11-01T22:00' }], turno42);
    expect(r.total.HDD).toBe(60);
    expect(r.total.HDN).toBe(180);
  });

  it('sábado sin turno en día laboral: extra ordinaria', () => {
    const r = c.clasificar([{ entrada: '2026-10-31T08:00', salida: '2026-10-31T10:00' }], turno42);
    expect(r.total.HED).toBe(120);
  });

  it('llegada tarde y salida anticipada con tolerancia', () => {
    const r = c.clasificar([{ entrada: '2026-10-28T07:20', salida: '2026-10-28T15:00' }], turno42);
    const tipos = r.alertas.map((a) => `${a.tipo}:${a.minutos}`);
    expect(tipos).toEqual(['llegada_tarde:20', 'salida_anticipada:24']);
    const r2 = c.clasificar([{ entrada: '2026-10-28T07:04', salida: '2026-10-28T15:22' }], turno42);
    expect(r2.alertas).toEqual([]);
  });

  it('jornada partida (almuerzo) con dos intervalos', () => {
    const partido: Turno = { dias: { 3: [{ inicio: '08:00', fin: '12:00' }, { inicio: '13:00', fin: '17:24' }] } };
    const r = c.clasificar(
      [
        { entrada: '2026-10-28T08:00', salida: '2026-10-28T12:00' },
        { entrada: '2026-10-28T13:00', salida: '2026-10-28T18:00' },
      ],
      partido,
    );
    expect(r.total.HOD).toBe(504);
    expect(r.total.HED).toBe(36);
  });

  it('mínimo de minutos para contar extra', () => {
    const c15 = new ClasificadorHoras(cal, { ...CONFIG_HORAS_POR_DEFECTO, minimoMinutosExtra: 15 });
    const r = c15.clasificar([{ entrada: '2026-10-28T07:00', salida: '2026-10-28T15:34' }], turno42);
    expect(r.total.HED).toBe(0);
  });

  it('alerta de exceso semanal de horas extra', () => {
    const ivs = [26, 27, 28, 29, 30].map((d) => ({ entrada: `2026-10-${d}T07:00`, salida: `2026-10-${d}T18:24` }));
    const r = c.clasificar(ivs, turno42);
    expect(r.total.HED).toBe(5 * 180);
    expect(r.alertas.some((a) => a.tipo === 'exceso_extras_semana')).toBe(true);
  });
});

describe('Emparejar marcaciones', () => {
  it('empareja entradas y salidas y detecta incompletas', () => {
    const { intervalos, incompletas } = emparejarMarcaciones([
      { tipo: 'salida', hora: '2026-10-28T12:00' },
      { tipo: 'entrada', hora: '2026-10-28T08:00' },
      { tipo: 'entrada', hora: '2026-10-28T13:00' },
      { tipo: 'salida', hora: '2026-10-28T17:00' },
      { tipo: 'entrada', hora: '2026-10-29T08:00' },
    ]);
    expect(intervalos).toEqual([
      { entrada: '2026-10-28T08:00', salida: '2026-10-28T12:00' },
      { entrada: '2026-10-28T13:00', salida: '2026-10-28T17:00' },
    ]);
    expect(incompletas).toEqual([{ tipo: 'entrada', hora: '2026-10-29T08:00' }]);
  });
});
