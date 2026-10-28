import { D } from '../../src/domain/decimal';
import {
  evaluar,
  FormulaError,
  ordenarPorDependencias,
  parsearFormula,
  tablasDe,
  validarFormula,
  variablesDe,
} from '../../src/domain/formulas';

const ctx = (vars: Record<string, number | string>) => ({
  variable: (n: string) => (n in vars ? D(vars[n]) : undefined),
  tabla: (codigo: string, valor: any) => (codigo === 'FSP' ? (valor.gte(4) ? D('0.01') : D(0)) : D(-1)),
});

const val = (f: string, vars: Record<string, number | string> = {}) => evaluar(f, ctx(vars)).toFixed();

describe('Motor de fórmulas', () => {
  it('aritmética básica con precedencia', () => {
    expect(val('1 + 2 * 3')).toBe('7');
    expect(val('(1 + 2) * 3')).toBe('9');
    expect(val('10 - 4 - 3')).toBe('3');
    expect(val('2 ^ 3 ^ 2')).toBe('512');
    expect(val('-2 ^ 2')).toBe('-4');
    expect(val('-3 * 2 + 1')).toBe('-5');
  });

  it('acepta coma y punto como separador decimal', () => {
    expect(val('0,10 * 1000')).toBe('100');
    expect(val('0.10 * 1000')).toBe('100');
  });

  it('es exacta con decimales (sin errores de coma flotante)', () => {
    expect(val('0,1 + 0,2')).toBe('0.3');
    expect(val('1750905 / 30 * 21')).toBe('1225633.5');
  });

  it('divide por cero como cero', () => {
    expect(val('100 / 0')).toBe('0');
  });

  it('variables sin importar mayúsculas ni tildes', () => {
    expect(val('Salario * 2', { SALARIO: 1000 })).toBe('2000');
    expect(val('antigüedad_años + 1', { ANTIGUEDAD_ANOS: 5 })).toBe('6');
    expect(val('ANTIGUEDAD_ANOS', { ANTIGUEDAD_ANOS: 3 })).toBe('3');
  });

  it('el ejemplo de la historia HU-11', () => {
    const f = 'SI(ANTIGUEDAD_ANOS >= 5; SALARIO * 0,10; 0)';
    expect(val(f, { ANTIGUEDAD_ANOS: 6, SALARIO: 3000000 })).toBe('300000');
    expect(val(f, { ANTIGUEDAD_ANOS: 4, SALARIO: 3000000 })).toBe('0');
  });

  it('SI evalúa solo la rama elegida', () => {
    // La rama falsa usa una variable inexistente: no debe evaluarse.
    expect(val('SI(1; 5; NOEXISTE)')).toBe('5');
    expect(val('SI(0; 5)')).toBe('0');
  });

  it('comparaciones y lógica', () => {
    expect(val('Y(1 < 2; 3 >= 3)')).toBe('1');
    expect(val('O(1 > 2; 3 <> 3)')).toBe('0');
    expect(val('NO(0)')).toBe('1');
    expect(val('2 = 2')).toBe('1');
    expect(val('2 != 3')).toBe('1');
    expect(val('VERDADERO + FALSO')).toBe('1');
  });

  it('funciones numéricas', () => {
    expect(val('MIN(3; 1; 2)')).toBe('1');
    expect(val('MAX(3; 1; 2)')).toBe('3');
    expect(val('ABS(-5)')).toBe('5');
    expect(val('REDONDEAR(2,5)')).toBe('3');
    expect(val('REDONDEAR(1234,567; 2)')).toBe('1234.57');
    expect(val('REDONDEAR_ARRIBA(10,01)')).toBe('11');
    expect(val('REDONDEAR_ABAJO(10,99)')).toBe('10');
    expect(val('TRUNCAR(-10,99)')).toBe('-10');
  });

  it('TABLA consulta una tabla configurable', () => {
    expect(val("TABLA('fsp'; 5)")).toBe('0.01');
    expect(val("TABLA('FSP'; 2)")).toBe('0');
    expect(tablasDe("TABLA('fsp'; IBC) * 2")).toEqual(new Set(['FSP']));
  });

  it('extrae las variables usadas', () => {
    expect(variablesDe('SI(A > B; C * 2; D)')).toEqual(new Set(['A', 'B', 'C', 'D']));
  });

  it('errores claros de sintaxis', () => {
    expect(() => parsearFormula('')).toThrow('vacía');
    expect(() => parsearFormula('1 +')).toThrow(FormulaError);
    expect(() => parsearFormula('(1 + 2')).toThrow('paréntesis');
    expect(() => parsearFormula('SI(1, 2, 3)')).toThrow('punto y coma');
    expect(() => parsearFormula('FOO(1)')).toThrow('no existe');
    expect(() => parsearFormula('SI(1)')).toThrow('argumentos');
    expect(() => parsearFormula('1 2')).toThrow('Sobra');
    expect(() => parsearFormula('A $ B')).toThrow('no permitido');
    expect(() => parsearFormula("TABLA(X; 1)")).toThrow('comillas');
    expect(() => parsearFormula("'abc")).toThrow('sin cerrar');
  });

  it('error en tiempo de evaluación por variable inexistente', () => {
    expect(() => val('X + 1')).toThrow('La variable X no existe');
  });

  it('valida contra variables conocidas', () => {
    const conocidas = new Set(['SALARIO']);
    expect(validarFormula('SALARIO * 2', conocidas)).toEqual([]);
    expect(validarFormula('SALARIO * BONO', conocidas)).toEqual(['La variable BONO no existe']);
    expect(validarFormula('SALARIO *', conocidas).length).toBe(1);
    expect(validarFormula("TABLA('X'; 1)", conocidas, new Set(['FSP']))).toEqual(['La tabla X no existe']);
  });

  it('ordena por dependencias y detecta ciclos', () => {
    const orden = ordenarPorDependencias([
      { codigo: 'C', formula: 'A + B' },
      { codigo: 'A', formula: 'SALARIO' },
      { codigo: 'B', formula: 'A * 2' },
    ]).map((c) => c.codigo);
    expect(orden).toEqual(['A', 'B', 'C']);
    expect(() =>
      ordenarPorDependencias([
        { codigo: 'A', formula: 'B + 1' },
        { codigo: 'B', formula: 'A + 1' },
      ]),
    ).toThrow('circular');
    expect(() => ordenarPorDependencias([{ codigo: 'A', formula: 'A + 1' }])).toThrow('circular');
  });
});
