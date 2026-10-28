import { CategoriaDeduccion, ConceptoCatalogo, TipoConcepto } from './catalogo';
import { D, Decimal, Num, redondear, ModoRedondeo, sum, ZERO } from './decimal';
import { diasComerciales, Fecha, finDeMes, maxFecha, minFecha, rango, sumarDias, diaSemana } from './fechas';
import { evaluar, FormulaError, normalizarId, ordenarPorDependencias, parsearFormula, variablesDe } from './formulas';
import { TIPOS_HORA, TipoHora } from './horas';
import { FuenteParametros, FuenteTablas } from './parametros';
import { salarioEn, CambioSalario } from './prestaciones';
import { calcularRetencion, FilaTablaRetencion, ParamsRetencion } from './retencion';
import { TipoContrato } from './retiro';

/**
 * Motor de liquidación de nómina de Jornal 360.
 *
 * Todo concepto se calcula con una fórmula editable. El motor solo prepara las variables
 * (días, horas, novedades, bases) y aplica las reglas que no son fórmulas: el IBC con la
 * regla del 40%, la depuración de la retención y los límites de embargos y descuentos.
 */

export type ConceptoNomina = ConceptoCatalogo & { id?: string };

export type TipoNovedadDias =
  | 'incapacidad_eg'
  | 'incapacidad_laboral'
  | 'licencia_maternidad'
  | 'licencia_paternidad'
  | 'licencia_remunerada'
  | 'licencia_no_remunerada'
  | 'suspension'
  | 'ausencia_injustificada'
  | 'vacaciones';

export interface NovedadDias {
  id?: string;
  tipo: TipoNovedadDias;
  desde: Fecha;
  hasta: Fecha;
  /** Días de incapacidad anteriores de la misma enfermedad (prórroga). */
  diasPrevios?: number;
  descripcion?: string;
}

export interface NovedadValor {
  id?: string;
  concepto: string;
  valor?: Num;
  cantidad?: Num;
  fecha?: Fecha;
}

export interface HorasAprobadas {
  fecha: Fecha;
  tipo: TipoHora;
  horas: Num;
}

export interface Prestamo {
  id: string;
  descripcion: string;
  cuota: Num;
  saldo: Num;
  tipo: 'prestamo' | 'libranza';
}

export interface Embargo {
  id: string;
  descripcion: string;
  tipo: 'ordinario' | 'alimentos' | 'cooperativa';
  valorFijo?: Num;
  /** Porcentaje (0 a 1) del máximo embargable. */
  porcentaje?: Num;
  saldo?: Num | null;
  prioridad?: number;
}

export type FaseAprendiz = 'lectiva' | 'practica' | 'dual_1' | 'dual_2' | 'universitario';

export interface ContratoNomina {
  tipo: TipoContrato;
  fechaInicio: Fecha;
  fechaFin?: Fecha | null;
  historialSalario: CambioSalario[];
  salarioIntegral?: boolean;
  factorPrestacional?: Num; // 0,30
  faseAprendiz?: FaseAprendiz;
  /** 'ley' = según el tope; 'siempre'; 'nunca'. */
  auxilioTransporte?: 'ley' | 'siempre' | 'nunca';
}

export interface EmpleadoNomina {
  id: string;
  nombre?: string;
  fechaIngreso?: Fecha;
  esPensionado?: boolean;
  claseRiesgo?: number;
  procedimientoRetencion?: 1 | 2;
  porcentajeProcedimiento2?: Num;
  tieneDependiente?: boolean;
  dependientesAdicionales?: number;
  interesesVivienda?: Num;
  medicinaPrepagada?: Num;
  aportesVoluntarios?: Num;
  /** Variables propias del empleado (campos adicionales numéricos). */
  variables?: Record<string, Num>;
}

export interface AcumuladoMes {
  ingresosRetencion: Num;
  noConstitutivos: Num;
  retencionPracticada: Num;
}

export interface PeriodoNomina {
  desde: Fecha;
  hasta: Fecha;
  /** Si es la última liquidación del mes (por defecto: hasta = fin de mes). */
  cierraMes?: boolean;
}

export interface EntradaNomina {
  periodo: PeriodoNomina;
  empleado: EmpleadoNomina;
  contrato: ContratoNomina;
  novedadesDias?: NovedadDias[];
  novedadesValor?: NovedadValor[];
  horas?: HorasAprobadas[];
  prestamos?: Prestamo[];
  embargos?: Embargo[];
  acumuladoMes?: AcumuladoMes;
  /** Base de vacaciones si el salario es variable (promedio del último año). */
  baseVacaciones?: Num;
  /** IBC del mes anterior para valorar incapacidades (si no, se usa el salario). */
  ibcMesAnterior?: Num;
  /** Valor de la asignación de cada concepto al empleado (variable VALOR_ASIGNADO). */
  valoresAsignados?: Record<string, Num>;
}

export interface ContextoNomina {
  conceptos: ConceptoNomina[];
  parametros: FuenteParametros;
  tablas: FuenteTablas;
  empresa: { exonerada: boolean };
}

export interface LineaNomina {
  concepto: string;
  nombre: string;
  tipo: TipoConcepto;
  categoria?: CategoriaDeduccion;
  cantidad?: string;
  valor: string;
  /** Explicación paso a paso: fórmula y valores usados. */
  detalle: DetalleCalculo;
  referencia?: string; // id del préstamo o embargo
}

export interface DetalleCalculo {
  formula?: string;
  variables?: Record<string, string>;
  sinRedondear?: string;
  tramos?: { desde: Fecha; hasta: Fecha; valor: string; variables: Record<string, string> }[];
  nota?: string;
}

export interface AlertaNomina {
  nivel: 'info' | 'advertencia' | 'error';
  mensaje: string;
}

export interface ResultadoNomina {
  empleadoId: string;
  desde: Fecha;
  hasta: Fecha;
  lineas: LineaNomina[];
  totales: {
    devengos: string;
    deducciones: string;
    neto: string;
    aportesEmpleador: string;
    provisiones: string;
    costoTotal: string;
  };
  bases: Record<string, string>;
  dias: Record<string, number>;
  alertas: AlertaNomina[];
  pendientes: { referencia: string; descripcion: string; noAplicado: string }[];
  retencion?: { pasos: { concepto: string; valor: string; uvt: string }[]; baseGravable: string };
}

const S = (d: Decimal) => d.toFixed();
const bool = (b: boolean) => D(b ? 1 : 0);

/** Variables que el motor siempre entrega, para validar fórmulas en el panel. */
export const VARIABLES_SISTEMA: { codigo: string; descripcion: string }[] = [
  { codigo: 'SALARIO', descripcion: 'Salario mensual vigente' },
  { codigo: 'SALARIO_DIARIO', descripcion: 'Salario mensual / días del mes' },
  { codigo: 'SUELDO_PROPORCIONAL', descripcion: 'Salario de los días pagados, con cambios de salario' },
  { codigo: 'DIAS_PERIODO', descripcion: 'Días comerciales del empleado en el periodo' },
  { codigo: 'DIAS_SALARIO', descripcion: 'Días pagados como salario' },
  { codigo: 'DIAS_AUXILIO', descripcion: 'Días con derecho a auxilio de transporte' },
  { codigo: 'DIAS_INCAPACIDAD', descripcion: 'Días de incapacidad en el periodo' },
  { codigo: 'DIAS_VACACIONES', descripcion: 'Días de vacaciones disfrutadas en el periodo' },
  { codigo: 'DIAS_LICENCIA_NO_REMUNERADA', descripcion: 'Días no remunerados (licencias, suspensiones, ausencias)' },
  { codigo: 'DIAS_LICENCIA_EPS', descripcion: 'Días de licencia de maternidad o paternidad' },
  { codigo: 'DIAS_COTIZADOS', descripcion: 'Días cotizados a seguridad social' },
  { codigo: 'HORAS_MES', descripcion: 'Horas de la jornada en el mes' },
  { codigo: 'VALOR_HORA', descripcion: 'Valor de la hora ordinaria' },
  ...TIPOS_HORA.map((t) => ({ codigo: `HORAS_${t}`, descripcion: `Horas del tipo ${t}` })),
  { codigo: 'VALOR_INCAP_EMPLEADOR', descripcion: 'Incapacidad a cargo del empleador' },
  { codigo: 'VALOR_INCAP_EPS', descripcion: 'Incapacidad a cargo de la EPS' },
  { codigo: 'VALOR_INCAP_AFP', descripcion: 'Incapacidad a cargo del fondo de pensiones' },
  { codigo: 'VALOR_INCAP_ARL', descripcion: 'Incapacidad a cargo de la ARL' },
  { codigo: 'VALOR_COMPLEMENTO_INCAP', descripcion: 'Diferencia hasta el 100% que paga la empresa' },
  { codigo: 'VALOR_LICENCIA_EPS', descripcion: 'Licencia de maternidad o paternidad' },
  { codigo: 'BASE_VACACIONES', descripcion: 'Base mensual de vacaciones' },
  { codigo: 'VALOR_VACACIONES', descripcion: 'Valor de las vacaciones disfrutadas' },
  { codigo: 'ES_INTEGRAL', descripcion: '1 si tiene salario integral' },
  { codigo: 'ES_APRENDIZ', descripcion: '1 si es aprendiz' },
  { codigo: 'ES_APRENDIZ_LECTIVA', descripcion: '1 si es aprendiz en fase lectiva' },
  { codigo: 'ES_PENSIONADO', descripcion: '1 si es pensionado' },
  { codigo: 'EXONERADO', descripcion: '1 si aplica la exoneración de aportes' },
  { codigo: 'TIENE_AUXILIO', descripcion: '1 si el contrato permite auxilio de transporte' },
  { codigo: 'CLASE_RIESGO', descripcion: 'Clase de riesgo ARL (1 a 5)' },
  { codigo: 'ANTIGUEDAD_ANOS', descripcion: 'Años de antigüedad (comerciales)' },
  { codigo: 'ANTIGUEDAD_DIAS', descripcion: 'Días de antigüedad (comerciales)' },
  { codigo: 'APORTES_VOLUNTARIOS', descripcion: 'Aporte voluntario mensual del empleado' },
  { codigo: 'VALOR_NOVEDAD', descripcion: 'Suma de valores de novedades del concepto' },
  { codigo: 'CANTIDAD_NOVEDAD', descripcion: 'Suma de cantidades de novedades del concepto' },
  { codigo: 'VALOR_ASIGNADO', descripcion: 'Valor fijado al asignar el concepto al empleado o grupo' },
  { codigo: 'TOTAL_DEVENGADO', descripcion: 'Total devengado del periodo' },
  { codigo: 'TOTAL_SALARIAL', descripcion: 'Total de pagos salariales' },
  { codigo: 'TOTAL_NO_SALARIAL', descripcion: 'Total de pagos no salariales (regla del 40%)' },
  { codigo: 'IBC_SALUD', descripcion: 'IBC de salud' },
  { codigo: 'IBC_PENSION', descripcion: 'IBC de pensión' },
  { codigo: 'IBC_ARL', descripcion: 'IBC de riesgos laborales' },
  { codigo: 'IBC_PARAFISCALES', descripcion: 'Base de caja, ICBF y SENA' },
  { codigo: 'IBC_MENSUAL', descripcion: 'IBC llevado a 30 días' },
  { codigo: 'BASE_PRESTACIONES', descripcion: 'Base de cesantías y prima del periodo' },
  { codigo: 'BASE_VACACIONES_PROV', descripcion: 'Base de provisión de vacaciones del periodo' },
  { codigo: 'RETENCION_CALCULADA', descripcion: 'Retención en la fuente calculada' },
];

export function variablesConocidas(ctx: Pick<ContextoNomina, 'conceptos' | 'parametros'>, extra: string[] = []): Set<string> {
  return new Set([
    ...VARIABLES_SISTEMA.map((v) => v.codigo),
    ...ctx.parametros.codigos(),
    ...ctx.conceptos.map((c) => normalizarId(c.codigo)),
    ...extra.map(normalizarId),
  ]);
}

interface Tramo {
  desde: Fecha;
  hasta: Fecha;
}

class Calculo {
  private readonly vars = new Map<string, Decimal>();
  readonly lineas: LineaNomina[] = [];
  readonly alertas: AlertaNomina[] = [];
  readonly pendientes: ResultadoNomina['pendientes'] = [];
  private readonly valoresConcepto = new Map<string, Decimal>();
  private ini!: Fecha;
  private fin!: Fecha;
  private retencionInfo?: ResultadoNomina['retencion'];
  private readonly diasInfo: Record<string, number> = {};
  private readonly basesInfo: Record<string, string> = {};

  constructor(
    private readonly e: EntradaNomina,
    private readonly ctx: ContextoNomina,
  ) {}

  private param(codigo: string, fecha: Fecha = this.fin): Decimal {
    const v = this.ctx.parametros.valor(codigo, fecha);
    if (v === undefined) throw new FormulaError(`Falta el parámetro ${codigo}`);
    return v;
  }

  private paramOr(codigo: string, def: Num, fecha: Fecha = this.fin): Decimal {
    return this.ctx.parametros.valor(codigo, fecha) ?? D(def);
  }

  private set(nombre: string, v: Decimal) {
    this.vars.set(normalizarId(nombre), v);
  }

  private contexto(fecha: Fecha, extra?: Map<string, Decimal>) {
    return {
      variable: (n: string) => {
        if (extra?.has(n)) return extra.get(n);
        if (this.vars.has(n)) return this.vars.get(n);
        return this.ctx.parametros.valor(n, fecha);
      },
      tabla: (codigo: string, valor: Decimal, col?: string) => this.ctx.tablas.buscar(codigo, valor, col),
    };
  }

  private valoresUsados(formula: string, fecha: Fecha, extra?: Map<string, Decimal>): Record<string, string> {
    const c = this.contexto(fecha, extra);
    const out: Record<string, string> = {};
    for (const v of variablesDe(formula)) {
      const x = c.variable(v);
      if (x !== undefined) out[v] = S(x);
    }
    return out;
  }

  ejecutar(): ResultadoNomina | null {
    const { periodo, contrato } = this.e;
    this.ini = maxFecha(periodo.desde, contrato.fechaInicio);
    this.fin = contrato.fechaFin ? minFecha(periodo.hasta, contrato.fechaFin) : periodo.hasta;
    if (this.fin < this.ini) return null;

    this.prepararVariables();
    const validos = this.conceptosValidos();
    const devengos = validos.filter((c) => c.tipo === 'devengo');
    const deduccionesLey = validos.filter((c) => c.tipo === 'deduccion' && c.categoria === 'ley');
    const resto = validos.filter((c) => !(c.tipo === 'devengo') && !(c.tipo === 'deduccion' && c.categoria === 'ley'));

    for (const c of this.ordenar(devengos)) this.evaluarConcepto(c);
    this.calcularBases();
    for (const c of this.ordenar(deduccionesLey)) this.evaluarConcepto(c);
    this.calcularRetencion();
    const solicitadas: { c: ConceptoNomina; valor: Decimal; detalle: DetalleCalculo }[] = [];
    for (const c of this.ordenar(resto)) {
      if (c.tipo === 'deduccion' && c.categoria !== 'retencion') {
        const r = this.calcularFormula(c);
        if (r) solicitadas.push({ c, ...r });
        this.valoresConcepto.set(normalizarId(c.codigo), r?.valor ?? ZERO);
        this.set(c.codigo, r?.valor ?? ZERO);
      } else this.evaluarConcepto(c);
    }
    this.aplicarDescuentosConLimites(solicitadas);
    return this.resultado();
  }

  /** Descarta (con alerta) los conceptos cuya fórmula no se puede leer. */
  private conceptosValidos(): ConceptoNomina[] {
    return this.ctx.conceptos.filter((c) => {
      try {
        parsearFormula(c.formula);
        return true;
      } catch (err) {
        this.alertas.push({ nivel: 'error', mensaje: `Fórmula inválida en ${c.nombre}: ${(err as Error).message}` });
        this.set(c.codigo, ZERO);
        return false;
      }
    });
  }

  /** Orden por dependencias; si hay una referencia circular se avisa y se usa el orden configurado. */
  private ordenar(lista: ConceptoNomina[]): ConceptoNomina[] {
    try {
      return ordenarPorDependencias(lista);
    } catch (err) {
      this.alertas.push({ nivel: 'error', mensaje: (err as Error).message });
      for (const c of lista) if (!this.vars.has(normalizarId(c.codigo))) this.set(c.codigo, ZERO);
      return [...lista].sort((a, b) => a.orden - b.orden);
    }
  }

  // ---------- Variables ----------

  private prepararVariables() {
    const { contrato, empleado } = this.e;
    const fin = this.fin;
    const diasMes = this.param('DIAS_MES');
    const smmlv = this.param('SMMLV');
    this.set('DIAS_MES', diasMes);

    const esIntegral = !!contrato.salarioIntegral || contrato.tipo === 'integral';
    const esAprendiz = contrato.tipo === 'aprendizaje';
    const fase = contrato.faseAprendiz ?? 'lectiva';
    const lectiva = esAprendiz && fase === 'lectiva';
    this.set('ES_INTEGRAL', bool(esIntegral));
    this.set('ES_APRENDIZ', bool(esAprendiz));
    this.set('ES_APRENDIZ_LECTIVA', bool(lectiva));
    this.set('ES_PENSIONADO', bool(!!empleado.esPensionado));
    this.set('CLASE_RIESGO', D(empleado.claseRiesgo ?? 1));
    this.set('APORTES_VOLUNTARIOS', D(empleado.aportesVoluntarios ?? 0));

    const ingreso = empleado.fechaIngreso ?? contrato.fechaInicio;
    const antDias = diasComerciales(ingreso, fin);
    this.set('ANTIGUEDAD_DIAS', D(antDias));
    this.set('ANTIGUEDAD_ANOS', D(antDias).div(360).toDecimalPlaces(4, Decimal.ROUND_DOWN));
    for (const [k, v] of Object.entries(empleado.variables ?? {})) this.set(k, D(v));

    const salario = this.salarioEn(fin);
    this.set('SALARIO', salario);
    this.set('SALARIO_DIARIO', salario.div(diasMes));

    const aux = contrato.auxilioTransporte ?? 'ley';
    this.set('TIENE_AUXILIO', bool(aux !== 'nunca' && !esIntegral && !lectiva));
    if (aux === 'siempre') this.set('TOPE_AUX_TRANSPORTE_SMMLV', D(1e9));

    const umbralExonera = this.param('EXONERACION_TOPE_SMMLV').mul(smmlv);
    this.set('EXONERADO', bool(this.ctx.empresa.exonerada && !esIntegral && salario.lt(umbralExonera)));

    // Días del periodo y novedades
    const diasPeriodo = diasComerciales(this.ini, fin);
    const nov = this.e.novedadesDias ?? [];
    const diasDe = (tipos: TipoNovedadDias[], desde = this.ini, hasta = fin) =>
      nov.filter((n) => tipos.includes(n.tipo)).reduce((a, n) => a + diasComerciales(maxFecha(n.desde, desde), minFecha(n.hasta, hasta)), 0);
    const TIPOS_NO_SALARIO: TipoNovedadDias[] = [
      'incapacidad_eg',
      'incapacidad_laboral',
      'licencia_maternidad',
      'licencia_paternidad',
      'licencia_no_remunerada',
      'suspension',
      'ausencia_injustificada',
      'vacaciones',
    ];
    const dIncap = diasDe(['incapacidad_eg', 'incapacidad_laboral']);
    const dVac = diasDe(['vacaciones']);
    const dEps = diasDe(['licencia_maternidad', 'licencia_paternidad']);
    let dNoRem = diasDe(['licencia_no_remunerada', 'suspension', 'ausencia_injustificada']);
    // Pérdida del dominical por ausencia injustificada (CST art. 173), si está configurado.
    if (this.paramOr('AUSENCIA_PIERDE_DOMINICAL', 0).eq(1)) {
      const semanas = new Set<string>();
      for (const n of nov.filter((x) => x.tipo === 'ausencia_injustificada'))
        for (const f of rango(maxFecha(n.desde, this.ini), minFecha(n.hasta, fin))) semanas.add(sumarDias(f, -((diaSemana(f) + 6) % 7)));
      dNoRem += semanas.size;
    }
    const noPagados = Math.min(diasPeriodo, diasDe(TIPOS_NO_SALARIO) + (dNoRem - diasDe(['licencia_no_remunerada', 'suspension', 'ausencia_injustificada'])));
    const diasSalario = Math.max(0, diasPeriodo - noPagados);
    this.set('DIAS_PERIODO', D(diasPeriodo));
    this.set('DIAS_SALARIO', D(diasSalario));
    this.set('DIAS_INCAPACIDAD', D(dIncap));
    this.set('DIAS_VACACIONES', D(dVac));
    this.set('DIAS_LICENCIA_EPS', D(dEps));
    this.set('DIAS_LICENCIA_NO_REMUNERADA', D(dNoRem));
    const diasAux =
      diasSalario + (this.paramOr('PAGA_AUX_EN_VACACIONES', 0).eq(1) ? dVac : 0) + (this.paramOr('PAGA_AUX_EN_INCAPACIDAD', 0).eq(1) ? dIncap : 0);
    this.set('DIAS_AUXILIO', D(Math.min(diasAux, diasPeriodo)));
    const diasCot = Math.max(0, diasPeriodo - dNoRem);
    this.set('DIAS_COTIZADOS', D(diasCot));
    Object.assign(this.diasInfo, {
      periodo: diasPeriodo,
      salario: diasSalario,
      incapacidad: dIncap,
      vacaciones: dVac,
      licenciaEps: dEps,
      noRemunerados: dNoRem,
      cotizados: diasCot,
    });

    // Sueldo proporcional por tramos de salario
    this.set('SUELDO_PROPORCIONAL', this.sueldoProporcional(TIPOS_NO_SALARIO));

    // Horas
    const horasMes = this.param('HORAS_SEMANALES').mul(diasMes).div(7);
    this.set('HORAS_MES', horasMes);
    this.set('VALOR_HORA', salario.div(horasMes));
    for (const t of TIPOS_HORA) this.set(`HORAS_${t}`, this.horasDe(t, this.ini, fin));

    // Incapacidades, licencias y vacaciones
    this.valorarIncapacidades();
    const baseDiaria = salario.div(diasMes);
    this.set('VALOR_LICENCIA_EPS', baseDiaria.mul(dEps).mul(this.param('PCT_LICENCIA_EPS')));
    const baseVac = this.e.baseVacaciones !== undefined ? D(this.e.baseVacaciones) : salario;
    this.set('BASE_VACACIONES', baseVac);
    this.set('VALOR_VACACIONES', baseVac.div(diasMes).mul(dVac));
    this.set('VALOR_NOVEDAD', ZERO);
    this.set('CANTIDAD_NOVEDAD', ZERO);
    this.set('VALOR_ASIGNADO', ZERO);

    if (!esIntegral && !esAprendiz && contrato.tipo !== 'tiempo_parcial' && salario.lt(smmlv))
      this.alertas.push({ nivel: 'advertencia', mensaje: `El salario (${S(salario)}) es menor que el salario mínimo (${S(smmlv)})` });
    if (esIntegral && salario.lt(this.param('INTEGRAL_MIN_SMMLV').mul(smmlv).mul(D(1).plus(this.param('INTEGRAL_FACTOR_MIN')))))
      this.alertas.push({ nivel: 'advertencia', mensaje: 'El salario integral es menor al mínimo legal configurado' });
  }

  /** Salario vigente en una fecha; para aprendices, el apoyo según la fase. */
  private salarioEn(f: Fecha): Decimal {
    const { contrato } = this.e;
    const base = contrato.historialSalario.length ? salarioEn(contrato.historialSalario, f) : ZERO;
    if (contrato.tipo !== 'aprendizaje') return base;
    const smmlv = this.param('SMMLV', f);
    const fase = contrato.faseAprendiz ?? 'lectiva';
    const pct =
      fase === 'universitario'
        ? this.param('APRENDIZ_PCT_UNIVERSITARIO', f)
        : fase === 'lectiva' || fase === 'dual_1'
          ? this.param('APRENDIZ_PCT_LECTIVA', f)
          : this.param('APRENDIZ_PCT_PRACTICA', f);
    return Decimal.max(base, smmlv.mul(pct));
  }

  private tramosSalario(): Tramo[] {
    const cortes = new Set<Fecha>([this.ini]);
    for (const c of this.e.contrato.historialSalario) if (c.desde > this.ini && c.desde <= this.fin) cortes.add(c.desde);
    return this.tramos(cortes);
  }

  private tramos(cortes: Set<Fecha>): Tramo[] {
    const lista = [...cortes].sort();
    return lista.map((d, i) => ({ desde: d, hasta: i + 1 < lista.length ? sumarDias(lista[i + 1], -1) : this.fin }));
  }

  private sueldoProporcional(tiposNoSalario: TipoNovedadDias[]): Decimal {
    const diasMes = this.param('DIAS_MES');
    const nov = this.e.novedadesDias ?? [];
    let total = ZERO;
    const diasPeriodo = diasComerciales(this.ini, this.fin);
    let diasAcum = 0;
    for (const t of this.tramosSalario()) {
      const dTramo = diasComerciales(t.desde, t.hasta);
      const noPag = nov
        .filter((n) => tiposNoSalario.includes(n.tipo))
        .reduce((a, n) => a + diasComerciales(maxFecha(n.desde, t.desde), minFecha(n.hasta, t.hasta)), 0);
      let dias = Math.max(0, dTramo - noPag);
      // Nunca más días que los del periodo (ajuste por meses de 31 días).
      dias = Math.min(dias, diasPeriodo - diasAcum);
      diasAcum += dias;
      total = total.plus(this.salarioEn(t.desde).div(diasMes).mul(dias));
    }
    return total;
  }

  private horasDe(tipo: TipoHora, desde: Fecha, hasta: Fecha): Decimal {
    const deAsistencia = (this.e.horas ?? []).filter((h) => h.tipo === tipo && h.fecha >= desde && h.fecha <= hasta).map((h) => h.horas);
    // Horas digitadas como novedad del concepto de ese tipo de hora.
    const digitadas = (this.e.novedadesValor ?? [])
      .filter((n) => normalizarId(n.concepto) === tipo && (!n.fecha || (n.fecha >= desde && n.fecha <= hasta)))
      .map((n) => n.cantidad ?? 0);
    return sum([...deAsistencia, ...digitadas]);
  }

  private valorarIncapacidades() {
    const nov = this.e.novedadesDias ?? [];
    const smmlvDia = this.param('SMMLV').div(this.param('DIAS_MES'));
    const baseMensual = this.e.ibcMesAnterior !== undefined ? D(this.e.ibcMesAnterior) : this.vars.get('SALARIO')!;
    const baseDia = baseMensual.div(this.param('DIAS_MES'));
    const minimo = this.paramOr('INCAP_MIN_SMMLV', 1).eq(1);
    const completa = this.paramOr('EMPRESA_COMPLETA_INCAPACIDAD', 0).eq(1);
    const totales = { empleador: ZERO, eps: ZERO, afp: ZERO, arl: ZERO, complemento: ZERO };
    for (const n of nov) {
      if (n.tipo !== 'incapacidad_eg' && n.tipo !== 'incapacidad_laboral') continue;
      const desde = maxFecha(n.desde, this.ini);
      const hasta = minFecha(n.hasta, this.fin);
      const dias = diasComerciales(desde, hasta);
      if (dias <= 0) continue;
      const offset = (n.diasPrevios ?? 0) + (desde > n.desde ? diasComerciales(n.desde, sumarDias(desde, -1)) : 0);
      for (let k = 1; k <= dias; k++) {
        const dia = offset + k;
        if (n.tipo === 'incapacidad_laboral') {
          const v = baseDia.mul(this.param('PCT_INCAP_LABORAL'));
          totales.arl = totales.arl.plus(v);
          if (completa) totales.complemento = totales.complemento.plus(Decimal.max(baseDia.minus(v), ZERO));
          continue;
        }
        const pct = this.ctx.tablas.buscar('INCAPACIDAD_EG', D(dia), 'pct');
        const pagador = this.ctx.tablas.buscar('INCAPACIDAD_EG', D(dia), 'pagador').toNumber();
        let v = baseDia.mul(pct);
        if (minimo && v.lt(smmlvDia)) v = smmlvDia;
        if (pagador === 1) totales.empleador = totales.empleador.plus(v);
        else if (pagador === 3) totales.afp = totales.afp.plus(v);
        else totales.eps = totales.eps.plus(v);
        if (completa) totales.complemento = totales.complemento.plus(Decimal.max(baseDia.minus(v), ZERO));
      }
    }
    this.set('VALOR_INCAP_EMPLEADOR', totales.empleador);
    this.set('VALOR_INCAP_EPS', totales.eps);
    this.set('VALOR_INCAP_AFP', totales.afp);
    this.set('VALOR_INCAP_ARL', totales.arl);
    this.set('VALOR_COMPLEMENTO_INCAP', totales.complemento);
  }

  // ---------- Conceptos ----------

  private novedadesDe(codigo: string): NovedadValor[] {
    return (this.e.novedadesValor ?? []).filter(
      (n) => normalizarId(n.concepto) === normalizarId(codigo) && (!n.fecha || (n.fecha >= this.ini && n.fecha <= this.fin)),
    );
  }

  private calcularFormula(c: ConceptoNomina): { valor: Decimal; detalle: DetalleCalculo; cantidad?: Decimal } | null {
    const novs = this.novedadesDe(c.codigo);
    if (c.requiereNovedad && novs.length === 0) return null;
    const extra = new Map<string, Decimal>([
      ['VALOR_NOVEDAD', sum(novs.map((n) => n.valor ?? 0))],
      ['CANTIDAD_NOVEDAD', sum(novs.map((n) => n.cantidad ?? 0))],
      ['VALOR_ASIGNADO', D(this.e.valoresAsignados?.[normalizarId(c.codigo)] ?? 0)],
    ]);
    try {
      parsearFormula(c.formula);
    } catch (err) {
      this.alertas.push({ nivel: 'error', mensaje: `Fórmula inválida en ${c.nombre}: ${(err as Error).message}` });
      return null;
    }
    const modo: ModoRedondeo = c.redondeo ?? 'peso';
    try {
      if (c.porHoras) return this.calcularPorTramos(c, extra, modo);
      const crudo = evaluar(c.formula, this.contexto(this.fin, extra));
      const valor = redondear(crudo, modo);
      const tipoHora = TIPOS_HORA.find((t) => t === normalizarId(c.codigo));
      return {
        valor,
        cantidad: tipoHora ? this.vars.get(`HORAS_${tipoHora}`) : extra.get('CANTIDAD_NOVEDAD')!.isZero() ? undefined : extra.get('CANTIDAD_NOVEDAD'),
        detalle: { formula: c.formula, variables: this.valoresUsados(c.formula, this.fin, extra), sinRedondear: S(crudo) },
      };
    } catch (err) {
      this.alertas.push({ nivel: 'error', mensaje: `No se pudo calcular ${c.nombre}: ${(err as Error).message}` });
      return null;
    }
  }

  /** Conceptos de horas: se evalúan por tramos de vigencia de parámetros y salario (HU-07). */
  private calcularPorTramos(c: ConceptoNomina, extra: Map<string, Decimal>, modo: ModoRedondeo) {
    const cortes = new Set<Fecha>([this.ini, ...this.ctx.parametros.cambiosEntre(this.ini, this.fin)]);
    for (const s of this.e.contrato.historialSalario) if (s.desde > this.ini && s.desde <= this.fin) cortes.add(s.desde);
    const tramos = this.tramos(cortes);
    let total = ZERO;
    let horasTotal = ZERO;
    const detTramos: NonNullable<DetalleCalculo['tramos']> = [];
    for (const t of tramos) {
      const local = new Map(extra);
      const salario = this.salarioEn(t.desde);
      const horasMes = this.param('HORAS_SEMANALES', t.desde).mul(this.param('DIAS_MES', t.desde)).div(7);
      local.set('SALARIO', salario);
      local.set('HORAS_MES', horasMes);
      local.set('VALOR_HORA', salario.div(horasMes));
      let tieneHoras = false;
      for (const th of TIPOS_HORA) {
        const h = this.horasDe(th, t.desde, t.hasta);
        local.set(`HORAS_${th}`, h);
        if (!h.isZero() && th === normalizarId(c.codigo)) tieneHoras = true;
      }
      const v = evaluar(c.formula, this.contexto(t.desde, local));
      if (tramos.length === 1 || !v.isZero() || tieneHoras)
        detTramos.push({ desde: t.desde, hasta: t.hasta, valor: S(v), variables: this.valoresUsados(c.formula, t.desde, local) });
      total = total.plus(v);
      const th = TIPOS_HORA.find((x) => x === normalizarId(c.codigo));
      if (th) horasTotal = horasTotal.plus(local.get(`HORAS_${th}`)!);
    }
    return {
      valor: redondear(total, modo),
      cantidad: horasTotal.isZero() ? undefined : horasTotal,
      detalle: { formula: c.formula, sinRedondear: S(total), tramos: detTramos, variables: detTramos.length === 1 ? detTramos[0].variables : undefined },
    };
  }

  private evaluarConcepto(c: ConceptoNomina) {
    const r = this.calcularFormula(c);
    const valor = r?.valor ?? ZERO;
    this.valoresConcepto.set(normalizarId(c.codigo), valor);
    this.set(c.codigo, valor);
    if (r && !valor.isZero()) this.agregarLinea(c, valor, r.detalle, r.cantidad);
  }

  private agregarLinea(c: ConceptoNomina, valor: Decimal, detalle: DetalleCalculo, cantidad?: Decimal, referencia?: string, nombre?: string) {
    this.lineas.push({
      concepto: c.codigo,
      nombre: nombre ?? c.nombre,
      tipo: c.tipo,
      categoria: c.categoria,
      cantidad: cantidad ? S(cantidad) : undefined,
      valor: S(valor),
      detalle,
      referencia,
    });
  }

  private sumaDevengos(pred: (c: ConceptoNomina) => boolean): Decimal {
    return sum(this.ctx.conceptos.filter((c) => c.tipo === 'devengo' && pred(c)).map((c) => this.valoresConcepto.get(normalizarId(c.codigo)) ?? ZERO));
  }

  // ---------- Bases: IBC (regla del 40%) y prestaciones ----------

  private calcularBases() {
    const smmlv = this.param('SMMLV');
    const diasMes = this.param('DIAS_MES');
    const esIntegral = this.vars.get('ES_INTEGRAL')!.eq(1);
    const lectiva = this.vars.get('ES_APRENDIZ_LECTIVA')!.eq(1);
    const pctIntegral = this.param('PCT_IBC_INTEGRAL');
    const factorInt = (pred: (c: ConceptoNomina) => boolean) =>
      esIntegral
        ? this.sumaDevengos((c) => pred(c) && c.salarial).mul(pctIntegral).plus(this.sumaDevengos((c) => pred(c) && !c.salarial))
        : this.sumaDevengos(pred);

    const totalDevengado = this.sumaDevengos(() => true);
    const salarial = this.sumaDevengos((c) => c.salarial);
    const noSalarial = this.sumaDevengos((c) => !c.salarial && c.cuenta40);
    const limite = salarial.plus(noSalarial).mul(this.param('PCT_LIMITE_NO_SALARIAL'));
    const exceso = Decimal.max(noSalarial.minus(limite), ZERO);
    this.set('TOTAL_DEVENGADO', totalDevengado);
    this.set('TOTAL_SALARIAL', salarial);
    this.set('TOTAL_NO_SALARIAL', noSalarial);

    const diasCot = this.vars.get('DIAS_COTIZADOS')!;
    const minIbc = this.param('IBC_MIN_SMMLV').mul(smmlv).div(diasMes).mul(diasCot);
    const maxIbc = this.param('IBC_MAX_SMMLV').mul(smmlv).div(diasMes).mul(Decimal.max(diasCot, D(1)));
    const ajustar = (v: Decimal, nombre: string) => {
      let r = v;
      if (diasCot.gt(0) && r.lt(minIbc) && !this.esTiempoParcial()) {
        if (!r.isZero()) this.alertas.push({ nivel: 'info', mensaje: `El ${nombre} se ajustó al mínimo (${S(redondear(minIbc))})` });
        r = minIbc;
      }
      if (r.gt(maxIbc)) {
        this.alertas.push({ nivel: 'info', mensaje: `El ${nombre} se ajustó al máximo (${S(redondear(maxIbc))})` });
        r = maxIbc;
      }
      return redondear(r, 'peso_arriba');
    };

    let ibc = factorInt((c) => c.baseIbc).plus(exceso);
    let ibcArl = factorInt((c) => c.baseArl).plus(exceso);
    let ibcPara = factorInt((c) => c.baseParafiscales).plus(exceso);
    if (lectiva) {
      const pror = smmlv.div(diasMes).mul(this.vars.get('DIAS_PERIODO')!);
      ibc = pror;
      ibcArl = pror;
      ibcPara = ZERO;
    }
    ibc = ajustar(ibc, 'IBC');
    ibcArl = Decimal.min(ajustar(ibcArl, 'IBC de ARL'), ibc);
    ibcPara = redondear(Decimal.min(ibcPara, ibc), 'peso_arriba');
    this.set('IBC_SALUD', ibc);
    this.set('IBC_PENSION', ibc);
    this.set('IBC_ARL', ibcArl);
    this.set('IBC_PARAFISCALES', ibcPara);
    this.set('IBC_MENSUAL', diasCot.isZero() ? ZERO : ibc.div(diasCot).mul(diasMes));

    const sinPrestaciones = esIntegral || lectiva;
    const basePrest = sinPrestaciones ? ZERO : this.sumaDevengos((c) => c.basePrestaciones);
    const baseVacProv = lectiva ? ZERO : this.sumaDevengos((c) => c.baseVacaciones);
    this.set('BASE_PRESTACIONES', basePrest);
    this.set('BASE_VACACIONES_PROV', baseVacProv);

    Object.assign(this.basesInfo, {
      totalDevengado: S(totalDevengado),
      salarial: S(salarial),
      noSalarial: S(noSalarial),
      limiteNoSalarial: S(limite),
      excesoNoSalarial: S(exceso),
      ibcSalud: S(ibc),
      ibcPension: S(ibc),
      ibcArl: S(ibcArl),
      ibcParafiscales: S(ibcPara),
      basePrestaciones: S(basePrest),
      baseVacaciones: S(baseVacProv),
    });
  }

  private esTiempoParcial() {
    return this.e.contrato.tipo === 'tiempo_parcial';
  }

  // ---------- Retención en la fuente ----------

  private calcularRetencion() {
    const { empleado, periodo } = this.e;
    const cierra = periodo.cierraMes ?? periodo.hasta === finDeMes(periodo.hasta);
    const soloCierre = this.paramOr('RETENCION_SOLO_CIERRE_MES', 1).eq(1);
    const esIntegral = this.vars.get('ES_INTEGRAL')!.eq(1);
    let gravable = this.sumaDevengos((c) => c.baseRetencion);
    if (esIntegral) {
      // El factor prestacional del salario integral está exento (CST art. 132).
      const factor = D(this.e.contrato.factorPrestacional ?? this.param('INTEGRAL_FACTOR_MIN'));
      const integral = this.sumaDevengos((c) => c.baseRetencion && c.salarial);
      gravable = gravable.minus(integral).plus(integral.div(D(1).plus(factor)));
    }
    const ley = sum(this.lineas.filter((l) => l.tipo === 'deduccion' && l.categoria === 'ley').map((l) => l.valor));
    this.basesInfo.baseRetencionPeriodo = S(gravable);
    this.basesInfo.noConstitutivosPeriodo = S(ley);

    if (soloCierre && !cierra) {
      this.set('RETENCION_CALCULADA', ZERO);
      return;
    }
    const acum = this.e.acumuladoMes;
    const ingresos = gravable.plus(D(acum?.ingresosRetencion ?? 0));
    const incr = ley.plus(D(acum?.noConstitutivos ?? 0));
    const uvt = this.param('UVT');
    const p: ParamsRetencion = {
      uvt,
      pctRentaExenta: this.param('RET_PCT_EXENTA'),
      topeRentaExentaUvtAnual: this.param('RET_TOPE_EXENTA_UVT_ANUAL'),
      pctLimiteGlobal: this.param('RET_LIMITE_PCT'),
      topeLimiteGlobalUvtAnual: this.param('RET_LIMITE_UVT_ANUAL'),
      pctDependientes: this.param('RET_DEPENDIENTES_PCT'),
      topeDependientesUvtMes: this.param('RET_DEPENDIENTES_TOPE_UVT'),
      topeInteresesViviendaUvtMes: this.param('RET_VIVIENDA_TOPE_UVT'),
      topeMedicinaPrepagadaUvtMes: this.param('RET_PREPAGADA_TOPE_UVT'),
      uvtDependienteAdicionalAnual: this.param('RET_DEP_ADICIONAL_UVT_ANUAL'),
      maxDependientesAdicionales: 4,
      tabla: this.tablaRetencion(),
      redondeo: 'mil',
    };
    const r = calcularRetencion(
      {
        ingresosLaborales: ingresos,
        ingresosNoConstitutivos: incr,
        tieneDependiente: empleado.tieneDependiente,
        dependientesAdicionales: empleado.dependientesAdicionales,
        interesesVivienda: empleado.interesesVivienda,
        medicinaPrepagada: empleado.medicinaPrepagada,
        aportesVoluntarios: empleado.aportesVoluntarios,
        procedimiento: empleado.procedimientoRetencion ?? 1,
        porcentajeFijo: empleado.porcentajeProcedimiento2,
      },
      p,
    );
    const valor = Decimal.max(r.retencion.minus(D(acum?.retencionPracticada ?? 0)), ZERO);
    this.set('RETENCION_CALCULADA', valor);
    this.retencionInfo = {
      baseGravable: S(r.baseGravable),
      pasos: r.pasos.map((x) => ({ concepto: x.concepto, valor: S(x.valor.toDecimalPlaces(2)), uvt: S(x.uvt.toDecimalPlaces(2)) })),
    };
  }

  private tablaRetencion(): FilaTablaRetencion[] {
    const filas = this.ctx.tablas.filas('RETENCION_383');
    if (!filas) return [];
    return filas.map((f) => ({
      desdeUvt: f.desde,
      hastaUvt: f.hasta,
      tarifa: f.valores['tarifa'] ?? ZERO,
      restaUvt: f.valores['resta_uvt'] ?? ZERO,
      sumaUvt: f.valores['suma_uvt'] ?? ZERO,
    }));
  }

  // ---------- Descuentos con límites ----------

  private aplicarDescuentosConLimites(solicitadas: { c: ConceptoNomina; valor: Decimal; detalle: DetalleCalculo }[]) {
    const devengos = sum(this.lineas.filter((l) => l.tipo === 'devengo').map((l) => l.valor));
    const ley = sum(this.lineas.filter((l) => l.tipo === 'deduccion').map((l) => l.valor)); // ley + retención ya aplicadas
    let disponible = devengos.minus(ley);
    if (disponible.lt(0)) this.alertas.push({ nivel: 'error', mensaje: 'Los descuentos de ley superan lo devengado' });

    const smmlv = this.param('SMMLV');
    const diasMes = this.param('DIAS_MES');
    const salariales = this.sumaDevengos((c) => c.salarial);
    const smmlvPeriodo = smmlv.div(diasMes).mul(this.vars.get('DIAS_PERIODO')!);
    const protegerMinimo = this.paramOr('PROTEGER_MINIMO', 1).eq(1);
    const minimoProtegido = protegerMinimo
      ? Decimal.min(smmlv.div(diasMes).mul(this.vars.get('DIAS_SALARIO')!), devengos)
      : ZERO;
    let maxOrdinario = Decimal.max(salariales.minus(smmlvPeriodo), ZERO).mul(this.param('EMBARGO_FRACCION_EXCEDENTE'));
    let maxAlimentos = Decimal.max(salariales.minus(ley), ZERO).mul(this.param('EMBARGO_PCT_ALIMENTOS'));
    const conceptoBase = (codigo: string, nombre: string, categoria: CategoriaDeduccion): ConceptoNomina =>
      this.ctx.conceptos.find((c) => normalizarId(c.codigo) === codigo) ?? {
        codigo,
        nombre,
        tipo: 'deduccion',
        categoria,
        formula: '0',
        salarial: false,
        baseIbc: false,
        baseArl: false,
        baseParafiscales: false,
        basePrestaciones: false,
        baseVacaciones: false,
        baseRetencion: false,
        cuenta40: false,
        orden: 150,
        esLegal: false,
      };

    const aplicar = (pedido: Decimal, limite: Decimal | null, protege: boolean) => {
      let v = Decimal.max(pedido, ZERO);
      if (limite) v = Decimal.min(v, limite);
      const tope = protege ? Decimal.max(disponible.minus(minimoProtegido), ZERO) : Decimal.max(disponible, ZERO);
      v = Decimal.min(v, tope);
      return redondear(v, 'peso');
    };
    const pendiente = (referencia: string, descripcion: string, pedido: Decimal, aplicado: Decimal) => {
      if (aplicado.lt(pedido))
        this.pendientes.push({ referencia, descripcion, noAplicado: S(redondear(pedido.minus(aplicado))) });
    };

    // 1. Embargos: alimentos y cooperativas primero, luego ordinarios (prioridad configurable).
    const embargos = [...(this.e.embargos ?? [])].sort((a, b) => {
      const pa = a.prioridad ?? (a.tipo === 'ordinario' ? 2 : 1);
      const pb = b.prioridad ?? (b.tipo === 'ordinario' ? 2 : 1);
      return pa - pb;
    });
    for (const em of embargos) {
      const esOrd = em.tipo === 'ordinario';
      const maximo = esOrd ? maxOrdinario : maxAlimentos;
      let pedido = em.valorFijo !== undefined && em.valorFijo !== null ? D(em.valorFijo) : maximo.mul(D(em.porcentaje ?? 1));
      if (em.saldo !== undefined && em.saldo !== null) pedido = Decimal.min(pedido, D(em.saldo));
      const v = aplicar(pedido, maximo, false);
      if (esOrd) maxOrdinario = maxOrdinario.minus(v);
      else maxAlimentos = maxAlimentos.minus(v);
      disponible = disponible.minus(v);
      if (!v.isZero())
        this.agregarLinea(
          conceptoBase('EMBARGO', 'Embargo judicial', 'embargo'),
          v,
          { nota: `${em.descripcion}. Máximo embargable (${esOrd ? '1/5 del excedente del mínimo' : 'alimentos o cooperativas'}): ${S(redondear(maximo))}` },
          undefined,
          em.id,
          `Embargo: ${em.descripcion}`,
        );
      pendiente(em.id, `Embargo: ${em.descripcion}`, pedido, v);
    }

    // 2. Libranzas y préstamos.
    for (const p of [...(this.e.prestamos ?? [])].sort((a, b) => (a.tipo === b.tipo ? 0 : a.tipo === 'libranza' ? -1 : 1))) {
      const pedido = Decimal.min(D(p.cuota), D(p.saldo));
      if (pedido.lte(0)) continue;
      const v = aplicar(pedido, null, true);
      disponible = disponible.minus(v);
      const codigo = p.tipo === 'libranza' ? 'LIBRANZA' : 'PRESTAMO';
      if (!v.isZero())
        this.agregarLinea(
          conceptoBase(codigo, p.tipo === 'libranza' ? 'Libranza' : 'Préstamo', 'libranza'),
          v,
          { nota: `${p.descripcion}. Cuota ${S(D(p.cuota))}, saldo antes del descuento ${S(D(p.saldo))}` },
          undefined,
          p.id,
          `${p.tipo === 'libranza' ? 'Libranza' : 'Préstamo'}: ${p.descripcion}`,
        );
      pendiente(p.id, p.descripcion, pedido, v);
    }

    // 3. Otros descuentos por fórmula (embargos por fórmula primero).
    const orden: Record<string, number> = { embargo: 1, libranza: 2, otra: 3 };
    for (const s of [...solicitadas].sort((a, b) => (orden[a.c.categoria ?? 'otra'] ?? 3) - (orden[b.c.categoria ?? 'otra'] ?? 3))) {
      const v = aplicar(s.valor, null, s.c.categoria !== 'embargo');
      disponible = disponible.minus(v);
      this.valoresConcepto.set(normalizarId(s.c.codigo), v);
      if (!v.isZero()) this.agregarLinea(s.c, v, s.detalle);
      pendiente(s.c.codigo, s.c.nombre, s.valor, v);
    }
    if (this.pendientes.length)
      this.alertas.push({ nivel: 'advertencia', mensaje: `${this.pendientes.length} descuento(s) no se aplicaron completos por los límites legales o el neto disponible` });
  }

  private resultado(): ResultadoNomina {
    const t = (tipo: TipoConcepto) => sum(this.lineas.filter((l) => l.tipo === tipo).map((l) => l.valor));
    const devengos = t('devengo');
    const deducciones = t('deduccion');
    const aportes = t('aporte_empleador');
    const provisiones = t('provision');
    const orden = new Map(this.ctx.conceptos.map((c) => [c.codigo, c.orden]));
    this.lineas.sort((a, b) => (orden.get(a.concepto) ?? 150) - (orden.get(b.concepto) ?? 150));
    const neto = devengos.minus(deducciones);
    if (neto.lt(0)) this.alertas.push({ nivel: 'error', mensaje: `El neto a pagar es negativo (${S(neto)})` });
    return {
      empleadoId: this.e.empleado.id,
      desde: this.ini,
      hasta: this.fin,
      lineas: this.lineas,
      totales: {
        devengos: S(devengos),
        deducciones: S(deducciones),
        neto: S(neto),
        aportesEmpleador: S(aportes),
        provisiones: S(provisiones),
        costoTotal: S(devengos.plus(aportes).plus(provisiones)),
      },
      bases: this.basesInfo,
      dias: this.diasInfo,
      alertas: this.alertas,
      pendientes: this.pendientes,
      retencion: this.retencionInfo,
    };
  }
}

/** Liquida un empleado en un periodo. Devuelve null si el contrato no cubre el periodo. */
export function liquidarEmpleado(entrada: EntradaNomina, ctx: ContextoNomina): ResultadoNomina | null {
  return new Calculo(entrada, ctx).ejecutar();
}
