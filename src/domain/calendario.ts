import { diaSemana, Fecha, rango, sumarDias } from './fechas';

export type TipoDiaEspecial = 'remunerado' | 'compensado' | 'no_laborado';

/** Configuración del calendario laboral (HU-61). Todo se marca desde el panel. */
export interface ConfigCalendario {
  /** Días de la semana que se trabajan: 0 = domingo ... 6 = sábado. Por defecto lunes a sábado. */
  diasLaborales: number[];
  /** Día de descanso obligatorio. Por defecto domingo. */
  diaDescanso: number;
  /** Si el sábado cuenta como hábil para vacaciones aunque no se trabaje. */
  sabadoHabilVacaciones: boolean;
  festivos: Set<Fecha>;
  diasEspeciales?: Map<Fecha, TipoDiaEspecial>;
}

export const CALENDARIO_POR_DEFECTO = (festivos: Fecha[] = []): ConfigCalendario => ({
  diasLaborales: [1, 2, 3, 4, 5, 6],
  diaDescanso: 0,
  sabadoHabilVacaciones: true,
  festivos: new Set(festivos),
  diasEspeciales: new Map(),
});

export class Calendario {
  constructor(private readonly cfg: ConfigCalendario) {}

  get config(): ConfigCalendario {
    return this.cfg;
  }

  esFestivo(f: Fecha): boolean {
    return this.cfg.festivos.has(f);
  }

  /** Día de descanso obligatorio o festivo: el trabajo en él lleva recargo (CST art. 179). */
  esDiaDescanso(f: Fecha): boolean {
    return diaSemana(f) === this.cfg.diaDescanso || this.esFestivo(f);
  }

  esDiaLaboral(f: Fecha): boolean {
    if (this.esDiaDescanso(f)) return false;
    if (this.cfg.diasEspeciales?.get(f) === 'no_laborado') return false;
    return this.cfg.diasLaborales.includes(diaSemana(f));
  }

  /** Día hábil para contar vacaciones (CST art. 186: días hábiles). */
  esHabilVacaciones(f: Fecha): boolean {
    if (this.esDiaDescanso(f)) return false;
    const ds = diaSemana(f);
    if (this.cfg.diasLaborales.includes(ds)) return true;
    return ds === 6 && this.cfg.sabadoHabilVacaciones;
  }

  contarDiasHabilesVacaciones(desde: Fecha, hasta: Fecha): number {
    let n = 0;
    for (const f of rango(desde, hasta)) if (this.esHabilVacaciones(f)) n++;
    return n;
  }

  contarDiasLaborales(desde: Fecha, hasta: Fecha): number {
    let n = 0;
    for (const f of rango(desde, hasta)) if (this.esDiaLaboral(f)) n++;
    return n;
  }

  /**
   * Fecha del último día de vacaciones y fecha de regreso, contando solo días hábiles.
   * Si el inicio no es hábil, las vacaciones empiezan el siguiente día hábil.
   */
  calcularVacaciones(inicio: Fecha, diasHabiles: number): { inicioReal: Fecha; fin: Fecha; regreso: Fecha; diasCalendario: number } {
    if (diasHabiles <= 0) throw new Error('Los días de vacaciones deben ser mayores que cero');
    let f = inicio;
    while (!this.esHabilVacaciones(f)) f = sumarDias(f, 1);
    const inicioReal = f;
    let contados = 0;
    let fin = f;
    for (;;) {
      if (this.esHabilVacaciones(f)) {
        contados++;
        fin = f;
        if (contados === diasHabiles) break;
      }
      f = sumarDias(f, 1);
    }
    let regreso = sumarDias(fin, 1);
    while (!this.esDiaLaboral(regreso)) regreso = sumarDias(regreso, 1);
    const diasCal = Math.round((Date.parse(regreso) - Date.parse(inicioReal)) / 86_400_000);
    return { inicioReal, fin, regreso, diasCalendario: diasCal };
  }
}
