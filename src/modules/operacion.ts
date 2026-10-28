import { AsistenciaController, AsistenciaService, PublicoAsistenciaController } from './asistencia/asistencia';
import { NominaController, NominaService, ProbarConceptoController } from './nomina/nomina';
import { PrestacionesController, PrestacionesService, RetirosController } from './nomina/prestaciones-retiros';
import { DescuentosController, NovedadesController, NovedadesService } from './novedades/novedades';
import {
  ContabilidadController,
  ContabilidadService,
  NotificacionesController,
  PagosController,
  PagosService,
  ReportesController,
  ReportesService,
} from './reportes/salidas';

/** Módulos de operación (asistencia, novedades, nómina, pagos, reportes). */
export const MODULOS_OPERACION = {
  controllers: [
    AsistenciaController,
    PublicoAsistenciaController,
    NovedadesController,
    DescuentosController,
    NominaController,
    ProbarConceptoController,
    PrestacionesController,
    RetirosController,
    PagosController,
    ContabilidadController,
    ReportesController,
    NotificacionesController,
  ],
  providers: [AsistenciaService, NovedadesService, NominaService, PrestacionesService, PagosService, ContabilidadService, ReportesService],
};
