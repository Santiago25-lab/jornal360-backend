import { Calendario, CALENDARIO_POR_DEFECTO } from '../../src/domain/calendario';
import {
  antiguedadAnios,
  diasCalendario,
  diasComerciales,
  diaSemana,
  finDeMes,
  sumarDias,
  sumarMeses,
} from '../../src/domain/fechas';
import { domingoDePascua, festivosColombia } from '../../src/domain/festivos';

describe('Fechas', () => {
  it('días comerciales (año de 360)', () => {
    expect(diasComerciales('2026-01-01', '2026-12-31')).toBe(360);
    expect(diasComerciales('2026-01-01', '2026-06-30')).toBe(180);
    expect(diasComerciales('2026-07-01', '2026-12-31')).toBe(180);
    expect(diasComerciales('2026-02-01', '2026-02-28')).toBe(30);
    expect(diasComerciales('2024-02-01', '2024-02-29')).toBe(30);
    expect(diasComerciales('2026-01-10', '2026-01-31')).toBe(21); // HU-40: ingresa el día 10
    expect(diasComerciales('2026-03-01', '2026-03-15')).toBe(15);
    expect(diasComerciales('2026-03-16', '2026-03-31')).toBe(15);
    expect(diasComerciales('2026-02-16', '2026-02-28')).toBe(15);
    expect(diasComerciales('2026-01-01', '2028-12-31')).toBe(1080);
    expect(diasComerciales('2026-05-05', '2026-05-05')).toBe(1);
    expect(diasComerciales('2026-05-06', '2026-05-05')).toBe(0);
  });

  it('antigüedad en años', () => {
    expect(antiguedadAnios('2023-11-01', '2026-10-30')).toBe(3);
  });

  it('operaciones de fechas', () => {
    expect(sumarDias('2026-12-31', 1)).toBe('2027-01-01');
    expect(sumarDias('2026-03-01', -1)).toBe('2026-02-28');
    expect(sumarMeses('2026-01-31', 1)).toBe('2026-02-28');
    expect(finDeMes('2028-02-10')).toBe('2028-02-29');
    expect(diasCalendario('2026-01-01', '2026-12-31')).toBe(365);
    expect(diaSemana('2026-10-28')).toBe(3); // miércoles
  });
});

describe('Festivos de Colombia', () => {
  it('calcula el domingo de Pascua', () => {
    expect(domingoDePascua(2024)).toBe('2024-03-31');
    expect(domingoDePascua(2025)).toBe('2025-04-20');
    expect(domingoDePascua(2026)).toBe('2026-04-05');
    expect(domingoDePascua(2027)).toBe('2027-03-28');
  });

  it('genera los 18 festivos de 2026 con la Ley Emiliani', () => {
    const f = festivosColombia(2026).map((x) => x.fecha);
    expect(f).toEqual([
      '2026-01-01',
      '2026-01-12', // Reyes (6 ene, martes → lunes 12)
      '2026-03-23', // San José (19 mar, jueves → lunes 23)
      '2026-04-02', // Jueves Santo
      '2026-04-03', // Viernes Santo
      '2026-05-01',
      '2026-05-18', // Ascensión
      '2026-06-08', // Corpus Christi
      '2026-06-15', // Sagrado Corazón
      '2026-06-29', // San Pedro (lunes)
      '2026-07-20',
      '2026-08-07',
      '2026-08-17', // Asunción (15 ago, sábado → lunes 17)
      '2026-10-12', // Día de la Raza (lunes)
      '2026-11-02', // Todos los Santos (1 nov, domingo → lunes 2)
      '2026-11-16', // Cartagena (11 nov, miércoles → lunes 16)
      '2026-12-08',
      '2026-12-25',
    ]);
  });

  it('todos los trasladables caen en lunes', () => {
    for (const anio of [2025, 2026, 2027, 2030]) {
      const fs = festivosColombia(anio);
      expect(fs).toHaveLength(18);
      for (const f of fs) {
        if (!['Año Nuevo', 'Día del Trabajo', 'Día de la Independencia', 'Batalla de Boyacá', 'Inmaculada Concepción', 'Navidad', 'Jueves Santo', 'Viernes Santo'].includes(f.nombre))
          expect(diaSemana(f.fecha)).toBe(1);
      }
    }
  });
});

describe('Calendario laboral configurable', () => {
  const festivos = festivosColombia(2026).map((f) => f.fecha);

  it('por defecto: lunes a sábado laborales, domingo descanso', () => {
    const c = new Calendario(CALENDARIO_POR_DEFECTO(festivos));
    expect(c.esDiaLaboral('2026-10-31')).toBe(true); // sábado
    expect(c.esDiaLaboral('2026-11-01')).toBe(false); // domingo
    expect(c.esDiaDescanso('2026-11-02')).toBe(true); // festivo
    expect(c.esDiaLaboral('2026-11-02')).toBe(false);
  });

  it('vacaciones de 15 días hábiles saltando festivos y domingos (lunes a sábado)', () => {
    const c = new Calendario(CALENDARIO_POR_DEFECTO(festivos));
    const v = c.calcularVacaciones('2026-11-03', 15);
    // 3-nov (mar) ... 15 hábiles L-S, saltando domingos y el festivo del 16-nov
    expect(v.fin).toBe('2026-11-20');
    expect(v.regreso).toBe('2026-11-21');
  });

  it('empresa de lunes a viernes sin sábado hábil para vacaciones', () => {
    const c = new Calendario({ ...CALENDARIO_POR_DEFECTO(festivos), diasLaborales: [1, 2, 3, 4, 5], sabadoHabilVacaciones: false });
    const v = c.calcularVacaciones('2026-11-03', 15);
    // 3-6 nov (4), 9-13 (5), 17-20 (4, salta lunes 16 festivo), 23-24 (2) = 15
    expect(v.fin).toBe('2026-11-24');
    expect(v.regreso).toBe('2026-11-25');
    expect(c.esHabilVacaciones('2026-11-07')).toBe(false);
  });

  it('empresa de lunes a viernes con sábado hábil para vacaciones', () => {
    const c = new Calendario({ ...CALENDARIO_POR_DEFECTO(festivos), diasLaborales: [1, 2, 3, 4, 5], sabadoHabilVacaciones: true });
    expect(c.esHabilVacaciones('2026-11-07')).toBe(true);
    expect(c.esDiaLaboral('2026-11-07')).toBe(false);
    // Regresa el lunes siguiente al último sábado de vacaciones
    const v = c.calcularVacaciones('2026-11-03', 15);
    expect(v.fin).toBe('2026-11-20');
    expect(v.regreso).toBe('2026-11-23');
  });

  it('día de descanso distinto al domingo', () => {
    const c = new Calendario({ ...CALENDARIO_POR_DEFECTO([]), diasLaborales: [0, 2, 3, 4, 5, 6], diaDescanso: 1 });
    expect(c.esDiaDescanso('2026-11-01')).toBe(false); // domingo trabajado ordinario
    expect(c.esDiaDescanso('2026-11-02')).toBe(true); // lunes es el descanso
  });

  it('días especiales no laborados', () => {
    const cfg = CALENDARIO_POR_DEFECTO([]);
    cfg.diasEspeciales = new Map([['2026-12-24', 'no_laborado']]);
    const c = new Calendario(cfg);
    expect(c.esDiaLaboral('2026-12-24')).toBe(false);
    expect(c.contarDiasLaborales('2026-12-21', '2026-12-26')).toBe(5);
  });
});
