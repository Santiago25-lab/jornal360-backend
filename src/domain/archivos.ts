import { D, Num } from './decimal';

/**
 * Archivos de salida configurables: pago masivo a bancos (HU-57) y comprobante contable (HU-58).
 * Cada formato se define con campos (sin programar): de dónde sale el valor, ancho, relleno y alineación.
 */

export type FormatoValor = 'texto' | 'numero' | 'entero' | 'valor' | 'valor_centavos' | 'fecha_aaaammdd' | 'fecha_ddmmaaaa' | 'fecha_iso';

export interface CampoArchivo {
  nombre: string;
  /** Clave del dato (ej. 'empleado.documento', 'pago.valor', 'total.registros') o vacío si es literal. */
  fuente?: string;
  literal?: string;
  formato?: FormatoValor;
  ancho?: number;
  relleno?: string; // ' ' o '0'
  alineacion?: 'izquierda' | 'derecha';
}

export interface FormatoArchivo {
  codigo: string;
  nombre: string;
  /** null = ancho fijo; ',' ';' '|' '\t' = separado. */
  separador: string | null;
  extension: string;
  finLinea?: '\r\n' | '\n';
  incluirTitulos?: boolean;
  encabezado?: CampoArchivo[];
  detalle: CampoArchivo[];
  pie?: CampoArchivo[];
  nota?: string;
}

type Datos = Record<string, unknown>;

function leer(datos: Datos, ruta: string): unknown {
  return ruta.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Datos)[k] : undefined), datos);
}

function formatear(v: unknown, formato: FormatoValor = 'texto'): string {
  if (v === undefined || v === null) return '';
  switch (formato) {
    case 'numero':
      return D(v as Num).toFixed();
    case 'entero':
      return D(v as Num).toDecimalPlaces(0).toFixed(0);
    case 'valor':
      return D(v as Num).toFixed(2);
    case 'valor_centavos':
      return D(v as Num).mul(100).toDecimalPlaces(0).toFixed(0);
    case 'fecha_aaaammdd':
      return String(v).slice(0, 10).replace(/-/g, '');
    case 'fecha_ddmmaaaa': {
      const s = String(v).slice(0, 10);
      return `${s.slice(8, 10)}${s.slice(5, 7)}${s.slice(0, 4)}`;
    }
    case 'fecha_iso':
      return String(v).slice(0, 10);
    default:
      return String(v)
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[\r\n]+/g, ' ');
  }
}

function ajustar(s: string, c: CampoArchivo): string {
  if (!c.ancho) return s;
  const relleno = c.relleno ?? (c.alineacion === 'derecha' ? '0' : ' ');
  if (s.length > c.ancho) return c.alineacion === 'derecha' ? s.slice(s.length - c.ancho) : s.slice(0, c.ancho);
  return c.alineacion === 'derecha' ? s.padStart(c.ancho, relleno) : s.padEnd(c.ancho, relleno);
}

function linea(campos: CampoArchivo[], datos: Datos, separador: string | null): string {
  const valores = campos.map((c) => ajustar(c.literal !== undefined ? c.literal : formatear(leer(datos, c.fuente ?? ''), c.formato), c));
  if (separador === null) return valores.join('');
  return valores.map((x) => (x.includes(separador) || x.includes('"') ? `"${x.replace(/"/g, '""')}"` : x)).join(separador);
}

export function generarArchivo(f: FormatoArchivo, comunes: Datos, registros: Datos[]): string {
  const fin = f.finLinea ?? '\r\n';
  const out: string[] = [];
  if (f.incluirTitulos && f.separador !== null) out.push(f.detalle.map((c) => c.nombre).join(f.separador));
  if (f.encabezado?.length) out.push(linea(f.encabezado, comunes, f.separador));
  for (const r of registros) out.push(linea(f.detalle, { ...comunes, ...r }, f.separador));
  if (f.pie?.length) out.push(linea(f.pie, comunes, f.separador));
  return out.join(fin) + fin;
}

/** Valida que un formato tenga lo mínimo para generarse. */
export function validarFormato(f: FormatoArchivo): string[] {
  const e: string[] = [];
  if (!f.codigo) e.push('Falta el código');
  if (!f.detalle?.length) e.push('El formato necesita al menos un campo de detalle');
  for (const c of [...(f.encabezado ?? []), ...f.detalle, ...(f.pie ?? [])]) {
    if (!c.fuente && c.literal === undefined) e.push(`El campo ${c.nombre} no tiene fuente ni valor fijo`);
    if (f.separador === null && !c.ancho) e.push(`El campo ${c.nombre} necesita ancho en un archivo de ancho fijo`);
  }
  return e;
}

const NOTA_BANCO =
  'Plantilla base. Antes de usarla en producción, valídela contra la especificación oficial de archivos de pago que entrega el banco a la empresa y ajuste los campos desde el panel.';

/** Plantillas iniciales de bancos (editables). */
export const FORMATOS_BANCO: FormatoArchivo[] = [
  {
    codigo: 'BANCOLOMBIA',
    nombre: 'Bancolombia - pago masivo de nómina',
    separador: null,
    extension: 'txt',
    nota: NOTA_BANCO,
    encabezado: [
      { nombre: 'Tipo registro', literal: '1', ancho: 1 },
      { nombre: 'NIT pagador', fuente: 'empresa.nit', ancho: 15, alineacion: 'derecha', relleno: '0' },
      { nombre: 'Aplicación', literal: 'I', ancho: 1 },
      { nombre: 'Filler', literal: '', ancho: 15 },
      { nombre: 'Clase transacción', literal: '225', ancho: 3 },
      { nombre: 'Descripción', literal: 'NOMINA', ancho: 10 },
      { nombre: 'Fecha transmisión', fuente: 'fechaPago', formato: 'fecha_aaaammdd', ancho: 8 },
      { nombre: 'Secuencia', literal: 'A', ancho: 2 },
      { nombre: 'Fecha aplicación', fuente: 'fechaPago', formato: 'fecha_aaaammdd', ancho: 8 },
      { nombre: 'Número registros', fuente: 'total.registros', formato: 'entero', ancho: 6, alineacion: 'derecha', relleno: '0' },
      { nombre: 'Débitos', literal: '0', ancho: 17, alineacion: 'derecha', relleno: '0' },
      { nombre: 'Créditos', fuente: 'total.valor', formato: 'valor_centavos', ancho: 17, alineacion: 'derecha', relleno: '0' },
      { nombre: 'Cuenta débito', fuente: 'empresa.cuenta', ancho: 11, alineacion: 'derecha', relleno: '0' },
      { nombre: 'Tipo cuenta débito', fuente: 'empresa.tipoCuentaCodigo', ancho: 1 },
    ],
    detalle: [
      { nombre: 'Tipo registro', literal: '6', ancho: 1 },
      { nombre: 'Documento beneficiario', fuente: 'empleado.documento', ancho: 15, alineacion: 'derecha', relleno: '0' },
      { nombre: 'Nombre beneficiario', fuente: 'empleado.nombre', ancho: 30 },
      { nombre: 'Banco destino', fuente: 'empleado.codigoBanco', ancho: 9, alineacion: 'derecha', relleno: '0' },
      { nombre: 'Cuenta destino', fuente: 'empleado.cuenta', ancho: 17, alineacion: 'derecha', relleno: '0' },
      { nombre: 'Indicador', literal: 'S', ancho: 1 },
      { nombre: 'Tipo transacción', fuente: 'empleado.tipoTransaccion', ancho: 2 },
      { nombre: 'Valor', fuente: 'pago.valor', formato: 'valor_centavos', ancho: 17, alineacion: 'derecha', relleno: '0' },
      { nombre: 'Fecha', fuente: 'fechaPago', formato: 'fecha_aaaammdd', ancho: 8 },
      { nombre: 'Referencia', fuente: 'pago.referencia', ancho: 21 },
    ],
  },
  {
    codigo: 'DAVIVIENDA',
    nombre: 'Davivienda - pago masivo de nómina',
    separador: null,
    extension: 'txt',
    nota: NOTA_BANCO,
    encabezado: [
      { nombre: 'Tipo registro', literal: 'RC', ancho: 2 },
      { nombre: 'NIT empresa', fuente: 'empresa.nit', ancho: 16, alineacion: 'derecha', relleno: '0' },
      { nombre: 'Código servicio', literal: 'NOMI', ancho: 4 },
      { nombre: 'Cuenta empresa', fuente: 'empresa.cuenta', ancho: 16, alineacion: 'derecha', relleno: '0' },
      { nombre: 'Tipo cuenta', fuente: 'empresa.tipoCuentaCodigo', ancho: 2 },
      { nombre: 'Fecha', fuente: 'fechaPago', formato: 'fecha_aaaammdd', ancho: 8 },
      { nombre: 'Valor total', fuente: 'total.valor', formato: 'valor_centavos', ancho: 18, alineacion: 'derecha', relleno: '0' },
      { nombre: 'Registros', fuente: 'total.registros', formato: 'entero', ancho: 6, alineacion: 'derecha', relleno: '0' },
    ],
    detalle: [
      { nombre: 'Tipo registro', literal: 'TR', ancho: 2 },
      { nombre: 'Documento', fuente: 'empleado.documento', ancho: 16, alineacion: 'derecha', relleno: '0' },
      { nombre: 'Tipo documento', fuente: 'empleado.tipoDocumentoCodigo', ancho: 2 },
      { nombre: 'Cuenta', fuente: 'empleado.cuenta', ancho: 16, alineacion: 'derecha', relleno: '0' },
      { nombre: 'Tipo cuenta', fuente: 'empleado.tipoCuentaCodigo', ancho: 2 },
      { nombre: 'Banco', fuente: 'empleado.codigoBanco', ancho: 6, alineacion: 'derecha', relleno: '0' },
      { nombre: 'Valor', fuente: 'pago.valor', formato: 'valor_centavos', ancho: 18, alineacion: 'derecha', relleno: '0' },
      { nombre: 'Nombre', fuente: 'empleado.nombre', ancho: 40 },
    ],
  },
  {
    codigo: 'BANCO_BOGOTA',
    nombre: 'Banco de Bogotá - pago masivo de nómina',
    separador: null,
    extension: 'txt',
    nota: NOTA_BANCO,
    encabezado: [
      { nombre: 'Tipo registro', literal: '1', ancho: 1 },
      { nombre: 'Fecha', fuente: 'fechaPago', formato: 'fecha_aaaammdd', ancho: 8 },
      { nombre: 'Valor total', fuente: 'total.valor', formato: 'valor_centavos', ancho: 18, alineacion: 'derecha', relleno: '0' },
      { nombre: 'Tipo cuenta', fuente: 'empresa.tipoCuentaCodigo', ancho: 2 },
      { nombre: 'Cuenta', fuente: 'empresa.cuenta', ancho: 17, alineacion: 'derecha', relleno: '0' },
      { nombre: 'Nombre empresa', fuente: 'empresa.razonSocial', ancho: 40 },
      { nombre: 'NIT', fuente: 'empresa.nit', ancho: 11, alineacion: 'derecha', relleno: '0' },
      { nombre: 'Código transacción', literal: '021', ancho: 3 },
    ],
    detalle: [
      { nombre: 'Tipo registro', literal: '2', ancho: 1 },
      { nombre: 'Tipo documento', fuente: 'empleado.tipoDocumentoCodigo', ancho: 1 },
      { nombre: 'Documento', fuente: 'empleado.documento', ancho: 11, alineacion: 'derecha', relleno: '0' },
      { nombre: 'Nombre', fuente: 'empleado.nombre', ancho: 40 },
      { nombre: 'Tipo cuenta', fuente: 'empleado.tipoCuentaCodigo', ancho: 2 },
      { nombre: 'Cuenta', fuente: 'empleado.cuenta', ancho: 17, alineacion: 'derecha', relleno: '0' },
      { nombre: 'Valor', fuente: 'pago.valor', formato: 'valor_centavos', ancho: 18, alineacion: 'derecha', relleno: '0' },
      { nombre: 'Banco', fuente: 'empleado.codigoBanco', ancho: 3, alineacion: 'derecha', relleno: '0' },
    ],
  },
  {
    codigo: 'CSV_GENERICO',
    nombre: 'Archivo de pago genérico (CSV)',
    separador: ';',
    extension: 'csv',
    incluirTitulos: true,
    detalle: [
      { nombre: 'Documento', fuente: 'empleado.documento' },
      { nombre: 'Nombre', fuente: 'empleado.nombre' },
      { nombre: 'Banco', fuente: 'empleado.banco' },
      { nombre: 'Tipo de cuenta', fuente: 'empleado.tipoCuenta' },
      { nombre: 'Cuenta', fuente: 'empleado.cuenta' },
      { nombre: 'Valor', fuente: 'pago.valor', formato: 'valor' },
      { nombre: 'Fecha de pago', fuente: 'fechaPago', formato: 'fecha_iso' },
    ],
  },
];

const NOTA_CONTABLE =
  'Plantilla base de importación. Verifique el orden de columnas con la plantilla que exporta su programa contable y ajústela desde el panel.';

export const FORMATOS_CONTABLES: FormatoArchivo[] = [
  {
    codigo: 'CONTABLE_GENERICO',
    nombre: 'Comprobante contable genérico (CSV)',
    separador: ';',
    extension: 'csv',
    incluirTitulos: true,
    detalle: [
      { nombre: 'Fecha', fuente: 'fecha', formato: 'fecha_iso' },
      { nombre: 'Comprobante', fuente: 'comprobante' },
      { nombre: 'Cuenta', fuente: 'cuenta' },
      { nombre: 'NIT tercero', fuente: 'tercero.nit' },
      { nombre: 'Nombre tercero', fuente: 'tercero.nombre' },
      { nombre: 'Centro de costo', fuente: 'centroCosto' },
      { nombre: 'Descripción', fuente: 'descripcion' },
      { nombre: 'Débito', fuente: 'debito', formato: 'valor' },
      { nombre: 'Crédito', fuente: 'credito', formato: 'valor' },
    ],
  },
  {
    codigo: 'SIIGO',
    nombre: 'Siigo - importación de movimientos',
    separador: ',',
    extension: 'csv',
    incluirTitulos: true,
    nota: NOTA_CONTABLE,
    detalle: [
      { nombre: 'Tipo de comprobante', literal: 'NOMINA' },
      { nombre: 'Consecutivo', fuente: 'comprobante' },
      { nombre: 'Fecha de elaboración', fuente: 'fecha', formato: 'fecha_ddmmaaaa' },
      { nombre: 'Código cuenta contable', fuente: 'cuenta' },
      { nombre: 'Identificación tercero', fuente: 'tercero.nit' },
      { nombre: 'Centro de costo', fuente: 'centroCosto' },
      { nombre: 'Descripción', fuente: 'descripcion' },
      { nombre: 'Débito', fuente: 'debito', formato: 'valor' },
      { nombre: 'Crédito', fuente: 'credito', formato: 'valor' },
    ],
  },
  {
    codigo: 'WORLD_OFFICE',
    nombre: 'World Office - importación de movimientos',
    separador: ';',
    extension: 'csv',
    incluirTitulos: true,
    nota: NOTA_CONTABLE,
    detalle: [
      { nombre: 'Fecha', fuente: 'fecha', formato: 'fecha_ddmmaaaa' },
      { nombre: 'Documento', fuente: 'comprobante' },
      { nombre: 'Cuenta', fuente: 'cuenta' },
      { nombre: 'Tercero', fuente: 'tercero.nit' },
      { nombre: 'Nota', fuente: 'descripcion' },
      { nombre: 'Centro de costos', fuente: 'centroCosto' },
      { nombre: 'Débito', fuente: 'debito', formato: 'valor' },
      { nombre: 'Crédito', fuente: 'credito', formato: 'valor' },
    ],
  },
  {
    codigo: 'HELISA',
    nombre: 'Helisa - importación de movimientos',
    separador: '\t',
    extension: 'txt',
    nota: NOTA_CONTABLE,
    detalle: [
      { nombre: 'Cuenta', fuente: 'cuenta' },
      { nombre: 'Tercero', fuente: 'tercero.nit' },
      { nombre: 'Centro de costo', fuente: 'centroCosto' },
      { nombre: 'Fecha', fuente: 'fecha', formato: 'fecha_aaaammdd' },
      { nombre: 'Descripción', fuente: 'descripcion' },
      { nombre: 'Débito', fuente: 'debito', formato: 'valor' },
      { nombre: 'Crédito', fuente: 'credito', formato: 'valor' },
    ],
  },
];

export interface MovimientoContable {
  cuenta: string;
  tercero: { nit: string; nombre: string };
  centroCosto: string;
  descripcion: string;
  debito: string;
  credito: string;
}

export interface LineaParaContabilizar {
  concepto: string;
  nombre: string;
  tipo: 'devengo' | 'deduccion' | 'aporte_empleador' | 'provision';
  valor: Num;
  cuentaDebito?: string | null;
  cuentaCredito?: string | null;
  centroCosto: string;
  empleado: { nit: string; nombre: string };
  /** Tercero acreedor (EPS, fondo, DIAN...) para deducciones y aportes. */
  terceroCredito?: { nit: string; nombre: string };
}

/**
 * Genera los movimientos del comprobante de nómina: cada línea va al débito y crédito de su concepto.
 * Devuelve los conceptos sin cuenta para que el usuario los complete (HU-58).
 */
export function contabilizar(lineas: LineaParaContabilizar[]): { movimientos: MovimientoContable[]; sinCuenta: string[]; debitos: string; creditos: string } {
  const sinCuenta = new Set<string>();
  const agrupado = new Map<string, MovimientoContable & { d: ReturnType<typeof D>; c: ReturnType<typeof D> }>();
  const agregar = (cuenta: string, tercero: { nit: string; nombre: string }, cc: string, desc: string, debito: Num, credito: Num) => {
    const k = `${cuenta}|${tercero.nit}|${cc}|${desc}`;
    const m = agrupado.get(k) ?? { cuenta, tercero, centroCosto: cc, descripcion: desc, debito: '0', credito: '0', d: D(0), c: D(0) };
    m.d = m.d.plus(D(debito));
    m.c = m.c.plus(D(credito));
    agrupado.set(k, m);
  };
  for (const l of lineas) {
    if (D(l.valor).isZero()) continue;
    if (!l.cuentaDebito || !l.cuentaCredito) {
      sinCuenta.add(l.concepto);
      continue;
    }
    const tDeb = l.tipo === 'deduccion' ? l.empleado : l.tipo === 'devengo' ? l.empleado : l.empleado;
    const tCred = l.tipo === 'devengo' ? l.empleado : (l.terceroCredito ?? l.empleado);
    agregar(l.cuentaDebito, tDeb, l.centroCosto, l.nombre, l.valor, 0);
    agregar(l.cuentaCredito, tCred, l.centroCosto, l.nombre, 0, l.valor);
  }
  const movimientos = [...agrupado.values()].map(({ d, c, ...m }) => ({ ...m, debito: d.toFixed(2), credito: c.toFixed(2) }));
  const debitos = movimientos.reduce((a, m) => a.plus(D(m.debito)), D(0));
  const creditos = movimientos.reduce((a, m) => a.plus(D(m.credito)), D(0));
  return { movimientos, sinCuenta: [...sinCuenta], debitos: debitos.toFixed(2), creditos: creditos.toFixed(2) };
}
