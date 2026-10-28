import { D, Decimal } from './decimal';

/**
 * Motor de fórmulas de Jornal 360.
 *
 * Sintaxis (pensada para usuarios de hojas de cálculo en español):
 *   - Números con coma o punto decimal: 0,10  0.10  1750905
 *   - Separador de argumentos: punto y coma  ->  SI(A > 1; 2; 3)
 *   - Operadores: + - * / ^  y comparaciones = <> != < <= > >=
 *   - Funciones: SI, Y, O, NO, MIN, MAX, ABS, REDONDEAR, REDONDEAR_ARRIBA,
 *                REDONDEAR_ABAJO, TRUNCAR, TABLA('codigo'; valor[; 'columna'])
 *   - Variables: identificadores en mayúscula (SALARIO, SMMLV, DIAS_TRABAJADOS)
 *     y códigos de otros conceptos.
 * Nunca se ejecuta código del usuario: la fórmula se convierte en un árbol
 * y solo se evalúan los nodos conocidos.
 */

export class FormulaError extends Error {
  constructor(
    message: string,
    public readonly posicion?: number,
  ) {
    super(posicion === undefined ? message : `${message} (posición ${posicion + 1})`);
    this.name = 'FormulaError';
  }
}

type Token =
  | { t: 'num'; v: string; p: number }
  | { t: 'id'; v: string; p: number }
  | { t: 'str'; v: string; p: number }
  | { t: 'op'; v: string; p: number }
  | { t: '('; p: number }
  | { t: ')'; p: number }
  | { t: ';'; p: number }
  | { t: 'eof'; p: number };

export type Nodo =
  | { k: 'num'; v: Decimal }
  | { k: 'str'; v: string }
  | { k: 'var'; nombre: string; p: number }
  | { k: 'un'; op: string; a: Nodo }
  | { k: 'bin'; op: string; a: Nodo; b: Nodo }
  | { k: 'fn'; nombre: string; args: Nodo[]; p: number };

const ID_START = /[\p{L}_]/u;
const ID_PART = /[\p{L}\p{N}_]/u;

function tokenizar(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const ini = i;
      while (i < src.length && /[0-9]/.test(src[i])) i++;
      if ((src[i] === ',' || src[i] === '.') && /[0-9]/.test(src[i + 1] ?? '')) {
        i++;
        while (i < src.length && /[0-9]/.test(src[i])) i++;
      }
      out.push({ t: 'num', v: src.slice(ini, i).replace(',', '.'), p: ini });
      continue;
    }
    if (ID_START.test(c)) {
      const ini = i;
      while (i < src.length && ID_PART.test(src[i])) i++;
      out.push({ t: 'id', v: normalizarId(src.slice(ini, i)), p: ini });
      continue;
    }
    if (c === "'" || c === '"') {
      const ini = i;
      const fin = src.indexOf(c, i + 1);
      if (fin < 0) throw new FormulaError('Texto sin cerrar', ini);
      out.push({ t: 'str', v: src.slice(i + 1, fin), p: ini });
      i = fin + 1;
      continue;
    }
    if (c === '(' || c === ')' || c === ';') {
      out.push({ t: c, p: i } as Token);
      i++;
      continue;
    }
    const dos = src.slice(i, i + 2);
    if (['<=', '>=', '<>', '!=', '=='].includes(dos)) {
      out.push({ t: 'op', v: dos === '!=' ? '<>' : dos === '==' ? '=' : dos, p: i });
      i += 2;
      continue;
    }
    if ('+-*/^<>='.includes(c)) {
      out.push({ t: 'op', v: c, p: i });
      i++;
      continue;
    }
    if (c === ',') throw new FormulaError('Use punto y coma (;) para separar los argumentos', i);
    throw new FormulaError(`Carácter no permitido "${c}"`, i);
  }
  out.push({ t: 'eof', p: src.length });
  return out;
}

/** Normaliza identificadores: mayúsculas y sin tildes, para que "Salario" y "SALARIO" sean lo mismo. */
export function normalizarId(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();
}

const PRECEDENCIA: Record<string, number> = {
  '=': 1,
  '<>': 1,
  '<': 2,
  '<=': 2,
  '>': 2,
  '>=': 2,
  '+': 3,
  '-': 3,
  '*': 4,
  '/': 4,
  '^': 6,
};

class Parser {
  private i = 0;
  constructor(private readonly toks: Token[]) {}

  private ver(): Token {
    return this.toks[this.i];
  }
  private sig(): Token {
    return this.toks[this.i++];
  }

  parsear(): Nodo {
    if (this.ver().t === 'eof') throw new FormulaError('La fórmula está vacía');
    const n = this.expr(0);
    const t = this.ver();
    if (t.t !== 'eof') throw new FormulaError('Sobra texto al final de la fórmula', t.p);
    return n;
  }

  private expr(minPrec: number): Nodo {
    let izq = this.unario();
    for (;;) {
      const t = this.ver();
      if (t.t !== 'op') break;
      const prec = PRECEDENCIA[t.v];
      if (prec === undefined || prec < minPrec) break;
      this.sig();
      // ^ es asociativo a la derecha
      const der = this.expr(t.v === '^' ? prec : prec + 1);
      izq = { k: 'bin', op: t.v, a: izq, b: der };
    }
    return izq;
  }

  private unario(): Nodo {
    const t = this.ver();
    if (t.t === 'op' && (t.v === '-' || t.v === '+')) {
      this.sig();
      const a = this.expr(5);
      return t.v === '-' ? { k: 'un', op: '-', a } : a;
    }
    return this.primario();
  }

  private primario(): Nodo {
    const t = this.sig();
    switch (t.t) {
      case 'num':
        return { k: 'num', v: D(t.v) };
      case 'str':
        return { k: 'str', v: t.v };
      case '(': {
        const n = this.expr(0);
        const c = this.sig();
        if (c.t !== ')') throw new FormulaError('Falta cerrar un paréntesis', c.p);
        return n;
      }
      case 'id': {
        if (this.ver().t === '(') {
          this.sig();
          const args: Nodo[] = [];
          if (this.ver().t !== ')') {
            for (;;) {
              args.push(this.expr(0));
              const s = this.ver();
              if (s.t === ';') {
                this.sig();
                continue;
              }
              break;
            }
          }
          const c = this.sig();
          if (c.t !== ')') throw new FormulaError(`Falta cerrar el paréntesis de ${t.v}`, c.p);
          return { k: 'fn', nombre: t.v, args, p: t.p };
        }
        if (t.v === 'VERDADERO') return { k: 'num', v: D(1) };
        if (t.v === 'FALSO') return { k: 'num', v: D(0) };
        return { k: 'var', nombre: t.v, p: t.p };
      }
      case 'eof':
        throw new FormulaError('La fórmula termina de forma incompleta', t.p);
      default:
        throw new FormulaError('Se esperaba un número, variable o función', t.p);
    }
  }
}

const FUNCIONES: Record<string, { min: number; max: number }> = {
  SI: { min: 2, max: 3 },
  Y: { min: 1, max: 50 },
  O: { min: 1, max: 50 },
  NO: { min: 1, max: 1 },
  MIN: { min: 1, max: 50 },
  MAX: { min: 1, max: 50 },
  ABS: { min: 1, max: 1 },
  REDONDEAR: { min: 1, max: 2 },
  REDONDEAR_ARRIBA: { min: 1, max: 2 },
  REDONDEAR_ABAJO: { min: 1, max: 2 },
  TRUNCAR: { min: 1, max: 2 },
  TABLA: { min: 2, max: 3 },
};

export const FUNCIONES_DISPONIBLES = Object.keys(FUNCIONES);

const cache = new Map<string, Nodo>();

export function parsearFormula(src: string): Nodo {
  const hit = cache.get(src);
  if (hit) return hit;
  const nodo = new Parser(tokenizar(src)).parsear();
  validarFunciones(nodo);
  if (cache.size > 5000) cache.clear();
  cache.set(src, nodo);
  return nodo;
}

function validarFunciones(n: Nodo): void {
  if (n.k === 'fn') {
    const f = FUNCIONES[n.nombre];
    if (!f) throw new FormulaError(`La función ${n.nombre} no existe`, n.p);
    if (n.args.length < f.min || n.args.length > f.max)
      throw new FormulaError(
        `${n.nombre} recibe ${f.min === f.max ? f.min : `entre ${f.min} y ${f.max}`} argumentos`,
        n.p,
      );
    if (n.nombre === 'TABLA' && n.args[0].k !== 'str')
      throw new FormulaError("TABLA necesita el código entre comillas, por ejemplo TABLA('FSP'; IBC)", n.p);
    n.args.forEach(validarFunciones);
  } else if (n.k === 'bin') {
    validarFunciones(n.a);
    validarFunciones(n.b);
  } else if (n.k === 'un') validarFunciones(n.a);
}

/** Variables y conceptos que usa la fórmula (para validar y ordenar dependencias). */
export function variablesDe(src: string | Nodo): Set<string> {
  const nodo = typeof src === 'string' ? parsearFormula(src) : src;
  const s = new Set<string>();
  const rec = (n: Nodo) => {
    if (n.k === 'var') s.add(n.nombre);
    else if (n.k === 'bin') {
      rec(n.a);
      rec(n.b);
    } else if (n.k === 'un') rec(n.a);
    else if (n.k === 'fn') n.args.forEach(rec);
  };
  rec(nodo);
  return s;
}

/** Tablas que consulta la fórmula con TABLA('codigo'; ...). */
export function tablasDe(src: string): Set<string> {
  const s = new Set<string>();
  const rec = (n: Nodo) => {
    if (n.k === 'fn') {
      if (n.nombre === 'TABLA' && n.args[0].k === 'str') s.add(normalizarId(n.args[0].v));
      n.args.forEach(rec);
    } else if (n.k === 'bin') {
      rec(n.a);
      rec(n.b);
    } else if (n.k === 'un') rec(n.a);
  };
  rec(parsearFormula(src));
  return s;
}

export interface ContextoFormula {
  variable(nombre: string): Decimal | undefined;
  tabla?(codigo: string, valor: Decimal, columna?: string): Decimal;
}

const bool = (b: boolean) => D(b ? 1 : 0);
const verdadero = (d: Decimal) => !d.isZero();

export function evaluar(src: string | Nodo, ctx: ContextoFormula): Decimal {
  const nodo = typeof src === 'string' ? parsearFormula(src) : src;
  return ev(nodo, ctx);
}

function ev(n: Nodo, ctx: ContextoFormula): Decimal {
  switch (n.k) {
    case 'num':
      return n.v;
    case 'str':
      throw new FormulaError('Un texto solo se puede usar como código de TABLA');
    case 'var': {
      const v = ctx.variable(n.nombre);
      if (v === undefined) throw new FormulaError(`La variable ${n.nombre} no existe`, n.p);
      return v;
    }
    case 'un':
      return ev(n.a, ctx).neg();
    case 'bin': {
      const a = ev(n.a, ctx);
      const b = ev(n.b, ctx);
      switch (n.op) {
        case '+':
          return a.plus(b);
        case '-':
          return a.minus(b);
        case '*':
          return a.mul(b);
        case '/':
          // Dividir por cero da cero, como en una nómina sin días: evita romper toda la liquidación.
          return b.isZero() ? D(0) : a.div(b);
        case '^':
          return a.pow(b);
        case '=':
          return bool(a.eq(b));
        case '<>':
          return bool(!a.eq(b));
        case '<':
          return bool(a.lt(b));
        case '<=':
          return bool(a.lte(b));
        case '>':
          return bool(a.gt(b));
        case '>=':
          return bool(a.gte(b));
      }
      throw new FormulaError(`Operador ${n.op} desconocido`);
    }
    case 'fn': {
      const A = n.args;
      const decimales = (i: number) => (A[i] ? ev(A[i], ctx).toNumber() : 0);
      switch (n.nombre) {
        case 'SI':
          return verdadero(ev(A[0], ctx)) ? ev(A[1], ctx) : A[2] ? ev(A[2], ctx) : D(0);
        case 'Y':
          return bool(A.every((x) => verdadero(ev(x, ctx))));
        case 'O':
          return bool(A.some((x) => verdadero(ev(x, ctx))));
        case 'NO':
          return bool(!verdadero(ev(A[0], ctx)));
        case 'MIN':
          return Decimal.min(...A.map((x) => ev(x, ctx)));
        case 'MAX':
          return Decimal.max(...A.map((x) => ev(x, ctx)));
        case 'ABS':
          return ev(A[0], ctx).abs();
        case 'REDONDEAR':
          return ev(A[0], ctx).toDecimalPlaces(decimales(1), Decimal.ROUND_HALF_UP);
        case 'REDONDEAR_ARRIBA':
          return ev(A[0], ctx).toDecimalPlaces(decimales(1), Decimal.ROUND_CEIL);
        case 'REDONDEAR_ABAJO':
          return ev(A[0], ctx).toDecimalPlaces(decimales(1), Decimal.ROUND_FLOOR);
        case 'TRUNCAR':
          return ev(A[0], ctx).toDecimalPlaces(decimales(1), Decimal.ROUND_DOWN);
        case 'TABLA': {
          if (!ctx.tabla) throw new FormulaError('No hay tablas disponibles', n.p);
          const codigo = normalizarId((A[0] as { v: string }).v);
          const col = A[2] ? (A[2].k === 'str' ? A[2].v : undefined) : undefined;
          return ctx.tabla(codigo, ev(A[1], ctx), col);
        }
      }
      throw new FormulaError(`La función ${n.nombre} no existe`, n.p);
    }
  }
}

/**
 * Valida una fórmula: sintaxis, funciones y que todas sus variables existan.
 * Devuelve la lista de errores (vacía si la fórmula es válida).
 */
export function validarFormula(src: string, variablesConocidas: Set<string>, tablasConocidas?: Set<string>): string[] {
  const errores: string[] = [];
  try {
    const nodo = parsearFormula(src);
    for (const v of variablesDe(nodo)) if (!variablesConocidas.has(v)) errores.push(`La variable ${v} no existe`);
    if (tablasConocidas)
      for (const t of tablasDe(src)) if (!tablasConocidas.has(t)) errores.push(`La tabla ${t} no existe`);
  } catch (e) {
    errores.push((e as Error).message);
  }
  return errores;
}

/**
 * Ordena los conceptos para evaluarlos después de los conceptos de los que dependen.
 * Lanza FormulaError si hay una referencia circular.
 */
export function ordenarPorDependencias<T extends { codigo: string; formula: string }>(conceptos: T[]): T[] {
  const porCodigo = new Map(conceptos.map((c) => [c.codigo, c]));
  const estado = new Map<string, 'visitando' | 'listo'>();
  const out: T[] = [];
  const visitar = (c: T, camino: string[]) => {
    const st = estado.get(c.codigo);
    if (st === 'listo') return;
    if (st === 'visitando')
      throw new FormulaError(`Referencia circular: ${[...camino, c.codigo].join(' → ')}`);
    estado.set(c.codigo, 'visitando');
    for (const v of variablesDe(c.formula)) {
      const dep = porCodigo.get(v);
      if (dep) visitar(dep, [...camino, c.codigo]);
    }
    estado.set(c.codigo, 'listo');
    out.push(c);
  };
  for (const c of conceptos) visitar(c, []);
  return out;
}
