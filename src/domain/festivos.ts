import { diaSemana, Fecha, fecha, sumarDias } from './fechas';

export interface Festivo {
  fecha: Fecha;
  nombre: string;
}

/** Domingo de Pascua (algoritmo gregoriano anónimo de Meeus/Jones/Butcher). */
export function domingoDePascua(anio: number): Fecha {
  const a = anio % 19;
  const b = Math.floor(anio / 100);
  const c = anio % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return fecha(anio, mes, dia);
}

/** Traslada al lunes siguiente si la fecha no cae en lunes (Ley 51 de 1983). */
export function trasladarALunes(f: Fecha): Fecha {
  const ds = diaSemana(f);
  return ds === 1 ? f : sumarDias(f, (8 - ds) % 7);
}

/**
 * Los 18 festivos de Colombia (CST art. 177, Ley 51 de 1983).
 * El superusuario puede agregar, quitar o mover festivos en la base de datos;
 * esta función solo genera la propuesta inicial de cada año.
 */
export function festivosColombia(anio: number): Festivo[] {
  const pascua = domingoDePascua(anio);
  const fijos: Festivo[] = [
    { fecha: fecha(anio, 1, 1), nombre: 'Año Nuevo' },
    { fecha: fecha(anio, 5, 1), nombre: 'Día del Trabajo' },
    { fecha: fecha(anio, 7, 20), nombre: 'Día de la Independencia' },
    { fecha: fecha(anio, 8, 7), nombre: 'Batalla de Boyacá' },
    { fecha: fecha(anio, 12, 8), nombre: 'Inmaculada Concepción' },
    { fecha: fecha(anio, 12, 25), nombre: 'Navidad' },
    { fecha: sumarDias(pascua, -3), nombre: 'Jueves Santo' },
    { fecha: sumarDias(pascua, -2), nombre: 'Viernes Santo' },
  ];
  const trasladables: Festivo[] = [
    { fecha: fecha(anio, 1, 6), nombre: 'Día de los Reyes Magos' },
    { fecha: fecha(anio, 3, 19), nombre: 'Día de San José' },
    { fecha: fecha(anio, 6, 29), nombre: 'San Pedro y San Pablo' },
    { fecha: fecha(anio, 8, 15), nombre: 'Asunción de la Virgen' },
    { fecha: fecha(anio, 10, 12), nombre: 'Día de la Raza' },
    { fecha: fecha(anio, 11, 1), nombre: 'Todos los Santos' },
    { fecha: fecha(anio, 11, 11), nombre: 'Independencia de Cartagena' },
    { fecha: sumarDias(pascua, 39), nombre: 'Ascensión del Señor' },
    { fecha: sumarDias(pascua, 60), nombre: 'Corpus Christi' },
    { fecha: sumarDias(pascua, 68), nombre: 'Sagrado Corazón de Jesús' },
  ].map((f) => ({ ...f, fecha: trasladarALunes(f.fecha) }));
  return [...fijos, ...trasladables].sort((a, b) => a.fecha.localeCompare(b.fecha));
}
