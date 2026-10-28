import { z } from 'zod';
import { crearCrud } from '../../common/crud';
import { zFecha, zHora } from '../../common/util';

const zCalendario = z
  .object({
    diasLaborales: z.array(z.number().int().min(0).max(6)).min(1, 'Marque al menos un día laboral'),
    diaDescanso: z.number().int().min(0).max(6),
    sabadoHabilVacaciones: z.boolean(),
  })
  .partial()
  .nullable();

export const SedesController = crearCrud({
  ruta: 'sedes',
  tabla: 'sedes',
  entidad: 'sede',
  orden: 'nombre',
  columnaActivo: 'activa',
  esquema: z.object({
    nombre: z.string().trim().min(1, 'Escriba el nombre'),
    direccion: z.string().optional().nullable(),
    ciudad: z.string().optional().nullable(),
    claseRiesgo: z.number().int().min(1).max(5).optional(),
    calendario: zCalendario.optional(),
    activa: z.boolean().optional(),
  }),
  columnas: { nombre: 'nombre', direccion: 'direccion', ciudad: 'ciudad', claseRiesgo: 'clase_riesgo', calendario: 'calendario', activa: 'activa' },
});

export const CentrosCostoController = crearCrud({
  ruta: 'centros-costo',
  tabla: 'centros_costo',
  entidad: 'centro_costo',
  orden: 'codigo',
  columnaActivo: 'activo',
  esquema: z.object({ codigo: z.string().trim().min(1), nombre: z.string().trim().min(1), activo: z.boolean().optional() }),
  columnas: { codigo: 'codigo', nombre: 'nombre', activo: 'activo' },
});

export const AreasController = crearCrud({
  ruta: 'areas',
  tabla: 'areas',
  entidad: 'area',
  orden: 'nombre',
  columnaActivo: 'activa',
  esquema: z.object({ nombre: z.string().trim().min(1), calendario: zCalendario.optional(), activa: z.boolean().optional() }),
  columnas: { nombre: 'nombre', calendario: 'calendario', activa: 'activa' },
});

export const GruposPagoController = crearCrud({
  ruta: 'grupos-pago',
  tabla: 'grupos_pago',
  entidad: 'grupo_pago',
  orden: 'nombre',
  columnaActivo: 'activo',
  esquema: z.object({
    nombre: z.string().trim().min(1),
    periodicidad: z.enum(['mensual', 'quincenal', 'semanal']),
    diasPagoDespues: z.number().int().min(0).max(31).optional(),
    calendario: zCalendario.optional(),
    activo: z.boolean().optional(),
  }),
  columnas: { nombre: 'nombre', periodicidad: 'periodicidad', diasPagoDespues: 'dias_pago_despues', calendario: 'calendario', activo: 'activo' },
});

export const EntidadesController = crearCrud({
  ruta: 'entidades',
  tabla: 'entidades',
  entidad: 'entidad',
  orden: 'tipo, nombre',
  columnaActivo: 'activa',
  filtros: { tipo: 'tipo' },
  esquema: z.object({
    tipo: z.enum(['eps', 'afp', 'arl', 'ccf', 'cesantias', 'banco', 'dian', 'otra']),
    nombre: z.string().trim().min(1),
    nit: z.string().optional().nullable(),
    codigo: z.string().optional().nullable(),
    activa: z.boolean().optional(),
  }),
  columnas: { tipo: 'tipo', nombre: 'nombre', nit: 'nit', codigo: 'codigo', activa: 'activa' },
});

const zFranja = z.object({ inicio: zHora, fin: zHora });
export const TurnosController = crearCrud({
  ruta: 'turnos',
  tabla: 'turnos',
  entidad: 'turno',
  orden: 'nombre',
  columnaActivo: 'activo',
  esquema: z.object({
    nombre: z.string().trim().min(1),
    tipo: z.enum(['fijo', 'rotativo', 'flexible']).optional(),
    dias: z.record(z.string().regex(/^[0-6]$/), z.array(zFranja)),
    minimoHorasDia: z.number().min(0).max(24).optional().nullable(),
    maximoHorasDia: z.number().min(0).max(24).optional().nullable(),
    activo: z.boolean().optional(),
  }),
  columnas: { nombre: 'nombre', tipo: 'tipo', dias: 'dias', minimoHorasDia: 'minimo_horas_dia', maximoHorasDia: 'maximo_horas_dia', activo: 'activo' },
});

export const DiasEspecialesController = crearCrud({
  ruta: 'dias-especiales',
  tabla: 'dias_especiales',
  entidad: 'dia_especial',
  orden: 'fecha',
  esquema: z.object({
    fecha: zFecha,
    tipo: z.enum(['remunerado', 'compensado', 'no_laborado']),
    descripcion: z.string().trim().min(1),
    sedeId: z.string().uuid().optional().nullable(),
  }),
  columnas: { fecha: 'fecha', tipo: 'tipo', descripcion: 'descripcion', sedeId: 'sede_id' },
});

export const ESTRUCTURA_CONTROLLERS = [
  SedesController,
  CentrosCostoController,
  AreasController,
  GruposPagoController,
  EntidadesController,
  TurnosController,
  DiasEspecialesController,
];
