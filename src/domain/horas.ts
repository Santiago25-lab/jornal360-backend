import { Calendario } from './calendario';
import { diaSemana, Fecha, sumarDias } from './fechas';

/**
 * Clasificación de horas trabajadas (CST arts. 160, 161, 168, 179).
 * Recibe marcaciones en hora local de Colombia ('AAAA-MM-DDTHH:mm') y el turno del empleado,
 * y devuelve los minutos de cada tipo de hora por fecha.
 */

export type TipoHora =
  | 'HOD' // ordinaria diurna
  | 'HON' // ordinaria nocturna (recargo nocturno)
  | 'HED' // extra diurna
  | 'HEN' // extra nocturna
  | 'HDD' // ordinaria diurna en día de descanso o festivo
  | 'HDN' // ordinaria nocturna en día de descanso o festivo
  | 'HEDD' // extra diurna en día de descanso o festivo
  | 'HEND'; // extra nocturna en día de descanso o festivo

export const TIPOS_HORA: TipoHora[] = ['HOD', 'HON', 'HED', 'HEN', 'HDD', 'HDN', 'HEDD', 'HEND'];

export const NOMBRE_TIPO_HORA: Record<TipoHora, string> = {
  HOD: 'Ordinaria diurna',
  HON: 'Ordinaria nocturna',
  HED: 'Extra diurna',
  HEN: 'Extra nocturna',
  HDD: 'Día de descanso diurna',
  HDN: 'Día de descanso nocturna',
  HEDD: 'Extra diurna en día de descanso',
  HEND: 'Extra nocturna en día de descanso',
};

export interface Franja {
  inicio: string; // 'HH:mm'
  fin: string; // 'HH:mm' (si es menor que inicio, el turno cruza la medianoche)
}

/** Turno: franjas por día de la semana (0 = domingo). Un día sin franjas es un día sin turno. */
export interface Turno {
  nombre?: string;
  dias: Partial<Record<number, Franja[]>>;
}

export interface ConfigHoras {
  inicioNocturna: string; // '19:00' (CST art. 160, Ley 2466 de 2025)
  finNocturna: string; // '06:00'
  /** Horas que cuentan como ordinarias en un día sin turno que es de descanso (lo demás es extra). */
  horasOrdinariasDiaSinTurno: number;
  /** Minutos de tolerancia antes de contar llegada tarde o salida anticipada. */
  toleranciaMinutos: number;
  /** Minutos mínimos de trabajo fuera del turno para que cuenten como extra. */
  minimoMinutosExtra: number;
  maxExtrasDia: number; // 2
  maxExtrasSemana: number; // 12
}

export const CONFIG_HORAS_POR_DEFECTO: ConfigHoras = {
  inicioNocturna: '19:00',
  finNocturna: '06:00',
  horasOrdinariasDiaSinTurno: 8,
  toleranciaMinutos: 5,
  minimoMinutosExtra: 0,
  maxExtrasDia: 2,
  maxExtrasSemana: 12,
};

export interface Intervalo {
  entrada: string; // 'AAAA-MM-DDTHH:mm'
  salida: string;
}

export type MinutosPorTipo = Record<TipoHora, number>;

export interface ResultadoHoras {
  porFecha: Record<Fecha, MinutosPorTipo>;
  total: MinutosPorTipo;
  alertas: AlertaHoras[];
}

export interface AlertaHoras {
  fecha: Fecha;
  tipo: 'llegada_tarde' | 'salida_anticipada' | 'exceso_extras_dia' | 'exceso_extras_semana';
  minutos: number;
  mensaje: string;
}

const vacio = (): MinutosPorTipo => ({ HOD: 0, HON: 0, HED: 0, HEN: 0, HDD: 0, HDN: 0, HEDD: 0, HEND: 0 });

/** Minuto absoluto (desde 1970) de una fecha y hora local. */
export function minutoAbs(ts: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(ts);
  if (!m) throw new Error(`Hora inválida: ${ts}`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000;
}

const hm = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};

const fechaDeMinuto = (min: number): Fecha => new Date(min * 60000).toISOString().slice(0, 10);
const minutoDelDia = (min: number) => ((min % 1440) + 1440) % 1440;

const esExtra = (t: TipoHora) => t === 'HED' || t === 'HEN' || t === 'HEDD' || t === 'HEND';

export class ClasificadorHoras {
  private readonly noctIni: number;
  private readonly noctFin: number;

  constructor(
    private readonly calendario: Calendario,
    private readonly cfg: ConfigHoras = CONFIG_HORAS_POR_DEFECTO,
  ) {
    this.noctIni = hm(cfg.inicioNocturna);
    this.noctFin = hm(cfg.finNocturna);
  }

  esNocturno(minAbs: number): boolean {
    const m = minutoDelDia(minAbs);
    return this.noctIni > this.noctFin ? m >= this.noctIni || m < this.noctFin : m >= this.noctIni && m < this.noctFin;
  }

  /** Ventanas programadas [inicio, fin) en minutos absolutos, para un rango de fechas. */
  ventanas(turno: Turno, desde: Fecha, hasta: Fecha): { fecha: Fecha; ini: number; fin: number }[] {
    const out: { fecha: Fecha; ini: number; fin: number }[] = [];
    for (let f = sumarDias(desde, -1); f <= hasta; f = sumarDias(f, 1)) {
      // Un festivo que cae en día de turno no se programa: el trabajo ese día es de descanso.
      if (this.calendario.esFestivo(f)) continue;
      const base = minutoAbs(`${f}T00:00`);
      for (const fr of turno.dias[diaSemana(f)] ?? []) {
        const ini = base + hm(fr.inicio);
        let fin = base + hm(fr.fin);
        if (fin <= ini) fin += 1440;
        out.push({ fecha: f, ini, fin });
      }
    }
    return out;
  }

  /** Duración ordinaria programada de un día de la semana, en minutos. */
  minutosProgramados(turno: Turno, ds: number): number {
    return (turno.dias[ds] ?? []).reduce((acc, fr) => {
      const d = hm(fr.fin) - hm(fr.inicio);
      return acc + (d <= 0 ? d + 1440 : d);
    }, 0);
  }

  clasificar(intervalos: Intervalo[], turno: Turno): ResultadoHoras {
    const porFecha: Record<Fecha, MinutosPorTipo> = {};
    const total = vacio();
    const alertas: AlertaHoras[] = [];
    if (intervalos.length === 0) return { porFecha, total, alertas };

    const ordenados = [...intervalos].sort((a, b) => a.entrada.localeCompare(b.entrada));
    const desde = ordenados[0].entrada.slice(0, 10);
    const hasta = ordenados[ordenados.length - 1].salida.slice(0, 10);
    const ventanas = this.ventanas(turno, desde, hasta);
    const enVentana = (m: number) => ventanas.some((v) => m >= v.ini && m < v.fin);
    // Minutos ordinarios ya usados en días de descanso sin turno (por fecha).
    const ordinariosSinTurno = new Map<Fecha, number>();
    const limiteSinTurno = this.cfg.horasOrdinariasDiaSinTurno * 60;

    for (const iv of ordenados) {
      const ini = minutoAbs(iv.entrada);
      const fin = minutoAbs(iv.salida);
      if (fin <= ini) continue;
      for (let m = ini; m < fin; m++) {
        const f = fechaDeMinuto(m);
        const noct = this.esNocturno(m);
        const descanso = this.calendario.esDiaDescanso(f);
        let ordinario: boolean;
        if (enVentana(m)) ordinario = true;
        else {
          const hayTurnoEseDia = ventanas.some((v) => v.fecha === f);
          if (!hayTurnoEseDia && descanso) {
            const usados = ordinariosSinTurno.get(f) ?? 0;
            ordinario = usados < limiteSinTurno;
            if (ordinario) ordinariosSinTurno.set(f, usados + 1);
          } else ordinario = false;
        }
        const tipo: TipoHora = descanso
          ? ordinario
            ? noct
              ? 'HDN'
              : 'HDD'
            : noct
              ? 'HEND'
              : 'HEDD'
          : ordinario
            ? noct
              ? 'HON'
              : 'HOD'
            : noct
              ? 'HEN'
              : 'HED';
        (porFecha[f] ??= vacio())[tipo]++;
      }
    }

    // Mínimo de minutos para que cuente la extra: por debajo se descarta (tiempo no reconocido).
    if (this.cfg.minimoMinutosExtra > 0)
      for (const f of Object.keys(porFecha)) {
        const d = porFecha[f];
        const extras = d.HED + d.HEN + d.HEDD + d.HEND;
        if (extras > 0 && extras < this.cfg.minimoMinutosExtra) d.HED = d.HEN = d.HEDD = d.HEND = 0;
      }

    for (const f of Object.keys(porFecha)) for (const t of TIPOS_HORA) total[t] += porFecha[f][t];

    alertas.push(...this.alertasPuntualidad(ordenados, ventanas));
    alertas.push(...this.alertasExtras(porFecha));
    return { porFecha, total, alertas };
  }

  private alertasPuntualidad(intervalos: Intervalo[], ventanas: { fecha: Fecha; ini: number; fin: number }[]): AlertaHoras[] {
    const out: AlertaHoras[] = [];
    const tol = this.cfg.toleranciaMinutos;
    for (const v of ventanas) {
      const toca = intervalos.filter((iv) => minutoAbs(iv.salida) > v.ini && minutoAbs(iv.entrada) < v.fin);
      if (toca.length === 0) continue;
      const primera = Math.min(...toca.map((iv) => minutoAbs(iv.entrada)));
      const ultima = Math.max(...toca.map((iv) => minutoAbs(iv.salida)));
      if (primera - v.ini > tol)
        out.push({ fecha: v.fecha, tipo: 'llegada_tarde', minutos: primera - v.ini, mensaje: `Llegó ${primera - v.ini} minutos tarde` });
      if (v.fin - ultima > tol)
        out.push({ fecha: v.fecha, tipo: 'salida_anticipada', minutos: v.fin - ultima, mensaje: `Salió ${v.fin - ultima} minutos antes` });
    }
    return out;
  }

  private alertasExtras(porFecha: Record<Fecha, MinutosPorTipo>): AlertaHoras[] {
    const out: AlertaHoras[] = [];
    const semanas = new Map<string, number>();
    for (const f of Object.keys(porFecha).sort()) {
      const d = porFecha[f];
      const extras = (Object.keys(d) as TipoHora[]).filter(esExtra).reduce((a, t) => a + d[t], 0);
      if (extras > this.cfg.maxExtrasDia * 60)
        out.push({ fecha: f, tipo: 'exceso_extras_dia', minutos: extras, mensaje: `${(extras / 60).toFixed(1)} horas extra en el día (máximo ${this.cfg.maxExtrasDia})` });
      // La semana empieza el lunes.
      const ds = diaSemana(f);
      const lunes = sumarDias(f, -((ds + 6) % 7));
      semanas.set(lunes, (semanas.get(lunes) ?? 0) + extras);
    }
    for (const [lunes, m] of semanas)
      if (m > this.cfg.maxExtrasSemana * 60)
        out.push({ fecha: lunes, tipo: 'exceso_extras_semana', minutos: m, mensaje: `${(m / 60).toFixed(1)} horas extra en la semana (máximo ${this.cfg.maxExtrasSemana})` });
    return out;
  }
}

export interface Marcacion {
  tipo: 'entrada' | 'salida';
  hora: string; // 'AAAA-MM-DDTHH:mm'
}

/**
 * Empareja marcaciones de entrada y salida en orden. Una entrada sin salida
 * (o salida sin entrada) queda como incompleta y no pasa a la nómina (HU-30).
 */
export function emparejarMarcaciones(marcas: Marcacion[]): { intervalos: Intervalo[]; incompletas: Marcacion[] } {
  const ordenadas = [...marcas].sort((a, b) => a.hora.localeCompare(b.hora));
  const intervalos: Intervalo[] = [];
  const incompletas: Marcacion[] = [];
  let abierta: Marcacion | null = null;
  for (const m of ordenadas) {
    if (m.tipo === 'entrada') {
      if (abierta) incompletas.push(abierta);
      abierta = m;
    } else if (abierta) {
      intervalos.push({ entrada: abierta.hora, salida: m.hora });
      abierta = null;
    } else incompletas.push(m);
  }
  if (abierta) incompletas.push(abierta);
  return { intervalos, incompletas };
}

/** Convierte minutos a horas con dos decimales (para la nómina). */
export const aHoras = (min: number) => Math.round((min / 60) * 100) / 100;
