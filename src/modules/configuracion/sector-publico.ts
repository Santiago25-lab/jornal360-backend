import { Controller, Injectable, Post } from '@nestjs/common';
import { AuditoriaService } from '../../common/auditoria.service';
import { Usuario, UsuarioSesion } from '../../common/comun';
import { Db } from '../../db/db.service';
import { ConceptosService, ParametrosService } from './configuracion';

/**
 * Ajustes para entidades públicas territoriales (alcaldías, gobernaciones): primas y bonificaciones
 * de los Decretos 1042 y 1045 de 1978 como provisiones, sin tocar el motor. Se puede aplicar varias veces.
 * Los topes que cambian cada año vienen con un valor de ejemplo y hay que confirmarlos con el decreto salarial.
 */

const DESDE = '2026-01-01';

const PARAMETROS = [
  { codigo: 'PCT_PROV_PRIMA_NAVIDAD', nombre: 'Provisión mensual de prima de navidad', tipo: 'porcentaje', valor: '0.0833333333', descripcion: 'Un mes de salario por año (Decreto 1045 de 1978 art. 32).' },
  { codigo: 'PCT_PROV_PRIMA_VACACIONES', nombre: 'Provisión mensual de prima de vacaciones', tipo: 'porcentaje', valor: '0.0416666667', descripcion: '15 días de salario por año de servicio (Decreto 1045 de 1978 art. 24).' },
  { codigo: 'PCT_BONIF_SERVICIOS_BAJO', nombre: 'Bonificación por servicios prestados (hasta el tope)', tipo: 'porcentaje', valor: '0.5', descripcion: '50 % de la asignación básica por año, para quien gana hasta el tope (Decreto 2418 de 2015).' },
  { codigo: 'PCT_BONIF_SERVICIOS_ALTO', nombre: 'Bonificación por servicios prestados (sobre el tope)', tipo: 'porcentaje', valor: '0.35', descripcion: '35 % de la asignación básica por año, para quien gana más del tope (Decreto 2418 de 2015).' },
  { codigo: 'TOPE_BONIF_SERVICIOS', nombre: 'Tope de la bonificación por servicios prestados', tipo: 'dinero', valor: '2100000', descripcion: 'VALOR DE EJEMPLO: confirme el tope con el decreto salarial del año.' },
  { codigo: 'DIAS_BONIF_RECREACION', nombre: 'Días de bonificación especial de recreación', tipo: 'dias', valor: '2', descripcion: 'Dos días de asignación básica por cada periodo de vacaciones (decreto salarial anual).' },
  { codigo: 'TOPE_SUBSIDIO_ALIMENTACION', nombre: 'Tope de salario para el subsidio de alimentación', tipo: 'dinero', valor: '2100000', descripcion: 'VALOR DE EJEMPLO: confirme el tope con el decreto salarial del año.' },
  { codigo: 'VALOR_SUBSIDIO_ALIMENTACION', nombre: 'Valor mensual del subsidio de alimentación', tipo: 'dinero', valor: '75000', descripcion: 'VALOR DE EJEMPLO: confirme el valor con el decreto salarial del año.' },
] as const;

const provision = { tipo: 'provision' as const, salarial: false, baseIbc: false, baseArl: false, baseParafiscales: false, basePrestaciones: false, baseVacaciones: false, baseRetencion: false, cuenta40: false, redondeo: 'peso' as const, aplicaA: 'todos' as const };

const CONCEPTOS = [
  { codigo: 'PROV_PRIMA_NAVIDAD', nombre: 'Provisión de prima de navidad', formula: 'SUELDO_PROPORCIONAL * PCT_PROV_PRIMA_NAVIDAD', orden: 304, baseLegal: 'Decreto 1045 de 1978 art. 32', estado: 'activo' as const, ...provision },
  { codigo: 'PROV_PRIMA_VACACIONES', nombre: 'Provisión de prima de vacaciones', formula: 'SUELDO_PROPORCIONAL * PCT_PROV_PRIMA_VACACIONES', orden: 305, baseLegal: 'Decreto 1045 de 1978 art. 24', estado: 'activo' as const, ...provision },
  {
    codigo: 'PROV_BONIF_SERVICIOS',
    nombre: 'Provisión de bonificación por servicios prestados',
    formula: 'SUELDO_PROPORCIONAL * SI(SALARIO <= TOPE_BONIF_SERVICIOS; PCT_BONIF_SERVICIOS_BAJO; PCT_BONIF_SERVICIOS_ALTO) / 12',
    orden: 306,
    baseLegal: 'Decreto 2418 de 2015',
    estado: 'activo' as const,
    ...provision,
  },
  { codigo: 'PROV_BONIF_RECREACION', nombre: 'Provisión de bonificación especial de recreación', formula: 'SALARIO_DIARIO * DIAS_BONIF_RECREACION / 12 * DIAS_SALARIO / DIAS_MES', orden: 307, baseLegal: 'Decreto salarial anual', estado: 'activo' as const, ...provision },
  {
    codigo: 'SUBSIDIO_ALIMENTACION',
    nombre: 'Subsidio de alimentación',
    formula: 'SI(SALARIO <= TOPE_SUBSIDIO_ALIMENTACION; VALOR_SUBSIDIO_ALIMENTACION / DIAS_MES * DIAS_SALARIO; 0)',
    orden: 25,
    baseLegal: 'Decreto 1042 de 1978 art. 51; decreto salarial anual',
    // Queda en borrador hasta confirmar el tope y el valor del año.
    estado: 'borrador' as const,
    tipo: 'devengo' as const,
    salarial: false,
    baseIbc: false,
    baseArl: false,
    baseParafiscales: false,
    basePrestaciones: true,
    baseVacaciones: true,
    baseRetencion: true,
    cuenta40: false,
    redondeo: 'peso' as const,
    aplicaA: 'todos' as const,
  },
];

@Injectable()
export class SectorPublicoService {
  constructor(
    private readonly db: Db,
    private readonly parametros: ParametrosService,
    private readonly conceptos: ConceptosService,
    private readonly auditoria: AuditoriaService,
  ) {}

  async aplicar(u: UsuarioSesion) {
    const hecho: string[] = [];

    // Prima de servicios territorial: 15 días por año en lugar de 30 (Decreto 2351 de 2014).
    await this.parametros.guardarVigencia(u, 'PCT_PROV_PRIMA', { desde: DESDE, valor: '0.0416666667', confirmar: true });
    await this.conceptos.editar(u, 'PROV_PRIMA', { baseLegal: 'Decreto 2351 de 2014 (15 días por año)' });
    hecho.push('Prima de servicios: 15 días por año (4,17 %)');

    // Los afiliados al FNA reciben los intereses del propio Fondo, no de la entidad.
    await this.conceptos.editar(u, 'PROV_INTERESES', { formula: 'SI(CESANTIAS_FNA; 0; PROV_CESANTIAS * PCT_INTERESES_CESANTIAS)', baseLegal: 'Ley 52 de 1975; Ley 432 de 1998 (FNA)' });
    hecho.push('Intereses de cesantías: no se provisionan para afiliados al Fondo Nacional del Ahorro');

    for (const p of PARAMETROS) {
      const existe = await this.db.maybe('select 1 from parametros where empresa_id = $1 and codigo = $2', [u.empresaId, p.codigo]);
      if (!existe) await this.parametros.crear(u, { ...p, categoria: 'prestaciones', desde: DESDE });
    }
    hecho.push(`${PARAMETROS.length} parámetros del sector público (los topes son de ejemplo)`);

    for (const c of CONCEPTOS) {
      const existe = await this.db.maybe('select 1 from conceptos where empresa_id = $1 and codigo = $2', [u.empresaId, c.codigo]);
      if (!existe) await this.conceptos.crear(u, c);
      hecho.push(`${c.nombre}${c.estado === 'borrador' ? ' (en borrador hasta confirmar valores)' : ''}`);
    }

    await this.auditoria.registrar(u, 'aplicar_plantilla', 'configuracion', u.empresaId, null, { plantilla: 'sector_publico_territorial', hecho });
    return { ok: true, hecho };
  }
}

@Controller('empresa/sector-publico')
export class SectorPublicoController {
  constructor(private readonly s: SectorPublicoService) {}

  @Post()
  aplicar(@Usuario() u: UsuarioSesion) {
    return this.s.aplicar(u);
  }
}
