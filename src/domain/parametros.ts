import { D, Decimal } from './decimal';
import { Fecha } from './fechas';
import { normalizarId } from './formulas';

/** Valor de un parámetro desde una fecha (vigencia). */
export interface VigenciaParametro {
  codigo: string;
  desde: Fecha;
  valor: string | number | Decimal;
}

export interface FuenteParametros {
  valor(codigo: string, fecha: Fecha): Decimal | undefined;
  codigos(): string[];
  /** Fechas (después de `desde` y hasta `hasta` inclusive) en que cambia algún parámetro. */
  cambiosEntre(desde: Fecha, hasta: Fecha): Fecha[];
}

export class ParametrosEnMemoria implements FuenteParametros {
  private readonly porCodigo = new Map<string, { desde: Fecha; valor: Decimal }[]>();

  constructor(vigencias: VigenciaParametro[]) {
    for (const v of vigencias) {
      const c = normalizarId(v.codigo);
      const lista = this.porCodigo.get(c) ?? [];
      lista.push({ desde: v.desde, valor: D(v.valor) });
      this.porCodigo.set(c, lista);
    }
    for (const l of this.porCodigo.values()) l.sort((a, b) => a.desde.localeCompare(b.desde));
  }

  valor(codigo: string, fecha: Fecha): Decimal | undefined {
    const lista = this.porCodigo.get(normalizarId(codigo));
    if (!lista?.length) return undefined;
    let v: Decimal | undefined;
    for (const x of lista) if (x.desde <= fecha) v = x.valor;
    // Antes de la primera vigencia se usa la más antigua, para no dejar el cálculo sin valor.
    return v ?? lista[0].valor;
  }

  codigos(): string[] {
    return [...this.porCodigo.keys()];
  }

  cambiosEntre(desde: Fecha, hasta: Fecha): Fecha[] {
    const s = new Set<Fecha>();
    for (const l of this.porCodigo.values()) for (const x of l) if (x.desde > desde && x.desde <= hasta) s.add(x.desde);
    return [...s].sort();
  }

  /** Cambia o agrega una vigencia (útil para simulaciones y pruebas). */
  con(codigo: string, desde: Fecha, valor: string | number): ParametrosEnMemoria {
    const todas: VigenciaParametro[] = [];
    for (const [c, l] of this.porCodigo) for (const x of l) todas.push({ codigo: c, desde: x.desde, valor: x.valor });
    const c = normalizarId(codigo);
    const resto = todas.filter((v) => !(v.codigo === c && v.desde === desde));
    return new ParametrosEnMemoria([...resto, { codigo: c, desde, valor }]);
  }
}

export interface FilaTablaRango {
  desde: Decimal;
  hasta: Decimal | null;
  valores: Record<string, Decimal>;
}

export interface FuenteTablas {
  buscar(codigo: string, valor: Decimal, columna?: string): Decimal;
  filas(codigo: string): FilaTablaRango[] | undefined;
  codigos(): string[];
}

export class TablasEnMemoria implements FuenteTablas {
  private readonly tablas = new Map<string, { columnas: string[]; filas: FilaTablaRango[] }>();

  constructor(tablas: { codigo: string; columnas: string[]; filas: { desde: string | number; hasta: string | number | null; valores: Record<string, string | number> }[] }[]) {
    for (const t of tablas) {
      const filas = t.filas
        .map((f) => ({
          desde: D(f.desde),
          hasta: f.hasta === null || f.hasta === '' ? null : D(f.hasta),
          valores: Object.fromEntries(Object.entries(f.valores).map(([k, v]) => [k, D(v)])),
        }))
        .sort((a, b) => a.desde.cmp(b.desde));
      this.tablas.set(normalizarId(t.codigo), { columnas: t.columnas, filas });
    }
  }

  filas(codigo: string): FilaTablaRango[] | undefined {
    return this.tablas.get(normalizarId(codigo))?.filas;
  }

  codigos(): string[] {
    return [...this.tablas.keys()];
  }

  /** Busca la fila donde desde <= valor < hasta y devuelve la columna pedida (o la primera). */
  buscar(codigo: string, valor: Decimal, columna?: string): Decimal {
    const t = this.tablas.get(normalizarId(codigo));
    if (!t) throw new Error(`La tabla ${codigo} no existe`);
    const col = columna ?? t.columnas[0];
    const fila = t.filas.find((f) => valor.gte(f.desde) && (f.hasta === null || valor.lt(f.hasta)));
    if (!fila) return D(0);
    return fila.valores[col] ?? D(0);
  }
}
